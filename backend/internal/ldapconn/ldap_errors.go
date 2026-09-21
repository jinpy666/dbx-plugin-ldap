// ldap_errors.go 集中提取 go-ldap 错误元数据（结果码 + matchedDN）。
//
// 背景与契约：宿主桥对 PluginError.Data 的透传不可依赖，后端因此把
// 结果码编码进 message 前缀（`[ldap-code=65]`，matchedDN 非空再追加
// ` [ldap-matched=DN]`，见 main.go bizError），前端按前缀做 code-first
// 解析（frontend/src/lib/ldapErrors.ts 的 parseLdapErrorMeta）。
package ldapconn

import (
	"errors"

	ldap "github.com/go-ldap/ldap/v3"
)

// LdapErrorMeta 从错误中提取 LDAP 结果码与 matchedDN（非 LDAP 结果错误时 ok=false）。
// 支持 *ldap.Error 直接返回，也支持被 fmt.Errorf("%w") 包装的间接传递。
func LdapErrorMeta(err error) (code int, matchedDN string, ok bool) {
	var ldapErr *ldap.Error
	if !errors.As(err, &ldapErr) {
		return 0, "", false
	}
	return int(ldapErr.ResultCode), ldapErr.MatchedDN, true
}

// LdapReferralURIs 从结果码 10（Referral）的错误里提取引用 URI 列表。
//
// go-ldap v3.4.x 没有自动 referral 追随，URI 只保留在错误携带的原始 BER
// 响应包里（Error.Packet）。按包结构容错遍历（对齐 go-ldap 内部 getReferral
// 的 OpenLDAP 兼容写法：referral 序列的 tag 在不同服务端实现间不稳定，因此
// 只按结构位置取 response 的第 3 个 child，URI 值取各子节点的首个 string
// child），取不到返回 nil，调用方按"无引用"处理。
func LdapReferralURIs(err error) []string {
	var ldapErr *ldap.Error
	if !errors.As(err, &ldapErr) || int(ldapErr.ResultCode) != int(ldap.LDAPResultReferral) || ldapErr.Packet == nil {
		return nil
	}
	packet := ldapErr.Packet
	if len(packet.Children) < 2 {
		return nil
	}
	response := packet.Children[1]
	if len(response.Children) < 3 {
		return nil
	}
	var uris []string
	for _, child := range response.Children[2].Children {
		if child == nil || len(child.Children) == 0 {
			continue
		}
		if uri, ok := child.Children[0].Value.(string); ok && uri != "" {
			uris = append(uris, uri)
		}
	}
	return uris
}
