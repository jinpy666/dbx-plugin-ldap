package ldapconn

// operations_search_limit_test.go：2026-09-30 审查修复（SEC-101/M-B2）的
// 回归测试：搜索客户端聚合截断 + 属性名大小写不敏感查找。

import (
	"fmt"
	"testing"

	ldap "github.com/go-ldap/ldap/v3"
)

func TestClampSearchEntriesAppliesAggregateLimit(t *testing.T) {
	entries := make([]*ldap.Entry, 5)
	for i := range entries {
		entries[i] = ldap.NewEntry(fmt.Sprintf("dn-%d", i), nil)
	}
	got, truncated := clampSearchEntries(entries, 3)
	if !truncated || len(got) != 3 {
		t.Errorf("clamp(entries,3) = len %d truncated %v, want 3/true", len(got), truncated)
	}
	if got[2].DN != "dn-2" {
		t.Errorf("clamp must keep prefix order, got dn %q", got[2].DN)
	}
	got, truncated = clampSearchEntries(entries, 0)
	if truncated || len(got) != 5 {
		t.Errorf("clamp(entries,0) = len %d truncated %v, want unclamped 5", len(got), truncated)
	}
	got, truncated = clampSearchEntries(entries, 10)
	if truncated || len(got) != 5 {
		t.Errorf("clamp(entries,10) = len %d truncated %v, want unclamped 5", len(got), truncated)
	}
}

func TestAggregateLimitDefaultsAndClamps(t *testing.T) {
	if got := aggregateLimit(0); got != defaultSearchAggregateLimit {
		t.Errorf("aggregateLimit(0) = %d, want default %d", got, defaultSearchAggregateLimit)
	}
	if got := aggregateLimit(maxSearchAggregateLimit + 1); got != maxSearchAggregateLimit {
		t.Errorf("aggregateLimit(huge) = %d, want clamp %d", got, maxSearchAggregateLimit)
	}
	if got := aggregateLimit(42); got != 42 {
		t.Errorf("aggregateLimit(42) = %d, want 42", got)
	}
}

func TestLDAPAttributeValuesCaseInsensitive(t *testing.T) {
	entry := LDAPEntry{
		DN: "cn=a,dc=example,dc=com",
		Attributes: map[string][]string{
			"ObjectClass": {"top", "person"},
			"mail":        {"a@example.com"},
		},
	}
	// 精确命中快路径（原语义不变）。
	if got := LDAPAttributeValues(entry, "mail"); len(got) != 1 {
		t.Errorf("exact hit: %v", got)
	}
	// 服务器拼写与请求拼写大小写不同（M-B2 核心场景）。
	if got := LDAPAttributeValues(entry, "objectclass"); len(got) != 2 {
		t.Errorf("case-insensitive objectclass: %v", got)
	}
	if got := LDAPAttributeValues(entry, "MAIL"); len(got) != 1 {
		t.Errorf("case-insensitive MAIL: %v", got)
	}
	// ";binary" 传输选项后缀归一。
	if got := LDAPAttributeValues(entry, "objectClass;binary"); len(got) != 2 {
		t.Errorf("options-suffix lookup: %v", got)
	}
	// 未命中返回 nil；空条目安全。
	if got := LDAPAttributeValues(entry, "nope"); got != nil {
		t.Errorf("miss should return nil, got %v", got)
	}
	if got := LDAPAttributeValues(LDAPEntry{}, "objectclass"); got != nil {
		t.Errorf("empty entry should return nil, got %v", got)
	}
}

func TestSubschemaDNFromRootDSECaseInsensitive(t *testing.T) {
	rootDSE := LDAPEntry{DN: "", Attributes: map[string][]string{
		"SUBSCHEMASUBENTRY": {"cn=subschema"},
	}}
	dn, err := subschemaDNFromRootDSE(rootDSE)
	if err != nil || dn != "cn=subschema" {
		t.Errorf("subschemaDNFromRootDSE = (%q, %v), want (cn=subschema, nil)", dn, err)
	}
}
