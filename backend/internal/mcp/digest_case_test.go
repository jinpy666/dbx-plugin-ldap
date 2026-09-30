package mcp

// digest_case_test.go：审查 M-B2 回归——聚合对服务器非规范属性拼写
// （如 "ObjectClass"/"MAIL"）不再静默落空（RFC 4512 属性名不区分大小写）。

import (
	"testing"

	"io.dbx.ldap.plugin/internal/ldapconn"
)

func TestAggregateDigestAttributeLookupIsCaseInsensitive(t *testing.T) {
	entries := []ldapconn.LDAPEntry{
		{
			DN: "cn=a,dc=example,dc=com",
			Attributes: map[string][]string{
				"ObjectClass": {"top", "person"}, // 服务器非规范拼写
				"Mail":        {"a@example.com"},
			},
		},
		{
			DN: "cn=b,dc=example,dc=com",
			Attributes: map[string][]string{
				"objectclass": {"person"}, // 规范拼写
				"MAIL":        {"b@example.com"},
			},
		},
	}
	result := AggregateDigest(DigestInput{
		Entries:      entries,
		BaseDN:       "dc=example,dc=com",
		DistinctAttr: "mail",
		GroupLimit:   20,
		TopN:         10,
		SampleRows:   5,
	})
	if got := result.Stats.ObjectClass; len(got) != 2 || got["person"] != 2 || got["top"] != 1 {
		t.Errorf("objectClass distribution = %v, want {person:2, top:1}", got)
	}
	if result.Stats.Distinct == nil || result.Stats.Distinct.ValueCount != 2 {
		t.Errorf("distinct(mail) = %+v, want 2 values across spellings", result.Stats.Distinct)
	}
}
