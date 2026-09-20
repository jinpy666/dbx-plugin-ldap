// ldap_errors_test.go 覆盖 LdapErrorMeta：*ldap.Error 直接提取
// （matchedDN 空/非空）、fmt.Errorf 包装后的间接提取、非 LDAP 错误
// 返回 ok=false（含 nil）。
package ldapconn

import (
	"errors"
	"fmt"
	"testing"

	ber "github.com/go-asn1-ber/asn1-ber"
	ldap "github.com/go-ldap/ldap/v3"
)

func TestLdapErrorMetaExtractsCodeAndMatchedDN(t *testing.T) {
	src := &ldap.Error{
		ResultCode: ldap.LDAPResultEntryAlreadyExists,
		Err:        errors.New("cn=dup,ou=people"),
		MatchedDN:  "dc=example,dc=com",
	}
	code, matchedDN, ok := LdapErrorMeta(src)
	if !ok {
		t.Fatal("期待 ok=true")
	}
	if code != 68 {
		t.Fatalf("code = %d，期待 68", code)
	}
	if matchedDN != "dc=example,dc=com" {
		t.Fatalf("matchedDN = %q，期待 dc=example,dc=com", matchedDN)
	}
}

func TestLdapErrorMetaEmptyMatchedDN(t *testing.T) {
	src := &ldap.Error{
		ResultCode: ldap.LDAPResultInvalidCredentials,
		Err:        errors.New("password wrong"),
	}
	code, matchedDN, ok := LdapErrorMeta(src)
	if !ok {
		t.Fatal("期待 ok=true")
	}
	if code != 49 {
		t.Fatalf("code = %d，期待 49", code)
	}
	if matchedDN != "" {
		t.Fatalf("matchedDN = %q，期待空", matchedDN)
	}
}

func TestLdapErrorMetaWrappedError(t *testing.T) {
	src := fmt.Errorf("ldap add: %w", &ldap.Error{
		ResultCode: ldap.LDAPResultObjectClassViolation,
		Err:        errors.New("object class violation"),
		MatchedDN:  "ou=people,dc=example,dc=com",
	})
	code, matchedDN, ok := LdapErrorMeta(src)
	if !ok {
		t.Fatal("期待 ok=true（errors.As 解包装）")
	}
	if code != 65 {
		t.Fatalf("code = %d，期待 65", code)
	}
	if matchedDN != "ou=people,dc=example,dc=com" {
		t.Fatalf("matchedDN = %q，期待 ou=people,dc=example,dc=com", matchedDN)
	}
}

func TestLdapErrorMetaNonLdapError(t *testing.T) {
	plain := errors.New("dial tcp 10.0.0.1:636: connection refused")
	cases := []error{
		plain,
		fmt.Errorf("dial wrapper: %w", plain),
		nil,
	}
	for _, err := range cases {
		if code, _, ok := LdapErrorMeta(err); ok {
			t.Fatalf("非 LDAP 错误期待 ok=false，得到 ok=true code=%d", code)
		}
	}
}

// referralReferralResponsePacket 构造一个最小 LDAPResult 响应包：
// packet.Children[0] = messageID，Children[1] = 响应（resultCode / matchedDN /
// referral 序列）。referral 序列的 tag 取 ber.TagObjectDescriptor（ADS/OpenLDAP
// 常见形态之一；提取逻辑按结构位置容错，不依赖 tag 值）。
func referralReferralResponsePacket(uris ...string) *ber.Packet {
	referralURIs := &ber.Packet{Children: make([]*ber.Packet, 0, len(uris))}
	for _, uri := range uris {
		referralURIs.Children = append(referralURIs.Children, &ber.Packet{
			Children: []*ber.Packet{
				{Identifier: ber.Identifier{ClassType: ber.ClassUniversal, TagType: ber.TypePrimitive, Tag: ber.TagOctetString}, Value: uri},
			},
		})
	}
	response := &ber.Packet{Children: []*ber.Packet{
		{Identifier: ber.Identifier{ClassType: ber.ClassUniversal, TagType: ber.TypePrimitive, Tag: ber.TagEnumerated}, Value: int64(ldap.LDAPResultReferral)},
		{Identifier: ber.Identifier{ClassType: ber.ClassUniversal, TagType: ber.TypePrimitive, Tag: ber.TagOctetString}, Value: ""},
		referralURIs,
	}}
	return &ber.Packet{Children: []*ber.Packet{
		{Identifier: ber.Identifier{ClassType: ber.ClassUniversal, TagType: ber.TypePrimitive}, Value: int64(1)},
		response,
	}}
}

func TestLdapReferralURIsExtractsFromCode10Packet(t *testing.T) {
	err := &ldap.Error{
		ResultCode: ldap.LDAPResultReferral,
		Err:        errors.New("referral"),
		Packet:     referralReferralResponsePacket("ldap://a.example/dc=example,dc=com", "ldap://b.example/dc=example,dc=com"),
	}
	uris := LdapReferralURIs(err)
	if len(uris) != 2 {
		t.Fatalf("uris = %v，期待 2 条", uris)
	}
	if uris[0] != "ldap://a.example/dc=example,dc=com" || uris[1] != "ldap://b.example/dc=example,dc=com" {
		t.Fatalf("uris 内容不符：%v", uris)
	}
}

func TestLdapReferralURIsNilForNonReferralOrMalformed(t *testing.T) {
	// 非 code-10 错误：一律 nil（包括带 referral 形态包的干扰项）。
	if got := LdapReferralURIs(&ldap.Error{ResultCode: ldap.LDAPResultNoSuchObject, Err: errors.New("x"), Packet: referralReferralResponsePacket("ldap://a.example")}); got != nil {
		t.Fatalf("非 referral 错误应返回 nil，got %v", got)
	}
	// code-10 但无包 / 包结构缺 children：容错返回 nil。
	if got := LdapReferralURIs(&ldap.Error{ResultCode: ldap.LDAPResultReferral, Err: errors.New("x")}); got != nil {
		t.Fatalf("无 Packet 应返回 nil，got %v", got)
	}
	if got := LdapReferralURIs(&ldap.Error{ResultCode: ldap.LDAPResultReferral, Err: errors.New("x"), Packet: &ber.Packet{Children: []*ber.Packet{{Value: int64(1)}}}}); got != nil {
		t.Fatalf("畸形包应返回 nil，got %v", got)
	}
	// 非 LDAP 错误与 nil。
	if got := LdapReferralURIs(errors.New("plain")); got != nil {
		t.Fatalf("普通错误应返回 nil，got %v", got)
	}
	if got := LdapReferralURIs(nil); got != nil {
		t.Fatalf("nil 应返回 nil，got %v", got)
	}
}

func TestLdapReferralURIsWrappedErrorAndEmptyURIs(t *testing.T) {
	// fmt.Errorf("%w") 包装的间接传递。
	src := &ldap.Error{
		ResultCode: ldap.LDAPResultReferral,
		Err:        errors.New("referral"),
		Packet:     referralReferralResponsePacket("ldaps://c.example/o=corp"),
	}
	wrapped := fmt.Errorf("ldap search: %w", src)
	uris := LdapReferralURIs(wrapped)
	if len(uris) != 1 || uris[0] != "ldaps://c.example/o=corp" {
		t.Fatalf("包装错误提取失败：%v", uris)
	}
	// 空串 URI 被跳过。
	empty := &ldap.Error{
		ResultCode: ldap.LDAPResultReferral,
		Err:        errors.New("referral"),
		Packet:     referralReferralResponsePacket("", "ldap://kept.example"),
	}
	if got := LdapReferralURIs(empty); len(got) != 1 || got[0] != "ldap://kept.example" {
		t.Fatalf("空 URI 应被跳过：%v", got)
	}
}
