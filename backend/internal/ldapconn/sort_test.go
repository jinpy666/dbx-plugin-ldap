package ldapconn

import (
	"encoding/json"
	"strings"
	"testing"

	ldap "github.com/go-ldap/ldap/v3"
)

// sort_test.go：RFC 2891 排序控件的离线单测（不连网）。控件注入/编码解码
// 走 go-ldap 导出 API（Encode → DecodeControl 往返），deref 缺省语义走
// ldapDerefAliases 映射表——树浏览（B 项）零配置不变的证据在此落档。

func TestNewLDAPSortControl(t *testing.T) {
	if control := newLDAPSortControl("", "desc"); control != nil {
		t.Fatalf("empty sortBy should not request sorting, got %#v", control)
	}
	if control := newLDAPSortControl("   ", "asc"); control != nil {
		t.Fatalf("blank sortBy should not request sorting, got %#v", control)
	}

	// 升序：Reverse=false；属性名 trim。
	ascending, ok := newLDAPSortControl(" cn ", "asc").(*ldap.ControlServerSideSorting)
	if !ok || len(ascending.SortKeys) != 1 {
		t.Fatalf("asc control = %#v", ascending)
	}
	if ascending.SortKeys[0].AttributeType != "cn" || ascending.SortKeys[0].Reverse {
		t.Fatalf("asc sort key = %+v", ascending.SortKeys[0])
	}

	// 降序：sortOrder 大小写/空白不敏感；其余值一律升序。
	for order, wantReverse := range map[string]bool{"desc": true, " DESC ": true, "": false, "bogus": false} {
		control := newLDAPSortControl("sn", order)
		keys := control.(*ldap.ControlServerSideSorting).SortKeys
		if keys[0].Reverse != wantReverse {
			t.Fatalf("sortOrder %q reverse = %v, want %v", order, keys[0].Reverse, wantReverse)
		}
	}

	// 控件类型 = RFC 2891 Server Side Sorting。
	if got := newLDAPSortControl("cn", "asc").GetControlType(); got != ldap.ControlTypeServerSideSorting {
		t.Fatalf("control type = %q", got)
	}
}

func TestNewLDAPSortControlRoundTrip(t *testing.T) {
	// 编码 → go-ldap 自带构造器往返（对齐 go-ldap control_test.go
	// TestControlServerSideSortingDecoding 的姿势：NewControlServerSideSorting
	// 吃整包 Encode 输出；DecodeControl 的 sort 分支吃外层包，不在此路径），
	// 验证请求控件线上形状（AttributeType/Reverse）。
	decoded, err := ldap.NewControlServerSideSorting(newLDAPSortControl("uid", "DESC").Encode())
	if err != nil {
		t.Fatalf("decode sort control: %v", err)
	}
	sortControl := decoded
	if sortControl.GetControlType() != ldap.ControlTypeServerSideSorting || len(sortControl.SortKeys) != 1 {
		t.Fatalf("decoded control = %#v", sortControl)
	}
	if sortControl.SortKeys[0].AttributeType != "uid" || !sortControl.SortKeys[0].Reverse {
		t.Fatalf("decoded sort key = %+v", sortControl.SortKeys[0])
	}
}

func TestSortResultFromControlsDegradesGracefully(t *testing.T) {
	// 无控件（服务器未实现/未返回）= 成功 0，不得视为错误。
	if got := sortResultFromControls(nil); got != 0 {
		t.Fatalf("nil controls sortResult = %d", got)
	}
	if got := sortResultFromControls([]ldap.Control{ldap.NewControlPaging(50)}); got != 0 {
		t.Fatalf("paging-only controls sortResult = %d", got)
	}

	// 非 0 码（如 inappropriateMatching=18 / noSuchAttribute=16）按
	// ControlServerSideSortingResult.Result 契约原样透出，供上层优雅降级提示。
	result := func(code ldap.ControlServerSideSortingCode) int {
		return sortResultFromControls([]ldap.Control{
			ldap.NewControlPaging(50),
			&ldap.ControlServerSideSortingResult{Result: code},
		})
	}
	if got := result(ldap.ControlServerSideSortingCodeSuccess); got != 0 {
		t.Fatalf("success sortResult = %d", got)
	}
	if got := result(ldap.ControlServerSideSortingCodeInappropriateMatching); got != 18 {
		t.Fatalf("inappropriateMatching sortResult = %d", got)
	}
	if got := result(ldap.ControlServerSideSortingCodeNoSuchAttribute); got != 16 {
		t.Fatalf("noSuchAttribute sortResult = %d", got)
	}

	// go-ldap 兼容层：无子包/nil 包（OpenLDAP 变体）折成零值成功控件 → 0。
	decoded, err := ldap.NewControlServerSideSortingResult(nil)
	if err != nil {
		t.Fatalf("empty-packet variant decode: %v", err)
	}
	if got := sortResultFromControls([]ldap.Control{decoded}); got != 0 {
		t.Fatalf("empty-packet variant sortResult = %d", got)
	}
}

func TestSearchRequestCarriesSortAndPagingControls(t *testing.T) {
	// 分页 + 排序同用：排序控件在请求创建时注入，paging 控件由
	// pagedSearchEntries 追加（与 Search 的分页路径同一构造次序），
	// 两条控件共存且排序在前。
	searchReq := ldap.NewSearchRequest(
		"dc=x",
		ldap.ScopeWholeSubtree,
		ldap.NeverDerefAliases,
		0,
		0,
		false,
		"(objectClass=*)",
		nil,
		[]ldap.Control{newLDAPSortControl("cn", "desc")},
	)
	searchReq.Controls = append(searchReq.Controls, ldap.NewControlPaging(50))
	if len(searchReq.Controls) != 2 {
		t.Fatalf("controls = %d", len(searchReq.Controls))
	}
	if searchReq.Controls[0].GetControlType() != ldap.ControlTypeServerSideSorting {
		t.Fatalf("first control = %q", searchReq.Controls[0].GetControlType())
	}
	if searchReq.Controls[1].GetControlType() != ldap.ControlTypePaging {
		t.Fatalf("second control = %q", searchReq.Controls[1].GetControlType())
	}
}

func TestLDAPDerefAliasesDefaultUnchanged(t *testing.T) {
	// 树浏览解引用（B 项）缺省语义：空/未知值一律 NeverDerefAliases，
	// 零配置行为与历史版本完全一致；显式值照常映射（大小写/空白不敏感）。
	cases := map[string]int{
		"":          ldap.NeverDerefAliases,
		"never":     ldap.NeverDerefAliases,
		"bogus":     ldap.NeverDerefAliases,
		" ALWAYS ":  ldap.DerefAlways,
		"searching": ldap.DerefInSearching,
		"Finding":   ldap.DerefFindingBaseObj,
	}
	for value, want := range cases {
		if got := ldapDerefAliases(value); got != want {
			t.Fatalf("derefAliases(%q) = %d, want %d", value, got, want)
		}
	}
}

func TestSearchSortFieldsJSONShape(t *testing.T) {
	// 请求字段 camelCase（sortBy/sortOrder）随 ldap/search 与
	// ldap/search/start（同构别名）透出。
	data, err := json.Marshal(LDAPSearchRequest{ConnectionID: "c1", Filter: "(objectClass=*)", SortBy: "cn", SortOrder: "desc"})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	if !strings.Contains(string(data), `"sortBy":"cn"`) || !strings.Contains(string(data), `"sortOrder":"desc"`) {
		t.Fatalf("request json = %s", data)
	}

	// 响应侧：sortResult 0 时省略（旧客户端无感）；非 0 降级码原样透出。
	zeroed, err := json.Marshal(LDAPSearchResult{Entries: []LDAPEntry{}, Count: 0})
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if strings.Contains(string(zeroed), "sortResult") {
		t.Fatalf("zero sortResult must be omitted: %s", zeroed)
	}
	degraded, err := json.Marshal(LDAPSearchSessionResult{SortResult: 18})
	if err != nil {
		t.Fatalf("marshal session result: %v", err)
	}
	if !strings.Contains(string(degraded), `"sortResult":18`) {
		t.Fatalf("degraded sortResult missing: %s", degraded)
	}
}
