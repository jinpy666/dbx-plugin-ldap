// Package ldapconn 移植自 tiny-rdm backend/services/ldap_service.go 与
// backend/types/ldap.go（L-B 路：领域操作与安全策略）。
//
// types.go：请求/响应/条目类型。相对 tiny-rdm types/ldap.go 的改造：
//   - ProfileID → ConnectionID（宿主连接模型，§5.2 契约）；
//   - 删除 LDAPTargetConfig / LDAPKerberosConfig / LDAPEndpointRewrite /
//     CommonTransportConfig / MCPPolicyConfig 等宿主替代或 M3 延后字段；
//   - Profile 收敛为 manifest §4 字段 + 运行时派生项；
//   - JSON tag 全部 camelCase。
package ldapconn

import "strings"

// 认证类型（tiny-rdm types/ldap.go:5-14）。
const (
	LDAPAuthAnonymous       = "anonymous"
	LDAPAuthUnauthenticated = "unauthenticated"
	LDAPAuthSimple          = "simple"
	LDAPAuthKerberos        = "kerberos"
	LDAPAuthNTLM            = "ntlm"
	LDAPAuthNTLMHash        = "ntlm_hash"
	LDAPAuthDigestMD5       = "digest_md5"
	LDAPAuthExternal        = "external"
)

// LDAPKerberosConfig 是 kerberos（GSSAPI）认证的 Kerberos 客户端配置
// （tiny-rdm types/ldap.go LDAPKerberosConfig 收敛为 manifest §4 的 krb_* 字段；
// SPN/serviceName/KDCNetworkAddress 等 endpoint-rewrite 项随 D5 方案删除，SPN
// 从 URL 逻辑主机推导，见 auth_gssapi.go ldapKerberosServicePrincipal）。
// 密码不在此结构：kerberos 密码是 secret，与 bind_password 一样只存连接表。
type LDAPKerberosConfig struct {
	CredentialType string `json:"credentialType,omitempty"` // password | keytab | ccache（缺省 password）
	Username       string `json:"username,omitempty"`
	Realm          string `json:"realm,omitempty"`
	KDCHost        string `json:"kdcHost,omitempty"`
	// KDCPort 缺省 88（NormalizeLDAPKerberosConfig 兜底）。
	KDCPort      int    `json:"kdcPort,omitempty"`
	KeytabPath   string `json:"keytabPath,omitempty"`
	CCachePath   string `json:"ccachePath,omitempty"`
	Krb5ConfPath string `json:"krb5ConfPath,omitempty"`
}

// NormalizeLDAPKerberosConfig 归一化（tiny-rdm types.NormalizeLDAPKerberosConfig
// 中与本仓字段对应的子集原样移植）。
func NormalizeLDAPKerberosConfig(k LDAPKerberosConfig) LDAPKerberosConfig {
	k.CredentialType = strings.ToLower(strings.TrimSpace(k.CredentialType))
	if k.CredentialType == "" {
		k.CredentialType = "password"
	}
	k.Username = strings.TrimSpace(k.Username)
	k.Realm = strings.ToUpper(strings.TrimSpace(k.Realm))
	k.KDCHost = strings.TrimSpace(k.KDCHost)
	k.KeytabPath = strings.TrimSpace(k.KeytabPath)
	k.CCachePath = strings.TrimSpace(k.CCachePath)
	k.Krb5ConfPath = strings.TrimSpace(k.Krb5ConfPath)
	if k.KDCPort <= 0 {
		k.KDCPort = 88
	}
	return k
}

// Profile 是 sidecar 内存的连接配置（由 lifecycle 从宿主 params 构造，L-A 接线）。
// 凭据字段（NTLMHash）只存内存连接表，禁止写入日志/审计/事件；bind 密码与
// kerberos 密码在 Service 连接表内独立保存（见 service.go connEntry）。
type Profile struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	BaseDN      string `json:"baseDn,omitempty"`
	AuthType    string `json:"authType,omitempty"`
	BindDN      string `json:"bindDn,omitempty"`
	Username    string `json:"username,omitempty"`
	Domain      string `json:"domain,omitempty"`
	NTLMHash    string `json:"ntlmHash,omitempty"`
	AuthzID     string `json:"authzId,omitempty"`
	UseStartTLS bool   `json:"useStartTls,omitempty"`
	TLSVerify   bool   `json:"tlsVerify"`
	TLSCAPath   string `json:"tlsCaPath,omitempty"`
	// TLSServerName 缺省派生为 connection.host（L-A dial 层负责兜底）。
	TLSServerName string `json:"tlsServerName,omitempty"`
	// Kerberos 仅在 auth_type=kerberos 时由 lifecycle 填充（M3）。
	Kerberos *LDAPKerberosConfig `json:"kerberos,omitempty"`
	// SASLHost 覆盖 DIGEST-MD5 的 SASL host（缺省用 URL 逻辑主机，
	// tiny-rdm resolveLDAPSASLHost :1470 语义）。manifest 未暴露，留扩展点。
	SASLHost string `json:"saslHost,omitempty"`
	// SASLQoP：auth | auth-int | auth-conf（缺省 auth → integrity on，
	// confidentiality off；tiny-rdm ldapGSSAPIClientOptions 同构）。
	SASLQoP string `json:"saslQop,omitempty"`
	// SASLMutualAuth：GSSAPI mutual 认证开关（缺省 false，tiny-rdm 同）。
	SASLMutualAuth bool `json:"saslMutualAuth,omitempty"`
	// TimeoutSeconds 缺省 30（lifecycle 构造时兜底）。
	TimeoutSeconds int  `json:"timeoutSeconds,omitempty"`
	ReadOnly       bool `json:"readOnly"`

	// DN 白名单与屏蔽属性策略（§6）。空 = 不限。
	AllowedBaseDNs      []string `json:"allowedBaseDns,omitempty"`
	AllowedWriteBaseDNs []string `json:"allowedWriteBaseDns,omitempty"`
	BlockedAttributes   []string `json:"blockedAttributes,omitempty"`
}

// NormalizeProfile 归一化 Profile（收敛自 tiny-rdm NormalizeLDAPConnectionProfile
// 中与策略/超时相关的部分；连接与 TLS 细节归 L-A dial 层）。
func NormalizeProfile(p Profile) Profile {
	p.ID = strings.TrimSpace(p.ID)
	p.Name = strings.TrimSpace(p.Name)
	p.URL = strings.TrimSpace(p.URL)
	p.BaseDN = strings.TrimSpace(p.BaseDN)
	p.AuthType = strings.ToLower(strings.TrimSpace(p.AuthType))
	if p.AuthType == "" {
		p.AuthType = LDAPAuthSimple
	}
	p.BindDN = strings.TrimSpace(p.BindDN)
	p.Username = strings.TrimSpace(p.Username)
	p.Domain = strings.TrimSpace(p.Domain)
	p.AuthzID = strings.TrimSpace(p.AuthzID)
	p.TLSCAPath = strings.TrimSpace(p.TLSCAPath)
	p.TLSServerName = strings.TrimSpace(p.TLSServerName)
	p.SASLHost = strings.TrimSpace(p.SASLHost)
	p.SASLQoP = strings.ToLower(strings.TrimSpace(p.SASLQoP))
	if p.Kerberos != nil {
		normalized := NormalizeLDAPKerberosConfig(*p.Kerberos)
		p.Kerberos = &normalized
	}
	if p.TimeoutSeconds <= 0 {
		p.TimeoutSeconds = 30
	}
	p.AllowedBaseDNs = normalizeLDAPStringList(p.AllowedBaseDNs)
	p.AllowedWriteBaseDNs = normalizeLDAPStringList(p.AllowedWriteBaseDNs)
	p.BlockedAttributes = normalizeLDAPStringList(p.BlockedAttributes)
	return p
}

// Redacted 返回可安全打日志/审计的副本（凭据字段清空；bindDn 非机密保留）。
func (p Profile) Redacted() Profile {
	p.NTLMHash = ""
	return p
}

func normalizeLDAPStringList(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}

// LDAPEntry 目录条目（tiny-rdm types/ldap.go:90-93）。
type LDAPEntry struct {
	DN         string              `json:"dn"`
	Attributes map[string][]string `json:"attributes"`
}

// LDAPSearchRequest 对应 ldap/search（§5.2）。
type LDAPSearchRequest struct {
	ConnectionID string   `json:"connectionId"`
	BaseDN       string   `json:"baseDn,omitempty"`
	Filter       string   `json:"filter"`
	Scope        string   `json:"scope,omitempty"`
	Attributes   []string `json:"attributes,omitempty"`
	SizeLimit    int      `json:"sizeLimit,omitempty"`
	PageSize     int      `json:"pageSize,omitempty"`
	TypesOnly    bool     `json:"typesOnly,omitempty"`
	DerefAliases string   `json:"derefAliases,omitempty"`
}

// LDAPSearchResult 对应 ldap/search 返回。
type LDAPSearchResult struct {
	Entries   []LDAPEntry `json:"entries"`
	Count     int         `json:"count"`
	Truncated bool        `json:"truncated"`
	BaseDN    string      `json:"baseDn,omitempty"`
	Filter    string      `json:"filter,omitempty"`
}

// LDAPSearchSessionRequest 对应 ldap/search/start。字段与 ldap/search 一致，
// 但 pageSize 表示一次返回的页大小；服务端不会在首个响应前聚合剩余页面。
type LDAPSearchSessionRequest = LDAPSearchRequest

// LDAPSearchSessionNextRequest 对应 ldap/search/next。connectionId 将游标
// 绑定到创建它的连接，避免一个连接上的调用方读取另一个连接的结果集。
type LDAPSearchSessionNextRequest struct {
	ConnectionID string `json:"connectionId"`
	SearchID     string `json:"searchId"`
}

// LDAPSearchSessionCancelRequest 对应 ldap/search/cancel。
type LDAPSearchSessionCancelRequest struct {
	ConnectionID string `json:"connectionId"`
	SearchID     string `json:"searchId"`
}

// LDAPSearchSessionResult 是 start/next 的增量页响应。Count 仅为当前页条数，
// 不是昂贵的全量计数；hasMore=false 时该 searchId 自动释放。
type LDAPSearchSessionResult struct {
	SearchID  string      `json:"searchId,omitempty"`
	Entries   []LDAPEntry `json:"entries"`
	Count     int         `json:"count"`
	HasMore   bool        `json:"hasMore"`
	Truncated bool        `json:"truncated,omitempty"`
	BaseDN    string      `json:"baseDn,omitempty"`
	Filter    string      `json:"filter,omitempty"`
}

// LDAPGetEntryRequest 对应 ldap/entry/get。
type LDAPGetEntryRequest struct {
	ConnectionID string   `json:"connectionId"`
	DN           string   `json:"dn"`
	Attributes   []string `json:"attributes,omitempty"`
	// TypesOnly returns the visible attribute names with no values.  It lets the
	// workbench discover a large entry cheaply before requesting value batches.
	TypesOnly    bool     `json:"typesOnly,omitempty"`
}

// LDAPCountRequest 对应 ldap/count：baseDN 下直接子条目数（scope=one），
// 供树节点徽章显示精确计数（替代 sizeLimit 截断语义）。filter 缺省
// (objectClass=*)；计数上限 5000，超出以 truncated 标记。
type LDAPCountRequest struct {
	ConnectionID string `json:"connectionId"`
	BaseDN       string `json:"baseDn,omitempty"`
	Filter       string `json:"filter,omitempty"`
}

// LDAPCountResult 对应 ldap/count 返回。
type LDAPCountResult struct {
	Count     int  `json:"count"`
	Truncated bool `json:"truncated,omitempty"`
}

// LDAPRootDSERequest 对应 ldap/rootDSE。
type LDAPRootDSERequest struct {
	ConnectionID string   `json:"connectionId"`
	Attributes   []string `json:"attributes,omitempty"`
}

// LDAPSchemaMetadataRequest 对应 ldap/schema。
type LDAPSchemaMetadataRequest struct {
	ConnectionID string `json:"connectionId"`
	Refresh      bool   `json:"refresh,omitempty"`
}

// LDAPSchemaAttributeType schema attributeTypes 条目（tiny-rdm :122-127 +
// RFC 4512 语法语义扩展：SYNTAX/EQUALITY 等驱动前端值编辑器分流）。
type LDAPSchemaAttributeType struct {
	OID         string   `json:"oid"`
	Name        string   `json:"name"`
	Names       []string `json:"names"`
	Description string   `json:"description,omitempty"`
	// Syntax 语法 OID（SYNTAX，剥离 {len} 长度后缀）；Equality/Substr/Ordering
	// 匹配规则名；Sup 上位属性名；SingleValue/NoUserModification 布尔标记。
	Syntax             string `json:"syntax,omitempty"`
	Equality           string `json:"equality,omitempty"`
	Substr             string `json:"substr,omitempty"`
	Ordering           string `json:"ordering,omitempty"`
	Sup                string `json:"sup,omitempty"`
	SingleValue        bool   `json:"singleValue,omitempty"`
	NoUserModification bool   `json:"noUserModification,omitempty"`
}

// LDAPSchemaObjectClassAttributes schema objectClasses 条目（tiny-rdm :129-136）。
type LDAPSchemaObjectClassAttributes struct {
	OID         string   `json:"oid"`
	Name        string   `json:"name"`
	Names       []string `json:"names"`
	Description string   `json:"description,omitempty"`
	Must        []string `json:"must"`
	May         []string `json:"may"`
}

// LDAPSchemaMetadata schema 元数据聚合（tiny-rdm :138-143 + 方言/原始定义扩展）。
type LDAPSchemaMetadata struct {
	SubschemaSubentry     string                                     `json:"subschemaSubentry"`
	AttributeNames        []string                                   `json:"attributeNames"`
	AttributeTypes        []LDAPSchemaAttributeType                  `json:"attributeTypes"`
	ObjectClassAttributes map[string]LDAPSchemaObjectClassAttributes `json:"objectClassAttributes"`
	// RawAttributeTypes / RawObjectClasses subschema 条目的原始 RFC 4512 定义串
	//（与 AttributeTypes 同序；前端 deriveSchemaMetadata 的历史消费格式）。
	RawAttributeTypes []string `json:"rawAttributeTypes,omitempty"`
	RawObjectClasses  []string `json:"rawObjectClasses,omitempty"`
	// Dialect / VendorName / ProductName 服务器方言检测摘要（RootDSE 推导，
	// dialect.go；AllowedBaseDNs 禁用 RootDSE 时 Dialect 为 DialectUnknown）。
	Dialect     string `json:"dialect,omitempty"`
	VendorName  string `json:"vendorName,omitempty"`
	ProductName string `json:"productName,omitempty"`
}

// LDAPAddEntryRequest 对应 ldap/entry/add。
type LDAPAddEntryRequest struct {
	ConnectionID string              `json:"connectionId"`
	DN           string              `json:"dn"`
	Attributes   map[string][]string `json:"attributes"`
	// Source 审计来源（内部传参，不进协议；"mcp" = MCP 写路径）。
	Source string `json:"-"`
}

// LDAPModifyChange 单条修改（tiny-rdm :151-155）。
type LDAPModifyChange struct {
	Operation string   `json:"operation"` // add | replace | delete
	Attribute string   `json:"attribute"`
	Values    []string `json:"values,omitempty"`
}

// LDAPModifyEntryRequest 对应 ldap/entry/modify。
type LDAPModifyEntryRequest struct {
	ConnectionID string             `json:"connectionId"`
	DN           string             `json:"dn"`
	Changes      []LDAPModifyChange `json:"changes"`
	// Source 审计来源（内部传参，不进协议；"mcp" = MCP 写路径）。
	Source string `json:"-"`
}

// LDAPDeleteEntryRequest 对应 ldap/entry/delete。
type LDAPDeleteEntryRequest struct {
	ConnectionID string `json:"connectionId"`
	DN           string `json:"dn"`
	// Recursive 为 true 时删除 dn 及其整棵子树（N1：优先服务端 Tree Delete
	// 控件，不支持时回退自底向上逐条删除，条目上限 1000）；缺省 false
	// 保持单条语义，完全向后兼容。
	Recursive bool `json:"recursive,omitempty"`
	// Source 审计来源（内部传参，不进协议；"mcp" = MCP 写路径）。
	Source string `json:"-"`
}

// LDAPChildrenCountRequest 对应 ldap/entry/childrenCount（N1：删除确认框
// 子条目计数）：dn 下直接子条目数（scope=one、filter (objectClass=*)），
// 计数上限 5000，超出以 truncated 标记（与 ldap/count 同风格）。
type LDAPChildrenCountRequest struct {
	ConnectionID string `json:"connectionId"`
	DN           string `json:"dn"`
}

// LDAPModifyDNRequest 对应 ldap/entry/modifyDn（tiny-rdm :168-174，NewSuperior→NewParentDN 语义不变）。
type LDAPModifyDNRequest struct {
	ConnectionID string `json:"connectionId"`
	DN           string `json:"dn"`
	NewRDN       string `json:"newRdn"`
	DeleteOldRDN bool   `json:"deleteOldRdn"`
	NewSuperior  string `json:"newSuperior,omitempty"`
	// Source 审计来源（内部传参，不进协议；"mcp" = MCP 写路径）。
	Source string `json:"-"`
}

// LDAPConnectionStatus 连接状态（tiny-rdm :176-184；ProfileID→ConnectionID）。
type LDAPConnectionStatus struct {
	ConnectionID string `json:"connectionId"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	Status       string `json:"status"` // connected | idle | error
	// ReadOnly 透出策略层只读门禁（表单 read_only ∥ 宿主 read_only），
	// 供前端禁用条目写操作。
	ReadOnly    bool   `json:"readOnly,omitempty"`
	ConnectedAt int64  `json:"connectedAt,omitempty"`
	LastUsedAt  int64  `json:"lastUsedAt,omitempty"`
	Error       string `json:"error,omitempty"`
}

// AuditRecord 写操作审计记录（§5.3 ldap/audit 事件 + audit.jsonl 同条落盘）。
// Result 语义（operations 契约）：ok | denied | error。
type AuditRecord struct {
	ConnectionID string `json:"connectionId"`
	Action       string `json:"action"` // add-entry | modify-entry | delete-entry | subtree_delete | modify-dn | read-policy | write-policy
	Target       string `json:"target"`
	Result       string `json:"result"` // success | blocked | error
	Detail       string `json:"detail,omitempty"`
	// Source 调用来源（M0 审计事件形状不变，新增可选字段）：缺省空 = 工作
	// 台；"mcp" = MCP 写路径（设计 §4：所有 MCP 写审计记 source:"mcp"）。
	Source string `json:"source,omitempty"`
	// DeletedCount 仅 recursive 子树删除的聚合审计携带（删除条目数，含目标
	// 自身；单条删除/拒绝路径不出现）。
	DeletedCount int `json:"deletedCount,omitempty"`
}
