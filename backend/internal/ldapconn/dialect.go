package ldapconn

// dialect.go：LDAP 服务器方言检测。从 RootDSE 属性（vendorName / productName /
// supportedCapabilities）识别服务器类型，随 schema 元数据透出，供前端按方言
// 适配值编辑器（AD FILETIME、objectGUID/SID）与新建条目模板。
// 对标 Apache Directory Studio 的"按服务器类型装配"思路（其以 per-server
// 插件实现，此处用轻量方言字段等效）；RootDSE 不可读（如配置了
// allowed_base_dns）时降级 DialectUnknown，调用方按通用 RFC 4511 处理。

import "strings"

// 方言常量（JSON 暴露值）。
const (
	DialectAD       = "ad"       // Microsoft Active Directory / AD LDS
	DialectOpenLDAP = "openldap" // OpenLDAP
	Dialect389DS    = "389ds"    // 389 Directory Server / Red Hat DS
	DialectFreeIPA  = "freeipa"  // FreeIPA
	DialectRFC4511  = "rfc4511"  // 其他 LDAPv3 服务器（通用兜底）
	DialectUnknown  = ""         // RootDSE 不可读 / 未检测
)

// ldapCapabilityActiveDirectory LDAP_CAP_ACTIVE_DIRECTORY OID（RFC 4511 风格
// AD 扩展能力，MS-ADTS）；RootDSE supportedCapabilities 出现即判定 AD。
const ldapCapabilityActiveDirectory = "1.2.840.113556.1.4.800"

// detectLDAPDialect 从 RootDSE 条目推导方言与 vendor 摘要。
// 检测顺序：AD 能力/OID 归属 → FreeIPA → 389DS/Red Hat → OpenLDAP → 通用。
// 无法识别但有 vendor 信息时返回 DialectRFC4511。
func detectLDAPDialect(rootDSE LDAPEntry) (dialect, vendorName, productName string) {
	vendorName = firstLDAPNonEmpty(rootDSE.Attributes["vendorName"]...)
	productName = firstLDAPNonEmpty(rootDSE.Attributes["productName"]...)
	capabilities := rootDSE.Attributes["supportedCapabilities"]

	for _, capability := range capabilities {
		if strings.TrimSpace(capability) == ldapCapabilityActiveDirectory {
			return DialectAD, vendorName, productName
		}
	}

	combined := strings.ToLower(vendorName + " " + productName)
	switch {
	case strings.Contains(combined, "microsoft") || strings.Contains(combined, "active directory"):
		return DialectAD, vendorName, productName
	case strings.Contains(combined, "freeipa"):
		return DialectFreeIPA, vendorName, productName
	case strings.Contains(combined, "389") || strings.Contains(combined, "red hat") || strings.Contains(combined, "redhat"):
		return Dialect389DS, vendorName, productName
	case strings.Contains(combined, "openldap"):
		return DialectOpenLDAP, vendorName, productName
	default:
		return DialectRFC4511, vendorName, productName
	}
}

// applyLDAPDialectMetadata 把 RootDSE 方言检测结果写入 schema 元数据
//（schema.go ResolveSchema / operations.go SchemaMetadata 共用）。
func applyLDAPDialectMetadata(metadata *LDAPSchemaMetadata, rootDSE LDAPEntry) {
	dialect, vendorName, productName := detectLDAPDialect(rootDSE)
	metadata.Dialect = dialect
	metadata.VendorName = vendorName
	metadata.ProductName = productName
}
