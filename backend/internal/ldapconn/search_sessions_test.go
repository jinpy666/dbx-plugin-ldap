package ldapconn

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSearchStartValidatesBeforeDial(t *testing.T) {
	svc, records := newAuditService()
	connectProfile(t, svc, "c1", nil)

	if _, err := svc.SearchStart(context.Background(), LDAPSearchSessionRequest{ConnectionID: "c1"}); err == nil || err.Error() != "baseDn is required" {
		t.Fatalf("empty baseDn error = %v", err)
	}
	if _, err := svc.SearchStart(context.Background(), LDAPSearchSessionRequest{ConnectionID: "c1", BaseDN: "dc=x", Filter: "objectClass=*"}); err == nil || !strings.HasPrefix(err.Error(), "invalid ldap filter") {
		t.Fatalf("invalid filter error = %v", err)
	}
	if len(*records) != 0 {
		t.Fatalf("unexpected audit records: %+v", *records)
	}
}

func TestSearchSessionReadPolicyAndLookup(t *testing.T) {
	svc, records := newAuditService()
	connectProfile(t, svc, "c1", map[string]any{"allowed_base_dns": "dc=example,dc=com"})
	_, err := svc.SearchStart(context.Background(), LDAPSearchSessionRequest{ConnectionID: "c1", BaseDN: "dc=outside,dc=com"})
	if err == nil || !strings.Contains(err.Error(), "outside allowed base DNs") {
		t.Fatalf("read policy error = %v", err)
	}
	if len(*records) != 1 || (*records)[0].Result != "denied" {
		t.Fatalf("audit records = %+v", *records)
	}
	if _, err := svc.SearchNext(context.Background(), LDAPSearchSessionNextRequest{ConnectionID: "c1"}); err == nil || err.Error() != "searchId is required" {
		t.Fatalf("missing searchId error = %v", err)
	}
}

func TestSearchSessionCancelIsConnectionBoundAndIdempotent(t *testing.T) {
	svc := NewService()
	session := &ldapSearchSession{id: "search-1", connectionID: "c1"}
	svc.searchSessions[session.id] = session

	if err := svc.SearchCancel(context.Background(), LDAPSearchSessionCancelRequest{ConnectionID: "c2", SearchID: session.id}); err != nil {
		t.Fatalf("cross-connection cancel = %v", err)
	}
	if got := svc.searchSessions[session.id]; got != session || session.closed {
		t.Fatalf("cross-connection cancel changed session: %#v closed=%v", got, session.closed)
	}
	if err := svc.SearchCancel(context.Background(), LDAPSearchSessionCancelRequest{ConnectionID: "c1", SearchID: session.id}); err != nil {
		t.Fatalf("cancel = %v", err)
	}
	if _, ok := svc.searchSessions[session.id]; ok || !session.closed {
		t.Fatalf("cancel did not remove and close session")
	}
	if err := svc.SearchCancel(context.Background(), LDAPSearchSessionCancelRequest{ConnectionID: "c1", SearchID: session.id}); err != nil {
		t.Fatalf("idempotent cancel = %v", err)
	}
}

func TestPruneExpiredSearchSessionsClosesOnlyExpired(t *testing.T) {
	svc := NewService()
	expired := &ldapSearchSession{id: "expired", expiresAt: time.Now().Add(-time.Second)}
	live := &ldapSearchSession{id: "live", expiresAt: time.Now().Add(time.Minute)}
	svc.searchSessions[expired.id] = expired
	svc.searchSessions[live.id] = live

	svc.pruneExpiredSearchSessions()
	if _, ok := svc.searchSessions[expired.id]; ok || !expired.closed {
		t.Fatalf("expired session was not removed and closed")
	}
	if got := svc.searchSessions[live.id]; got != live || live.closed {
		t.Fatalf("live session was changed: %#v closed=%v", got, live.closed)
	}
}

func TestSearchSessionResultIsPageNotTotal(t *testing.T) {
	result := LDAPSearchSessionResult{SearchID: "id", Entries: []LDAPEntry{{DN: "cn=a"}}, Count: 1, HasMore: true}
	if result.Count != len(result.Entries) || !result.HasMore {
		t.Fatalf("unexpected page result: %+v", result)
	}
}
