// sort.go：RFC 2891 服务器端排序控件（GAP §5「服务器端排序控件」）。
//
// 请求侧：SortKey{AttributeType, Reverse} 编码进 1.2.840.113556.1.4.473
// Server Side Sorting 控件（go-ldap NewControlServerSideSortingWithSortKeys；
// 降序 = SortKey.Reverse=true，即 RFC 2891 §1.1 的 reverseOrder）。
// sortBy 为空 = 不请求排序（不发控件，请求形状与旧版本一致）。
//
// 响应侧：服务器返回 1.2.840.113556.1.4.474 SortResult 控件；码 0 = 排序成功，
// 非 0 = 服务器未按请求排序（不支持该属性/拒绝排序等）。此时**优雅降级**：
// 结果照常返回，状态码透出到响应 sortResult 字段交前端一次性提示，
// 不作为错误中断（RFC 2891 §1.2.2；控件缺失按成功处理——服务器未实现该
// 控件时 typically 不返回任何 SortResult）。
package ldapconn

import (
	"strings"

	ldap "github.com/go-ldap/ldap/v3"
)

// newLDAPSortControl 把 sortBy/sortOrder 请求字段编译为 RFC 2891 排序控件；
// sortBy 为空返回 nil（调用方跳过注入）。
func newLDAPSortControl(sortBy, sortOrder string) ldap.Control {
	attribute := strings.TrimSpace(sortBy)
	if attribute == "" {
		return nil
	}
	return ldap.NewControlServerSideSortingWithSortKeys([]*ldap.SortKey{{
		AttributeType: attribute,
		Reverse:       isLDAPSortDesc(sortOrder),
	}})
}

// isLDAPSortDesc 判定降序（大小写/首尾空白不敏感；除显式 "desc" 外一律升序）。
func isLDAPSortDesc(sortOrder string) bool {
	return strings.EqualFold(strings.TrimSpace(sortOrder), "desc")
}

// sortResultFromControls 读 SortResult 响应控件状态码：控件缺失或类型不符
// = 0（成功）；非 0 码为服务器降级信号。已知 go-ldap v3.4.13 上游缺陷：
// NewControlServerSideSortingResult 解析到非 0 码后未回填 Result 字段
// （control.go 解码器校验 Valid() 后直接返回零值控件），且裸 OCTET STRING
// 响应值走 OpenLDAP 兼容路径同样得 0——因此当前版本下线上实际透出的多为 0，
// 非 0 码透出属于就绪管道（上游修复解码器后即生效，无需改本层）。
// 优雅降级语义不依赖该码：控件缺失/码 0 一律照常返回结果。
func sortResultFromControls(controls []ldap.Control) int {
	control, _ := ldap.FindControl(controls, ldap.ControlTypeServerSideSortingResult).(*ldap.ControlServerSideSortingResult)
	if control == nil {
		return 0
	}
	return int(control.Result)
}
