// operations.go（L-B 路实现；签名契约来自 L-A 占位清单，保持不变）。
//
// ldap/* 领域方法（实施文档 §5.2 方法表全量），tiny-rdm
// backend/services/ldap_service.go :356-744 操作语义移植：
//   - 连接获取一律走 s.WithConn(ctx, req.ConnectionID, fn)（未知
//     connectionId 由 service.go 返回 errConnectionNotFound，main 转 -32000）；
//   - 安全策略（§6）：读过 ensureLDAPReadAllowed，写过 ensureLDAPWriteAllowed
//     （read_only × 写白名单 × 屏蔽属性），写值过 normalizeLDAPWriteValues；
//   - 审计（占位契约）：写操作成功 result:"ok"；策略拒绝 result:"denied"；
//     执行失败 result:"error"。target 只记 DN，不记属性值。
package ldapconn

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	ldap "github.com/go-ldap/ldap/v3"

	"github.com/google/uuid"
)

// defaultSearchAggregateLimit 分页聚合上限（实施文档 §10：sizeLimit 缺省 500）。
const defaultSearchAggregateLimit = 500

// maxSubtreeDeleteEntries 子树递归删除条目上限（N1 防误删：先清点后删除，
// 超限一律报错不删）。
const maxSubtreeDeleteEntries = 1000

// controlTypeSubtreeDelete MS Tree Delete 控件 OID
// （draft-armijo-ldap-treedelete / MS AD、部分服务端实现；无控件值）。
const controlTypeSubtreeDelete = "1.2.840.113556.1.4.805"

// LDAPSearchPreset 搜索预设（契约 §5.2 ldap/presets/*；存 store presets.json，
// 明文、不含凭据）。
type LDAPSearchPreset struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	BaseDN     string   `json:"baseDn,omitempty"`
	Filter     string   `json:"filter,omitempty"`
	Scope      string   `json:"scope,omitempty"` // base | one | sub
	Attributes []string `json:"attributes,omitempty"`
	SizeLimit  int      `json:"sizeLimit,omitempty"`
	// Group 预设分组名（F11，可选；旧预设/旧 sidecar 缺省 = 未分组）。
	Group string `json:"group,omitempty"`
}

// PresetStore 是预设持久化接口（main.go 注入 store-backed 实现；
// Service.Presets 为 nil 时 ldap/presets/* 返回业务错误）。
type PresetStore interface {
	LoadPresets() ([]LDAPSearchPreset, error)
	SavePresets(presets []LDAPSearchPreset) error
}

// writeAuditRecord 组装写路径审计记录（F10：统一携带 operation 操作名与
// durationMs 执行耗时毫秒；start 由调用方在方法入口 time.Now() 取得）。
// target 只记 DN，detail/source 不含属性值与凭据。
func writeAuditRecord(connectionID, action, target, result, detail, source, operation string, start time.Time) AuditRecord {
	return AuditRecord{
		ConnectionID: connectionID,
		Action:       action,
		Target:       target,
		Result:       result,
		Detail:       detail,
		Source:       source,
		Operation:    operation,
		DurationMs:   time.Since(start).Milliseconds(),
	}
}

// Search 实现 ldap/search（tiny-rdm Search :356）。
//
// baseDn 缺省 profile.BaseDN（再空报错）；filter RFC 4515 校验（空缺省
// (objectClass=*)）；scope ∈ base|one|sub（缺省 sub）；sizeLimit 传服务器
// 字段保持 tiny-rdm 原样（normalizeLDAPSizeLimit），客户端聚合上限缺省
// 500；pageSize > 0 走 paged search 聚合，达聚合上限截断并置 truncated；
// 请求 attributes 先 sanitizeLDAPAttributes 剔除屏蔽属性；读白名单拒绝时
// EmitAudit action:"read-policy"/result:"denied"；返回条目剔除屏蔽属性。
// K-5：搜索（聚合上限 5000，子树导出复用）是聚合型大读，整体改走独立
// 短连接（withDedicatedConn，聚合完成即关），长搜索不再占用共享连接互斥
// 区堵死交互读写；门禁与审计仍在取连接之前执行，语义不变。
func (s *Service) Search(ctx context.Context, req LDAPSearchRequest) (LDAPSearchResult, error) {
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return LDAPSearchResult{}, err
	}

	baseDN := strings.TrimSpace(req.BaseDN)
	if baseDN == "" {
		baseDN = profile.BaseDN
	}
	if baseDN == "" {
		return LDAPSearchResult{}, fmt.Errorf("baseDn is required")
	}
	filter := strings.TrimSpace(req.Filter)
	if filter == "" {
		filter = "(objectClass=*)"
	}
	if err := validateLDAPFilter(filter); err != nil {
		return LDAPSearchResult{}, err
	}
	if err := ensureLDAPReadAllowed(profile, baseDN); err != nil {
		s.EmitAudit(AuditRecord{ConnectionID: req.ConnectionID, Action: "read-policy", Target: baseDN, Result: "denied", Detail: err.Error()})
		return LDAPSearchResult{}, err
	}

	// 请求属性：去重归一 + 屏蔽属性剔除（不主动拉取敏感列）。
	attrs := sanitizeLDAPAttributes(profile, normalizeLDAPAttributes(req.Attributes))

	var entries []LDAPEntry
	truncated := false
	// K-5：独立短连接执行（失败回退共享 WithConn，见 withDedicatedConn）。
	isBinaryValue := s.ldapBinaryValuePredicate(req.ConnectionID)
	err = s.withDedicatedConn(ctx, req.ConnectionID, func(conn *ldap.Conn) error {
		// AD 兼容（KN-LDAP 真实连接验证发现）：分页控件与 SizeLimit 同用、
		// 且匹配总数超过 SizeLimit 时，AD 直接返回 Size Limit Exceeded
		//（分页失效）。分页路径把上限交给客户端聚合（aggregateLimit），
		// LDAP 请求不携带 SizeLimit；非分页路径保持原语义。
		sizeLimitField := 0
		pageSize := normalizeLDAPPageSize(req.PageSize)
		if pageSize <= 0 {
			sizeLimitField = normalizeLDAPSizeLimit(req.SizeLimit)
		}
		searchReq := ldap.NewSearchRequest(
			baseDN,
			ldapSearchScope(req.Scope),
			ldapDerefAliases(req.DerefAliases),
			sizeLimitField,
			0,
			req.TypesOnly,
			filter,
			attrs,
			nil,
		)
		if pageSize > 0 {
			var result []*ldap.Entry
			var searchErr error
			result, truncated, searchErr = pagedSearchEntries(conn, searchReq, pageSize, aggregateLimit(req.SizeLimit))
			if searchErr != nil {
				return searchErr
			}
			entries = ldapEntriesToTypes(result, isBinaryValue)
			return nil
		}
		result, searchErr := conn.Search(searchReq)
		if searchErr != nil {
			return searchErr
		}
		entries = ldapEntriesToTypes(result.Entries, isBinaryValue)
		return nil
	})
	if err != nil {
		return LDAPSearchResult{}, err
	}
	for i := range entries {
		entries[i] = filterLDAPEntryBlockedAttributes(profile, entries[i])
	}
	return LDAPSearchResult{
		Entries:   entries,
		Count:     len(entries),
		Truncated: truncated,
		BaseDN:    baseDN,
		Filter:    filter,
	}, nil
}

// Count 实现 ldap/count（A-LDAP 遗留：树徽章精确计数）。scope 固定 one，
// 请求 ["1.1"]（no attributes）+ typesOnly 最小化负载；计数上限 5000，
// 达到上限以 truncated 标记。复用读白名单与 filter 校验，拒绝发审计。
// K-5：计数（上限 5000）属聚合型大读，走独立短连接（withDedicatedConn，
// 失败回退共享 WithConn），长计数不再占用共享连接互斥区。
func (s *Service) Count(ctx context.Context, req LDAPCountRequest) (LDAPCountResult, error) {
	return s.count(ctx, req, true)
}

// count 是 Count/ChildrenCount 的共用实现（K-5）。dedicated=true 走独立短
// 连接（ldap/count 聚合大读），false 保持共享连接 + WithConn（childrenCount
// 交互读，K-5 要求其排队语义不变）。两种形态的门禁、审计、limit、truncated
// 语义完全一致，仅取连接方式不同。
func (s *Service) count(ctx context.Context, req LDAPCountRequest, dedicated bool) (LDAPCountResult, error) {
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return LDAPCountResult{}, err
	}
	baseDN := strings.TrimSpace(req.BaseDN)
	if baseDN == "" {
		baseDN = profile.BaseDN
	}
	if baseDN == "" {
		return LDAPCountResult{}, fmt.Errorf("baseDn is required")
	}
	filter := strings.TrimSpace(req.Filter)
	if filter == "" {
		filter = "(objectClass=*)"
	}
	if err := validateLDAPFilter(filter); err != nil {
		return LDAPCountResult{}, err
	}
	if err := ensureLDAPReadAllowed(profile, baseDN); err != nil {
		s.EmitAudit(AuditRecord{ConnectionID: req.ConnectionID, Action: "read-policy", Target: baseDN, Result: "denied", Detail: err.Error()})
		return LDAPCountResult{}, err
	}

	const countLimit = 5000
	var count int
	var truncated bool
	countOnConn := func(conn *ldap.Conn) error {
		searchReq := ldap.NewSearchRequest(
			baseDN,
			ldap.ScopeSingleLevel,
			ldap.NeverDerefAliases,
			countLimit+1, // 服务端侧截断保护；+1 用于判定 truncated
			0,
			true, // typesOnly：不取属性值
			filter,
			[]string{"1.1"}, // no attributes
			nil,
		)
		result, searchErr := conn.Search(searchReq)
		if searchErr != nil {
			return searchErr
		}
		if len(result.Entries) > countLimit {
			count = countLimit
			truncated = true
			return nil
		}
		count = len(result.Entries)
		return nil
	}
	// K-5：dedicated=true（ldap/count 聚合大读）走独立短连接；false
	// （childrenCount 交互读）保持共享连接 + WithConn，排队语义不变。
	if dedicated {
		err = s.withDedicatedConn(ctx, req.ConnectionID, countOnConn)
	} else {
		err = s.WithConn(ctx, req.ConnectionID, countOnConn)
	}
	if err != nil {
		return LDAPCountResult{}, err
	}
	return LDAPCountResult{Count: count, Truncated: truncated}, nil
}

// GetEntry 实现 ldap/entry/get（tiny-rdm GetEntry :426）。
// attributes 经 sanitizeLDAPAttributes 过滤后再下发；读白名单拒绝发审计；
// 结果条目再过 filterLDAPEntryBlockedAttributes。
func (s *Service) GetEntry(ctx context.Context, req LDAPGetEntryRequest) (LDAPEntry, error) {
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return LDAPEntry{}, err
	}
	dn := strings.TrimSpace(req.DN)
	if dn == "" {
		return LDAPEntry{}, fmt.Errorf("dn is required")
	}
	if err := ensureLDAPReadAllowed(profile, dn); err != nil {
		s.EmitAudit(AuditRecord{ConnectionID: req.ConnectionID, Action: "read-policy", Target: dn, Result: "denied", Detail: err.Error()})
		return LDAPEntry{}, err
	}
	attrs := sanitizeLDAPAttributes(profile, normalizeLDAPAttributes(req.Attributes))
	entry, err := s.readEntry(ctx, req.ConnectionID, dn, attrs, req.TypesOnly)
	if err != nil {
		return LDAPEntry{}, err
	}
	return filterLDAPEntryBlockedAttributes(profile, entry), nil
}

// RootDSE 实现 ldap/rootDSE（tiny-rdm RootDSE :452）。
// AllowedBaseDNs 非空时 rootDSEAllowed 沿袭拒绝；实现 = readEntry(dn="")，
// 返回 LDAPEntry.DN 为空、Attributes 为 RootDSE 属性（屏蔽属性过滤后）。
func (s *Service) RootDSE(ctx context.Context, req LDAPRootDSERequest) (LDAPEntry, error) {
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return LDAPEntry{}, err
	}
	if err := rootDSEAllowed(profile); err != nil {
		return LDAPEntry{}, err
	}
	entry, err := s.readEntry(ctx, req.ConnectionID, "", sanitizeLDAPAttributes(profile, normalizeLDAPAttributes(req.Attributes)), false)
	if err != nil {
		return LDAPEntry{}, err
	}
	return filterLDAPEntryBlockedAttributes(profile, entry), nil
}

// SchemaMetadata 实现 ldap/schema（tiny-rdm GetSchemaMetadata :472）。
// refresh=true 跳缓存；否则走 s.SchemaCache。流程：rootDSE(subschemaSubentry)
// → schemaDN 白名单校验 → subschema 条目 → ResolveSchema（解析 + 策略过滤）。
func (s *Service) SchemaMetadata(ctx context.Context, req LDAPSchemaMetadataRequest) (LDAPSchemaMetadata, error) {
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return LDAPSchemaMetadata{}, err
	}
	if !req.Refresh {
		if cached := s.schemaCache().Get(req.ConnectionID); cached != nil {
			return *cached, nil
		}
	}
	if err := schemaAllowed(profile); err != nil {
		return LDAPSchemaMetadata{}, err
	}
	spec := DefaultSchemaSearchSpec()
	rootDSE, err := s.readEntry(ctx, req.ConnectionID, "", spec.RootDSEAttrs, false)
	if err != nil {
		return LDAPSchemaMetadata{}, err
	}
	schemaDN, err := subschemaDNFromRootDSE(rootDSE)
	if err != nil {
		return LDAPSchemaMetadata{}, err
	}
	if err := ensureLDAPReadAllowed(profile, schemaDN); err != nil {
		return LDAPSchemaMetadata{}, err
	}
	schemaEntry, err := s.readEntry(ctx, req.ConnectionID, schemaDN, spec.SubschemaAttrs, false)
	if err != nil {
		return LDAPSchemaMetadata{}, err
	}
	metadata := parseLDAPSchemaMetadata(schemaDN, schemaEntry)
	metadata = filterLDAPSchemaMetadataForProfile(profile, metadata)
	applyLDAPDialectMetadata(&metadata, rootDSE)
	s.schemaCache().Put(req.ConnectionID, metadata)
	return metadata, nil
}

// AddEntry 实现 ldap/entry/add（tiny-rdm AddEntry :508）：
// normalizeLDAPWriteDN → normalizeLDAPAddAttributes（含值校验）→
// ensureLDAPWriteAllowed → WithConn(conn.Add)。审计 action:"add-entry"。
func (s *Service) AddEntry(ctx context.Context, req LDAPAddEntryRequest) error {
	start := time.Now()
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return err
	}
	dn, err := normalizeLDAPWriteDN(req.DN)
	if err != nil {
		return err
	}
	attrs, attrNames, err := normalizeLDAPAddAttributes(req.Attributes)
	if err != nil {
		return err
	}
	if err := ensureLDAPWriteAllowed(profile, dn, attrNames); err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "write-policy", dn, "denied", err.Error(), "", "add", start))
		return err
	}
	err = s.WithConn(ctx, req.ConnectionID, func(conn *ldap.Conn) error {
		// 二进制语法属性值是前端 base64 上传的（见「二进制值协议传输」），
		// 写入前解码回原始字节。
		isBinaryValue := s.ldapBinaryValuePredicate(req.ConnectionID)
		addReq := ldap.NewAddRequest(dn, nil)
		for attr, values := range attrs {
			if isBinaryValue(attr) {
				values = decodeBinaryProtocolValues(values)
			}
			addReq.Attribute(attr, values)
		}
		return conn.Add(addReq)
	})
	if err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "add-entry", dn, "error", err.Error(), req.Source, "add", start))
		return err
	}
	s.EmitAudit(writeAuditRecord(req.ConnectionID, "add-entry", dn, "ok", "attributes: "+strings.Join(attrNames, ","), req.Source, "add", start))
	return nil
}

// ModifyEntry 实现 ldap/entry/modify（tiny-rdm ModifyEntry :553）：
// 屏蔽属性在 ensureLDAPWriteAllowed 内拒绝修改；逐条 add/replace/delete。
// 审计 action:"modify-entry"。
func (s *Service) ModifyEntry(ctx context.Context, req LDAPModifyEntryRequest) error {
	start := time.Now()
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return err
	}
	dn, err := normalizeLDAPWriteDN(req.DN)
	if err != nil {
		return err
	}
	changes, attrs, err := normalizeLDAPModifyChanges(req.Changes)
	if err != nil {
		return err
	}
	if err := ensureLDAPWriteAllowed(profile, dn, attrs); err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "write-policy", dn, "denied", err.Error(), "", "modify", start))
		return err
	}
	err = s.WithConn(ctx, req.ConnectionID, func(conn *ldap.Conn) error {
		// 二进制语法属性值是前端 base64 上传的（见「二进制值协议传输」），
		// 写入前解码回原始字节。
		isBinaryValue := s.ldapBinaryValuePredicate(req.ConnectionID)
		modReq := ldap.NewModifyRequest(dn, nil)
		for _, change := range changes {
			values := change.Values
			if isBinaryValue(change.Attribute) {
				values = decodeBinaryProtocolValues(values)
			}
			switch change.Operation {
			case "add":
				modReq.Add(change.Attribute, values)
			case "replace":
				modReq.Replace(change.Attribute, values)
			case "delete":
				modReq.Delete(change.Attribute, values)
			}
		}
		return conn.Modify(modReq)
	})
	if err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "modify-entry", dn, "error", err.Error(), req.Source, "modify", start))
		return err
	}
	s.EmitAudit(writeAuditRecord(req.ConnectionID, "modify-entry", dn, "ok", "attributes: "+strings.Join(attrs, ","), req.Source, "modify", start))
	return nil
}

// DeleteEntry 实现 ldap/entry/delete（tiny-rdm DeleteEntry :606）。
// recursive=true 走 deleteSubtree（N1）：只需目标 DN 过写白名单（子条目 DN
// 隐式落在目标子树内，与 modifyDn 双端校验语义区分）。审计 action:"delete-entry"；
// recursive 成功/失败聚合为一条 action:"subtree_delete" 记录。
func (s *Service) DeleteEntry(ctx context.Context, req LDAPDeleteEntryRequest) error {
	start := time.Now()
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return err
	}
	dn, err := normalizeLDAPWriteDN(req.DN)
	if err != nil {
		return err
	}
	if err := ensureLDAPWriteAllowed(profile, dn, nil); err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "write-policy", dn, "denied", err.Error(), "", "delete", start))
		return err
	}
	if req.Recursive {
		return s.deleteSubtree(ctx, req.ConnectionID, dn, req.Source, start)
	}
	err = s.WithConn(ctx, req.ConnectionID, func(conn *ldap.Conn) error {
		return conn.Del(ldap.NewDelRequest(dn, nil))
	})
	if err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "delete-entry", dn, "error", err.Error(), req.Source, "delete", start))
		return err
	}
	s.EmitAudit(writeAuditRecord(req.ConnectionID, "delete-entry", dn, "ok", "", req.Source, "delete", start))
	return nil
}

// deleteSubtree 子树递归删除（N1）。流程：先 sub 搜索清点整棵子树 DN（含
// 目标自身，超上限 1000 直接报错不删）→ 优先挂 Tree Delete 控件单请求删除 →
// 服务端返回不支持类错误（unavailableCriticalExtension/unavailable/
// unwillingToPerform）时回退「先序自底向上」逐条删除（深度倒序，先子后父，
// 最后删目标自身）。两条路径均只发一条聚合审计记录。
func (s *Service) deleteSubtree(ctx context.Context, connectionID, dn, source string, start time.Time) error {
	var deletedCount int
	err := s.WithConn(ctx, connectionID, func(conn *ldap.Conn) error {
		dns, listErr := listSubtreeDNs(conn, dn)
		if listErr != nil {
			return listErr
		}
		treeErr := conn.Del(newSubtreeDeleteRequest(dn))
		if treeErr == nil {
			deletedCount = len(dns)
			return nil
		}
		if !isSubtreeDeleteUnsupported(treeErr) {
			return treeErr
		}
		// 回退：深度倒序逐条删除（先子后父；dns 已含目标自身，排最后）。
		ordered, orderErr := orderDeepestFirst(dns)
		if orderErr != nil {
			return orderErr
		}
		for _, entryDN := range ordered {
			if delErr := conn.Del(ldap.NewDelRequest(entryDN, nil)); delErr != nil {
				return delErr
			}
		}
		deletedCount = len(ordered)
		return nil
	})
	if err != nil {
		s.EmitAudit(writeAuditRecord(connectionID, "subtree_delete", dn, "error", err.Error(), source, "deleteSubtree", start))
		return err
	}
	rec := writeAuditRecord(connectionID, "subtree_delete", dn, "ok", "", source, "deleteSubtree", start)
	rec.DeletedCount = deletedCount
	s.EmitAudit(rec)
	return nil
}

// ChildrenCount 实现 ldap/entry/childrenCount（N1）：dn 下直接子条目计数，
// 语义与 ldap/count 同构（scope=one、(objectClass=*)、typesOnly、上限 5000
// 截断标记），复用读白名单门禁与拒绝审计（read-policy/denied）。
// K-5：树徽章属交互读，保持共享连接 + WithConn（count 的 dedicated=false
// 分支），不受聚合大读独立短连接改造影响。
func (s *Service) ChildrenCount(ctx context.Context, req LDAPChildrenCountRequest) (LDAPCountResult, error) {
	dn := strings.TrimSpace(req.DN)
	if dn == "" {
		return LDAPCountResult{}, fmt.Errorf("dn is required")
	}
	return s.count(ctx, LDAPCountRequest{ConnectionID: req.ConnectionID, BaseDN: dn}, false)
}

// newSubtreeDeleteRequest 挂 Tree Delete 控件（critical）的 Del 请求
// （go-ldap NewDelRequest 第二参即 Controls）。
func newSubtreeDeleteRequest(dn string) *ldap.DelRequest {
	return ldap.NewDelRequest(dn, []ldap.Control{&ldap.ControlString{
		ControlType: controlTypeSubtreeDelete,
		Criticality: true,
	}})
}

// listSubtreeDNs sub 搜索清点整棵子树 DN（含 dn 自身；(objectClass=*)、
// typesOnly、请求 ["1.1"] 最小化负载，风格对齐 Count）。超过
// maxSubtreeDeleteEntries 返回错误且不删除任何条目（防误删）。
func listSubtreeDNs(conn *ldap.Conn, dn string) ([]string, error) {
	result, err := conn.Search(newSubtreeListRequest(dn))
	if err != nil {
		// 服务端 sizeLimit 截断同样意味着子树超限。
		var ldapErr *ldap.Error
		if errors.As(err, &ldapErr) && ldapErr.ResultCode == ldap.LDAPResultSizeLimitExceeded {
			return nil, subtreeDeleteLimitError(dn)
		}
		return nil, err
	}
	if len(result.Entries) > maxSubtreeDeleteEntries {
		return nil, subtreeDeleteLimitError(dn)
	}
	dns := make([]string, 0, len(result.Entries))
	for _, entry := range result.Entries {
		dns = append(dns, entry.DN)
	}
	return dns, nil
}

// newSubtreeListRequest 子树清点搜索请求（SizeLimit = 上限+1 用于判定超限）。
func newSubtreeListRequest(dn string) *ldap.SearchRequest {
	return ldap.NewSearchRequest(
		dn,
		ldap.ScopeWholeSubtree,
		ldap.NeverDerefAliases,
		maxSubtreeDeleteEntries+1, // 服务端截断保护；+1 用于判定超限
		0,
		true, // typesOnly：不取属性值
		"(objectClass=*)",
		[]string{"1.1"}, // no attributes
		nil,
	)
}

// subtreeDeleteLimitError 子树条目超上限的统一错误面。
func subtreeDeleteLimitError(dn string) error {
	return fmt.Errorf("subtree %q exceeds the %d entry delete limit", dn, maxSubtreeDeleteEntries)
}

// isSubtreeDeleteUnsupported 判定服务端是否不支持 Tree Delete 控件：未知
// critical 控件的典型回码 unavailableCriticalExtension；部分实现回
// unavailable/unwillingToPerform。命中即回退逐条删除。
func isSubtreeDeleteUnsupported(err error) bool {
	var ldapErr *ldap.Error
	if !errors.As(err, &ldapErr) {
		return false
	}
	switch ldapErr.ResultCode {
	case ldap.LDAPResultUnavailableCriticalExtension, ldap.LDAPResultUnavailable, ldap.LDAPResultUnwillingToPerform:
		return true
	}
	return false
}

// orderDeepestFirst 按 DN 深度（RDN 数）倒序稳定排序（回退路径：先子后父）。
func orderDeepestFirst(dns []string) ([]string, error) {
	type node struct {
		dn    string
		depth int
	}
	nodes := make([]node, 0, len(dns))
	for _, value := range dns {
		parsed, err := ldap.ParseDN(value)
		if err != nil {
			return nil, fmt.Errorf("parse dn %q: %w", value, err)
		}
		nodes = append(nodes, node{dn: value, depth: len(parsed.RDNs)})
	}
	sort.SliceStable(nodes, func(i, j int) bool {
		return nodes[i].depth > nodes[j].depth
	})
	out := make([]string, 0, len(nodes))
	for _, item := range nodes {
		out = append(out, item.dn)
	}
	return out, nil
}

// subtreeDeleteAuditRecord 递归删除成功的聚合审计记录（一条；target 为目标
// DN，deletedCount 为删除条目数含目标自身；不含任何属性值）。
func subtreeDeleteAuditRecord(connectionID, dn string, deletedCount int, source, operation string, start time.Time) AuditRecord {
	rec := writeAuditRecord(connectionID, "subtree_delete", dn, "ok", "", source, operation, start)
	rec.DeletedCount = deletedCount
	return rec
}

// ModifyDN 实现 ldap/entry/modifyDn（tiny-rdm ModifyDN :641）：
// 新旧 DN 均过写白名单（目标 DN 先 ldapModifyDNDestinationDN 计算）。
// 审计 action:"modify-dn"。
func (s *Service) ModifyDN(ctx context.Context, req LDAPModifyDNRequest) error {
	start := time.Now()
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return err
	}
	dn, err := normalizeLDAPWriteDN(req.DN)
	if err != nil {
		return err
	}
	newRDN := strings.TrimSpace(req.NewRDN)
	if newRDN == "" {
		return fmt.Errorf("dn and newRdn are required")
	}
	if err := ensureLDAPWriteAllowed(profile, dn, nil); err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "write-policy", dn, "denied", err.Error(), "", "modifyDn", start))
		return err
	}
	destinationDN, err := ldapModifyDNDestinationDN(dn, newRDN, req.NewSuperior)
	if err != nil {
		return err
	}
	if err := ensureLDAPWriteAllowed(profile, destinationDN, nil); err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "write-policy", destinationDN, "denied", err.Error(), "", "modifyDn", start))
		return err
	}
	err = s.WithConn(ctx, req.ConnectionID, func(conn *ldap.Conn) error {
		return conn.ModifyDN(ldap.NewModifyDNRequest(dn, newRDN, req.DeleteOldRDN, strings.TrimSpace(req.NewSuperior)))
	})
	if err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "modify-dn", dn, "error", err.Error(), req.Source, "modifyDn", start))
		return err
	}
	s.EmitAudit(writeAuditRecord(req.ConnectionID, "modify-dn", dn, "ok", "destinationDn: "+destinationDN, req.Source, "modifyDn", start))
	return nil
}

// Compare 实现 ldap/entry/compare（RFC 4511 Compare，F3）：断言条目在指定
// 属性上持有指定值。读路径：目标 DN 过读白名单（拒绝发 read-policy 审计）；
// go-ldap 把 compareTrue/compareFalse 结果码折算为 bool/nil，其余错误原样
// 返回（main 层 bizError 自动补 [ldap-code=N] 前缀）。
func (s *Service) Compare(ctx context.Context, req LDAPCompareRequest) (LDAPCompareResult, error) {
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return LDAPCompareResult{}, err
	}
	dn := strings.TrimSpace(req.DN)
	if dn == "" {
		return LDAPCompareResult{}, fmt.Errorf("dn is required")
	}
	attribute := strings.TrimSpace(req.Attribute)
	if attribute == "" {
		return LDAPCompareResult{}, fmt.Errorf("attribute is required")
	}
	if err := ensureLDAPReadAllowed(profile, dn); err != nil {
		s.EmitAudit(AuditRecord{ConnectionID: req.ConnectionID, Action: "read-policy", Target: dn, Result: "denied", Detail: err.Error()})
		return LDAPCompareResult{}, err
	}
	var match bool
	err = s.WithConn(ctx, req.ConnectionID, func(conn *ldap.Conn) error {
		ok, cmpErr := conn.Compare(dn, attribute, req.Value)
		match = ok
		return cmpErr
	})
	if err != nil {
		return LDAPCompareResult{}, err
	}
	return LDAPCompareResult{Match: match}, nil
}

// WhoAmI 实现 ldap/whoami（RFC 4532 Who Am I? 扩展操作，F3）：返回服务器
// 认可的授权身份（go-ldap v3.4 为 Conn.WhoAmI(controls)，内部走
// NewExtendedRequest(ControlTypeWhoAmI)；无新增请求构造函数）。读路径、
// 无目标 DN，不经过白名单门禁（对齐 rootDSE/schema 等无定位读）。
func (s *Service) WhoAmI(ctx context.Context, req LDAPWhoAmIRequest) (LDAPWhoAmIResult, error) {
	if _, err := s.Get(req.ConnectionID); err != nil {
		return LDAPWhoAmIResult{}, err
	}
	var authzID string
	err := s.WithConn(ctx, req.ConnectionID, func(conn *ldap.Conn) error {
		result, whoErr := conn.WhoAmI(nil)
		if whoErr != nil {
			return whoErr
		}
		authzID = result.AuthzID
		return nil
	})
	if err != nil {
		return LDAPWhoAmIResult{}, err
	}
	return LDAPWhoAmIResult{AuthzID: authzID}, nil
}

// PasswordModify 实现 ldap/entry/passwdModify（RFC 3062 密码修改扩展操作，
// F3）。写路径门禁对齐 ModifyEntry：read_only 拒绝 + 目标 DN 写白名单。
// 目标 DN = identity 非空取 identity（按 DN 校验，dnWithinBase 语义一致），
// 否则 DN；identity 为空时 go-ldap NewPasswordModifyRequest 的 UserIdentity
// 作用于会话用户，与 DN 为空会话语义一致。审计 action:"passwd-modify"，
// target 只记 DN，密码值不落审计。
func (s *Service) PasswordModify(ctx context.Context, req LDAPPasswordModifyRequest) (LDAPPasswordModifyResult, error) {
	start := time.Now()
	profile, err := s.Get(req.ConnectionID)
	if err != nil {
		return LDAPPasswordModifyResult{}, err
	}
	dn, err := normalizeLDAPWriteDN(req.DN)
	if err != nil {
		return LDAPPasswordModifyResult{}, err
	}
	target := dn
	if identity := strings.TrimSpace(req.Identity); identity != "" {
		target, err = normalizeLDAPWriteDN(identity)
		if err != nil {
			return LDAPPasswordModifyResult{}, err
		}
	}
	if err := ensureLDAPWriteAllowed(profile, target, nil); err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "write-policy", target, "denied", err.Error(), "", "passwdModify", start))
		return LDAPPasswordModifyResult{}, err
	}
	err = s.WithConn(ctx, req.ConnectionID, func(conn *ldap.Conn) error {
		_, err := conn.PasswordModify(ldap.NewPasswordModifyRequest(target, req.OldPassword, req.NewPassword))
		return err
	})
	if err != nil {
		s.EmitAudit(writeAuditRecord(req.ConnectionID, "passwd-modify", target, "error", err.Error(), req.Source, "passwdModify", start))
		return LDAPPasswordModifyResult{}, err
	}
	s.EmitAudit(writeAuditRecord(req.ConnectionID, "passwd-modify", target, "ok", "", req.Source, "passwdModify", start))
	return LDAPPasswordModifyResult{Success: true}, nil
}

// ConnectionStatuses 实现 ldap/connections/statuses（tiny-rdm
// ConnectionStatuses :695）：全局视图，直接快照 service 连接表。
func (s *Service) ConnectionStatuses() ([]LDAPConnectionStatus, error) {
	return s.SnapshotStatuses(), nil
}

// ListPresets 实现 ldap/presets/list（预设明文存 presets.json，不含凭据）。
// Service.Presets 未注入时返回业务错误。
func (s *Service) ListPresets() ([]LDAPSearchPreset, error) {
	store := s.presetStore()
	if store == nil {
		return nil, fmt.Errorf("preset store is not available")
	}
	presets, err := store.LoadPresets()
	if err != nil {
		return nil, err
	}
	if presets == nil {
		presets = []LDAPSearchPreset{}
	}
	return presets, nil
}

// SavePreset 实现 ldap/presets/save：全量 upsert 单个预设（id 空时生成
// uuid，name 必填）。
func (s *Service) SavePreset(preset LDAPSearchPreset) (LDAPSearchPreset, error) {
	store := s.presetStore()
	if store == nil {
		return LDAPSearchPreset{}, fmt.Errorf("preset store is not available")
	}
	preset.ID = strings.TrimSpace(preset.ID)
	preset.Name = strings.TrimSpace(preset.Name)
	if preset.Name == "" {
		return LDAPSearchPreset{}, fmt.Errorf("preset name is required")
	}
	if preset.ID == "" {
		preset.ID = uuid.NewString()
	}
	presets, err := store.LoadPresets()
	if err != nil {
		return LDAPSearchPreset{}, err
	}
	replaced := false
	for i := range presets {
		if presets[i].ID == preset.ID {
			presets[i] = preset
			replaced = true
			break
		}
	}
	if !replaced {
		presets = append(presets, preset)
	}
	if err := store.SavePresets(presets); err != nil {
		return LDAPSearchPreset{}, err
	}
	return preset, nil
}

// RemovePreset 实现 ldap/presets/remove：按 id 删除；不存在返回业务错误。
func (s *Service) RemovePreset(id string) error {
	store := s.presetStore()
	if store == nil {
		return fmt.Errorf("preset store is not available")
	}
	id = strings.TrimSpace(id)
	presets, err := store.LoadPresets()
	if err != nil {
		return err
	}
	out := make([]LDAPSearchPreset, 0, len(presets))
	found := false
	for _, preset := range presets {
		if preset.ID == id {
			found = true
			continue
		}
		out = append(out, preset)
	}
	if !found {
		return fmt.Errorf("preset %q is not found", id)
	}
	return store.SavePresets(out)
}

// presetStore nil 安全取预设存储。
func (s *Service) presetStore() PresetStore {
	return s.Presets
}

// readEntry base scope 读单条（tiny-rdm getEntry :744 语义：scope=base、
// sizeLimit=1、filter=(objectClass=*)、never deref；空结果报 entry not found）。
func (s *Service) readEntry(ctx context.Context, connectionID, dn string, attributes []string, typesOnly bool) (LDAPEntry, error) {
	var entry LDAPEntry
	isBinaryValue := s.ldapBinaryValuePredicate(connectionID)
	err := s.WithConn(ctx, connectionID, func(conn *ldap.Conn) error {
		result, err := conn.Search(ldap.NewSearchRequest(
			dn,
			ldap.ScopeBaseObject,
			ldap.NeverDerefAliases,
			1,
			0,
			typesOnly,
			"(objectClass=*)",
			normalizeLDAPAttributes(attributes),
			nil,
		))
		if err != nil {
			return err
		}
		if len(result.Entries) == 0 {
			return fmt.Errorf("ldap entry not found")
		}
		entry = ldapEntryToType(result.Entries[0], isBinaryValue)
		return nil
	})
	if err != nil {
		return LDAPEntry{}, err
	}
	return entry, nil
}

// schemaCache nil 安全取缓存。
func (s *Service) schemaCache() *SchemaCache {
	if s.SchemaCache == nil {
		return NewSchemaCache(defaultSchemaCacheTTL)
	}
	return s.SchemaCache
}

// aggregateLimit 聚合上限：sizeLimit 显式给定时用之，否则缺省 500（§10）。
func aggregateLimit(sizeLimit int) int {
	if sizeLimit > 0 {
		return sizeLimit
	}
	return defaultSearchAggregateLimit
}

// pagedSearchEntries 分页搜索聚合（对照 go-ldap Conn.SearchWithPaging 手动展开，
// 加客户端聚合上限：达到 limit 截断并返回 truncated=true，用于前端提示）。
func pagedSearchEntries(conn *ldap.Conn, searchReq *ldap.SearchRequest, pageSize uint32, limit int) ([]*ldap.Entry, bool, error) {
	pagingControl := ldap.NewControlPaging(pageSize)
	searchReq.Controls = append(searchReq.Controls, pagingControl)

	var entries []*ldap.Entry
	truncated := false
	for {
		result, err := conn.Search(searchReq)
		if err != nil {
			return entries, truncated, err
		}
		entries = append(entries, result.Entries...)

		// 聚合上限（limit>0 时生效）：截断并停止翻页。
		if limit > 0 && len(entries) >= limit {
			entries = entries[:limit]
			truncated = true
			return entries, truncated, nil
		}

		// 读取服务器返回的 paging control cookie；无 cookie 表示翻页结束。
		var received *ldap.ControlPaging
		for _, control := range result.Controls {
			if control.GetControlType() == ldap.ControlTypePaging {
				received = control.(*ldap.ControlPaging)
				break
			}
		}
		if received == nil || len(received.Cookie) == 0 {
			return entries, truncated, nil
		}
		pagingControl.SetCookie(received.Cookie)
	}
}

// 二进制值协议传输：go-ldap 的 attr.Values 是对原始字节做 string() 的产物，
// 非 UTF-8 字节经 JSON 序列化会被替换为 U+FFFD，二进制值在传输层就已损坏
//（前端 BinaryValueEditor 拿到的不再是合法 base64）。因此：
//   - 读路径：二进制属性值统一 base64 编码（前端本就按 base64 解释）；
//     普通属性仅对非法 UTF-8 的单值 base64 兜底，合法文本保持原样。
//   - 写路径：二进制语法属性的 base64 值解码回原始字节再下发（修复此前
//     「上传把 base64 文本当值写进目录」的静默损坏）；解码失败的值原样
//     下发，保留脚本/客户端直写原始字节的兼容路径。
//
// 判定优先级与前端 valueKinds.ts 一致：密码类名字永远排除（unicodePwd
// 语法是 octetString，值是明文/{SSHA} 文本，绝不能 base64 编解码）→
// 二进制名字绑定（objectGUID/objectSid/*Photo/*Certificate/userPKCS12）→
// schema 语法 OID（octetString/JPEG/证书族）。

// ldapBinarySyntaxOIDs 二进制语法集合（对齐 valueKinds.ts SYNTAX_KINDS 的
// binary 绑定子集；1.3.6.1.4.1.1466.115.121.1.5 Binary 旧语法一并纳入）。
var ldapBinarySyntaxOIDs = map[string]struct{}{
	"1.3.6.1.4.1.1466.115.121.1.5":  {}, // Binary（旧传真/图像类）
	"1.3.6.1.4.1.1466.115.121.1.8":  {}, // Certificate
	"1.3.6.1.4.1.1466.115.121.1.9":  {}, // Certificate List
	"1.3.6.1.4.1.1466.115.121.1.10": {}, // Certification Path
	"1.3.6.1.4.1.1466.115.121.1.28": {}, // JPEG
	"1.3.6.1.4.1.1466.115.121.1.40": {}, // Octet String
}

// ldapPasswordValueNames 密码语义属性名（值按文本处理，见上方优先级说明）。
var ldapPasswordValueNames = map[string]struct{}{
	"userpassword": {},
	"unicodepwd":   {},
}

// ldapAttrNameKey 属性名归一：小写 + 剥 ";binary" 等传输选项后缀。
func ldapAttrNameKey(name string) string {
	key := strings.ToLower(strings.TrimSpace(name))
	if idx := strings.Index(key, ";"); idx >= 0 {
		key = key[:idx]
	}
	return key
}

func ldapPasswordValueAttribute(name string) bool {
	key := ldapAttrNameKey(name)
	if _, ok := ldapPasswordValueNames[key]; ok {
		return true
	}
	return strings.HasSuffix(key, "password")
}

func ldapBinaryValueAttribute(name string) bool {
	key := ldapAttrNameKey(name)
	switch key {
	case "objectguid", "objectsid", "userpkcs12":
		return true
	}
	return strings.HasSuffix(key, "photo") || strings.HasSuffix(key, "certificate")
}

// ldapBinaryValuePredicate 返回该连接「属性值是否按二进制 base64 传输」的
// 判定函数。schema 缓存未加载时仅靠名字绑定（读路径另有非法 UTF-8 兜底）。
func (s *Service) ldapBinaryValuePredicate(connectionID string) func(string) bool {
	binaryNames := map[string]struct{}{}
	if metadata := s.schemaCache().Get(connectionID); metadata != nil {
		for _, attrType := range metadata.AttributeTypes {
			if _, ok := ldapBinarySyntaxOIDs[attrType.Syntax]; !ok {
				continue
			}
			for _, name := range append([]string{attrType.Name}, attrType.Names...) {
				if key := ldapAttrNameKey(name); key != "" {
					binaryNames[key] = struct{}{}
				}
			}
		}
	}
	return func(name string) bool {
		if ldapPasswordValueAttribute(name) {
			return false
		}
		if ldapBinaryValueAttribute(name) {
			return true
		}
		_, ok := binaryNames[ldapAttrNameKey(name)]
		return ok
	}
}

// decodeBinaryProtocolValues 写路径：base64 → 原始字节；非法 base64 或空
// 解码结果原样返回（normalizeLDAPWriteValues 已拒绝空值，此处防御直写）。
func decodeBinaryProtocolValues(values []string) []string {
	out := make([]string, len(values))
	for index, value := range values {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
		if err != nil || len(decoded) == 0 {
			out[index] = value
			continue
		}
		out[index] = string(decoded)
	}
	return out
}

// ldapEntriesToTypes / ldapEntryToType（tiny-rdm :2042/:2050 语义，叠加
// 二进制值 base64 保真传输，见本文件「二进制值协议传输」说明）。
func ldapEntriesToTypes(entries []*ldap.Entry, isBinary func(string) bool) []LDAPEntry {
	out := make([]LDAPEntry, 0, len(entries))
	for _, entry := range entries {
		out = append(out, ldapEntryToType(entry, isBinary))
	}
	return out
}

func ldapEntryToType(entry *ldap.Entry, isBinary func(string) bool) LDAPEntry {
	if entry == nil {
		return LDAPEntry{}
	}
	attrs := make(map[string][]string, len(entry.Attributes))
	for _, attr := range entry.Attributes {
		rawValues := attr.ByteValues
		values := make([]string, len(rawValues))
		for index, raw := range rawValues {
			if isBinary(attr.Name) || !utf8.Valid(raw) {
				values[index] = base64.StdEncoding.EncodeToString(raw)
			} else {
				values[index] = string(raw)
			}
		}
		attrs[attr.Name] = values
	}
	return LDAPEntry{DN: entry.DN, Attributes: attrs}
}

// ModifyDNDestinationDN 导出 modifyDn 目标 DN 计算（MCP 写路径 preview 用，
// 与 operations.go 内部实现同一语义）。
func ModifyDNDestinationDN(rawDN, rawNewRDN, rawNewSuperior string) (string, error) {
	return ldapModifyDNDestinationDN(rawDN, rawNewRDN, rawNewSuperior)
}
