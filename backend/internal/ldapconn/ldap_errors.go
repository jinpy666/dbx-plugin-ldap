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
