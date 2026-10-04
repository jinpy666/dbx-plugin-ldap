package ldapconn

// schema_binary_names_test.go：审查 M3 修复的回归测试——BinaryNames 惰性
// 派生集合随缓存条目换代，语义与旧「Get 深拷贝 + 全量重建」路径一致。

import (
	"testing"
	"time"
)

func TestSchemaCacheBinaryNamesDerivedAndInvalidated(t *testing.T) {
	cache := NewSchemaCache(time.Minute)
	metadata := LDAPSchemaMetadata{
		AttributeTypes: []LDAPSchemaAttributeType{
			// 二进制语法：本体名 + 别名都要进集合。
			{OID: "1.2.3.4.1", Name: "jpegPhoto", Names: []string{"jpegPhoto", "photo"}, Syntax: "1.3.6.1.4.1.1466.115.121.1.28"},
			// 非二进制语法：不得进集合。
			{OID: "1.2.3.4.2", Name: "cn", Names: []string{"cn", "commonName"}, Syntax: "1.3.6.1.4.1.1466.115.121.1.15"},
		},
	}
	if got := cache.BinaryNames("conn-1"); got != nil {
		t.Fatalf("empty cache should return nil, got %v", got)
	}
	cache.Put("conn-1", metadata)

	names := cache.BinaryNames("conn-1")
	if names == nil {
		t.Fatal("cache hit should derive a non-nil set")
	}
	if _, ok := names["jpegphoto"]; !ok {
		t.Errorf("binary primary name missing: %v", names)
	}
	if _, ok := names["photo"]; !ok {
		t.Errorf("binary alias missing: %v", names)
	}
	if _, ok := names["cn"]; ok {
		t.Errorf("non-binary syntax must not enter set: %v", names)
	}
	// 换代：Put 新元数据后集合重建（旧二进制属性消失）。
	cache.Put("conn-1", LDAPSchemaMetadata{AttributeTypes: []LDAPSchemaAttributeType{
		{OID: "1.2.3.4.2", Name: "cn", Syntax: "1.3.6.1.4.1.1466.115.121.1.15"},
	}})
	names = cache.BinaryNames("conn-1")
	if _, ok := names["jpegphoto"]; ok {
		t.Errorf("stale binary name after Put: %v", names)
	}
	// Invalidate 后回 nil（谓词回退纯名字绑定路径）。
	cache.Invalidate("conn-1")
	if got := cache.BinaryNames("conn-1"); got != nil {
		t.Errorf("invalidated entry should return nil, got %v", got)
	}
}

func TestLDAPBinaryValuePredicateFallsBackToNameBindings(t *testing.T) {
	svc := NewService()
	// 无 schema 缓存：仅名字绑定（objectGUID 等内建名单）仍然生效。
	predicate := svc.ldapBinaryValuePredicate("conn-x")
	if !predicate("objectGUID") {
		t.Errorf("built-in binary name must stay binary without schema cache")
	}
	if predicate("cn") {
		t.Errorf("text attribute must not be binary without schema cache")
	}
	if predicate("userPassword") {
		// 密码类永远排除（即便落在二进制名单/语法上）。
		t.Errorf("password attributes must never be binary-encoded")
	}
}
