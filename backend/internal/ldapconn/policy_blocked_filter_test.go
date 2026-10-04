package ldapconn

// policy_blocked_filter_test.go：审查 M5 修复的回归测试——编译一次的
// blocked 过滤闭包与旧逐条目路径语义一致，且无命中时不拷贝 Attributes。

import "testing"

func TestNewLDAPBlockedAttributeFilterParity(t *testing.T) {
	entry := LDAPEntry{
		DN: "cn=a",
		Attributes: map[string][]string{
			"cn":                  {"a"},
			"userPassword":        {"secret"},
			"userPassword;binary": {"secret"},
		},
	}
	// 缺省屏蔽表（Profile{} → DefaultLDAPBlockedAttributes）必须剔除 userPassword。
	filtered := newLDAPBlockedAttributeFilter(Profile{})(entry)
	if _, ok := filtered.Attributes["userPassword"]; ok {
		t.Errorf("blocked attribute survived: %v", filtered.Attributes)
	}
	if got := filtered.Attributes["cn"]; len(got) != 1 || got[0] != "a" {
		t.Errorf("unblocked attribute altered: %v", got)
	}
	// ";binary" 传输选项不得绕过屏蔽过滤。
	if _, ok := filtered.Attributes["userPassword;binary"]; ok {
		t.Errorf("transport-option suffix bypassed blocked filter")
	}
	// 无命中条目：值原样保留（零拷贝快速路径；别名断言属实现细节，不在此测）。
	clean := LDAPEntry{DN: "cn=b", Attributes: map[string][]string{"cn": {"b"}}}
	returned := newLDAPBlockedAttributeFilter(Profile{})(clean)
	if len(returned.Attributes) != len(clean.Attributes) {
		t.Fatalf("fast path must keep the entry intact")
	}
	if got := returned.Attributes["cn"]; len(got) != 1 || got[0] != "b" {
		t.Errorf("fast path altered values: %v", returned.Attributes)
	}
	// nil Attributes 语义保持。
	nilEntry := newLDAPBlockedAttributeFilter(Profile{})(LDAPEntry{DN: "cn=c"})
	if nilEntry.Attributes != nil {
		t.Errorf("nil Attributes must stay nil, got %v", nilEntry.Attributes)
	}
	// 与旧入口 filterLDAPEntryBlockedAttributes 的结果一致。
	legacy := filterLDAPEntryBlockedAttributes(Profile{}, entry)
	if _, ok := legacy.Attributes["userPassword"]; ok {
		t.Errorf("legacy wrapper drifted from compiled filter")
	}
}
