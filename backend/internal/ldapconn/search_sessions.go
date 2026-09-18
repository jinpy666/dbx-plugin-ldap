package ldapconn

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	ldap "github.com/go-ldap/ldap/v3"

	"github.com/google/uuid"
)

// Search sessions intentionally have a modest lifetime and cap. A paging
// cookie keeps server-side state, so allowing abandoned cursors to accumulate
// would otherwise consume both server and sidecar connections indefinitely.
const (
	defaultSearchSessionPageSize = 50
	searchSessionTTL             = 2 * time.Minute
	maxSearchSessions            = 16
)

// ldapSearchSession owns one independently bound LDAP connection. RFC 2696
// does not permit its opaque cookie to be moved to another connection.
type ldapSearchSession struct {
	mu sync.Mutex

	id           string
	connectionID string
	profile      Profile
	conn         *ldap.Conn
	baseDN       string
	filter       string
	scope        int
	derefAliases int
	attributes   []string
	typesOnly    bool
	pageSize     uint32
	remaining    int // 0 means no client-side size limit
	cookie       []byte
	expiresAt    time.Time
	closed       bool
}

// SearchStart opens an isolated, short-lived RFC 2696 paging session and
// returns exactly its first page. Existing Search keeps its aggregate API for
// compatibility; callers that need a responsive first paint use this method.
func (s *Service) SearchStart(ctx context.Context, req LDAPSearchSessionRequest) (LDAPSearchSessionResult, error) {
	profile, baseDN, filter, attrs, err := s.validateSearchSessionRequest(req)
	if err != nil {
		return LDAPSearchSessionResult{}, err
	}

	pageSize := normalizeLDAPPageSize(req.PageSize)
	if pageSize == 0 {
		pageSize = defaultSearchSessionPageSize
	}
	if err := s.ensureSearchSessionCapacity(); err != nil {
		return LDAPSearchSessionResult{}, err
	}

	entry := s.lookup(req.ConnectionID)
	if entry == nil {
		return LDAPSearchSessionResult{}, errConnectionNotFound(req.ConnectionID)
	}
	// Snapshot the current connection settings, then dial a connection owned by
	// this cursor. Holding entry.mu only for the copy avoids blocking all normal
	// LDAP operations while the user pages through a large result set.
	entry.mu.Lock()
	secrets := entry.secrets
	target := entry.target
	entry.mu.Unlock()
	requestCtx, cancel := contextWithTimeout(ctx, profile)
	defer cancel()
	conn, err := dialProfile(requestCtx, profile, target, secrets)
	if err != nil {
		return LDAPSearchSessionResult{}, err
	}

	session := &ldapSearchSession{
		id:           uuid.NewString(),
		connectionID: strings.TrimSpace(req.ConnectionID),
		profile:      profile,
		conn:         conn,
		baseDN:       baseDN,
		filter:       filter,
		scope:        ldapSearchScope(req.Scope),
		derefAliases: ldapDerefAliases(req.DerefAliases),
		attributes:   attrs,
		typesOnly:    req.TypesOnly,
		pageSize:     pageSize,
		remaining:    normalizeLDAPSizeLimit(req.SizeLimit),
	}

	// Do not install a cursor if a concurrent reconnect/disconnect replaced the
	// connection configuration while this dedicated connection was being dialed.
	if err := s.addSearchSession(entry, session); err != nil {
		_ = conn.Close()
		return LDAPSearchSessionResult{}, err
	}
	result, err := s.nextSearchSession(ctx, session)
	if err != nil {
		s.removeAndCloseSearchSession(session.id, session)
		return LDAPSearchSessionResult{}, err
	}
	if !result.HasMore {
		s.removeAndCloseSearchSession(session.id, session)
	}
	return result, nil
}

// SearchNext returns the next server page without repeating the LDAP search.
func (s *Service) SearchNext(ctx context.Context, req LDAPSearchSessionNextRequest) (LDAPSearchSessionResult, error) {
	session, err := s.findSearchSession(req.ConnectionID, req.SearchID)
	if err != nil {
		return LDAPSearchSessionResult{}, err
	}
	result, err := s.nextSearchSession(ctx, session)
	if err != nil {
		s.removeAndCloseSearchSession(session.id, session)
		return LDAPSearchSessionResult{}, err
	}
	if !result.HasMore {
		s.removeAndCloseSearchSession(session.id, session)
	}
	return result, nil
}

// SearchCancel explicitly stops a cursor. It is idempotent so UI cleanup may
// safely call it after a final page auto-releases the cursor.
func (s *Service) SearchCancel(_ context.Context, req LDAPSearchSessionCancelRequest) error {
	connectionID := strings.TrimSpace(req.ConnectionID)
	searchID := strings.TrimSpace(req.SearchID)
	if searchID == "" {
		return fmt.Errorf("searchId is required")
	}
	s.searchSessionsMu.Lock()
	session := s.searchSessions[searchID]
	if session != nil && session.connectionID == connectionID {
		delete(s.searchSessions, searchID)
	} else {
		session = nil
	}
	s.searchSessionsMu.Unlock()
	if session != nil {
		session.close()
	}
	return nil
}

func (s *Service) validateSearchSessionRequest(req LDAPSearchSessionRequest) (Profile, string, string, []string, error) {
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return Profile{}, "", "", nil, err
	}
	baseDN := strings.TrimSpace(req.BaseDN)
	if baseDN == "" {
		baseDN = profile.BaseDN
	}
	if baseDN == "" {
		return Profile{}, "", "", nil, fmt.Errorf("baseDn is required")
	}
	filter := strings.TrimSpace(req.Filter)
	if filter == "" {
		filter = "(objectClass=*)"
	}
	if err := validateLDAPFilter(filter); err != nil {
		return Profile{}, "", "", nil, err
	}
	if err := ensureLDAPReadAllowed(profile, baseDN); err != nil {
		s.EmitAudit(AuditRecord{ConnectionID: req.ConnectionID, Action: "read-policy", Target: baseDN, Result: "denied", Detail: err.Error()})
		return Profile{}, "", "", nil, err
	}
	return profile, baseDN, filter, sanitizeLDAPAttributes(profile, normalizeLDAPAttributes(req.Attributes)), nil
}

func (s *Service) ensureSearchSessionCapacity() error {
	s.pruneExpiredSearchSessions()
	s.searchSessionsMu.Lock()
	count := len(s.searchSessions)
	s.searchSessionsMu.Unlock()
	if count >= maxSearchSessions {
		return fmt.Errorf("too many active LDAP search sessions (maximum %d); cancel or wait for an existing search to expire", maxSearchSessions)
	}
	return nil
}

func (s *Service) addSearchSession(entry *connEntry, session *ldapSearchSession) error {
	// See SearchStart: re-check identity at installation to avoid retaining a
	// cursor made against a profile just replaced by connection/connect.
	s.mu.Lock()
	current := s.conns[session.connectionID]
	s.mu.Unlock()
	if current != entry {
		return fmt.Errorf("connection %q changed while starting search; start a new search", session.connectionID)
	}
	s.searchSessionsMu.Lock()
	defer s.searchSessionsMu.Unlock()
	if len(s.searchSessions) >= maxSearchSessions {
		return fmt.Errorf("too many active LDAP search sessions (maximum %d); cancel or wait for an existing search to expire", maxSearchSessions)
	}
	s.searchSessions[session.id] = session
	return nil
}

func (s *Service) findSearchSession(connectionID, searchID string) (*ldapSearchSession, error) {
	s.pruneExpiredSearchSessions()
	connectionID = strings.TrimSpace(connectionID)
	searchID = strings.TrimSpace(searchID)
	if searchID == "" {
		return nil, fmt.Errorf("searchId is required")
	}
	s.searchSessionsMu.Lock()
	session := s.searchSessions[searchID]
	s.searchSessionsMu.Unlock()
	if session == nil || session.connectionID != connectionID {
		return nil, fmt.Errorf("unknown or expired searchId; start a new search")
	}
	return session, nil
}

func (s *Service) nextSearchSession(ctx context.Context, session *ldapSearchSession) (LDAPSearchSessionResult, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return LDAPSearchSessionResult{}, fmt.Errorf("search session is closed")
	}
	if time.Now().After(session.expiresAt) && !session.expiresAt.IsZero() {
		return LDAPSearchSessionResult{}, fmt.Errorf("search session expired; start a new search")
	}

	requestCtx, cancel := contextWithTimeout(ctx, session.profile)
	defer cancel()
	if err := requestCtx.Err(); err != nil {
		return LDAPSearchSessionResult{}, err
	}
	session.conn.SetTimeout(time.Duration(session.profile.TimeoutSeconds) * time.Second)
	paging := ldap.NewControlPaging(session.pageSize)
	paging.SetCookie(session.cookie)
	request := ldap.NewSearchRequest(session.baseDN, session.scope, session.derefAliases, 0, 0, session.typesOnly, session.filter, session.attributes, []ldap.Control{paging})
	ldapResult, err := session.conn.Search(request)
	if err != nil {
		return LDAPSearchSessionResult{}, err
	}

	entries := ldapEntriesToTypes(ldapResult.Entries, s.ldapBinaryValuePredicate(session.connectionID))
	for i := range entries {
		entries[i] = filterLDAPEntryBlockedAttributes(session.profile, entries[i])
	}
	truncated := false
	if session.remaining > 0 {
		if len(entries) >= session.remaining {
			entries = entries[:session.remaining]
			truncated = true
			session.remaining = 0
		} else {
			session.remaining -= len(entries)
		}
	}

	var nextCookie []byte
	if control, ok := ldap.FindControl(ldapResult.Controls, ldap.ControlTypePaging).(*ldap.ControlPaging); ok && control != nil {
		nextCookie = append([]byte(nil), control.Cookie...)
	}
	session.cookie = nextCookie
	hasMore := len(nextCookie) > 0 && !truncated
	session.expiresAt = time.Now().Add(searchSessionTTL)
	response := LDAPSearchSessionResult{
		SearchID:  session.id,
		Entries:   entries,
		Count:     len(entries),
		HasMore:   hasMore,
		Truncated: truncated,
		BaseDN:    session.baseDN,
		Filter:    session.filter,
	}
	return response, nil
}

func (s *Service) pruneExpiredSearchSessions() {
	now := time.Now()
	var expired []*ldapSearchSession
	s.searchSessionsMu.Lock()
	for id, session := range s.searchSessions {
		session.mu.Lock()
		isExpired := !session.expiresAt.IsZero() && !now.Before(session.expiresAt)
		session.mu.Unlock()
		if isExpired {
			delete(s.searchSessions, id)
			expired = append(expired, session)
		}
	}
	s.searchSessionsMu.Unlock()
	for _, session := range expired {
		session.close()
	}
}

func (s *Service) removeAndCloseSearchSession(id string, expected *ldapSearchSession) {
	s.searchSessionsMu.Lock()
	session := s.searchSessions[id]
	if session == expected {
		delete(s.searchSessions, id)
	} else {
		session = nil
	}
	s.searchSessionsMu.Unlock()
	if session != nil {
		session.close()
	}
}

func (s *Service) cancelSearchSessionsForConnection(connectionID string) {
	var sessions []*ldapSearchSession
	s.searchSessionsMu.Lock()
	for id, session := range s.searchSessions {
		if session.connectionID == connectionID {
			delete(s.searchSessions, id)
			sessions = append(sessions, session)
		}
	}
	s.searchSessionsMu.Unlock()
	for _, session := range sessions {
		session.close()
	}
}

func (s *Service) cancelAllSearchSessions() {
	s.searchSessionsMu.Lock()
	sessions := make([]*ldapSearchSession, 0, len(s.searchSessions))
	for id, session := range s.searchSessions {
		delete(s.searchSessions, id)
		sessions = append(sessions, session)
	}
	s.searchSessionsMu.Unlock()
	for _, session := range sessions {
		session.close()
	}
}

func (session *ldapSearchSession) close() {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return
	}
	session.closed = true
	// RFC 2696 cancellation uses paging size zero with the last cookie. Best
	// effort is intentional: closing the dedicated connection is still enough
	// to free resources when the server rejects cancellation or is unreachable.
	if session.conn != nil && len(session.cookie) > 0 {
		cancelPaging := ldap.NewControlPaging(0)
		cancelPaging.SetCookie(session.cookie)
		request := ldap.NewSearchRequest(session.baseDN, session.scope, session.derefAliases, 0, 0, session.typesOnly, session.filter, session.attributes, []ldap.Control{cancelPaging})
		_, _ = session.conn.Search(request)
	}
	if session.conn != nil {
		_ = session.conn.Close()
		session.conn = nil
	}
}
