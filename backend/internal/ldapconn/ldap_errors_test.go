// ldap_errors_test.go 覆盖 LdapErrorMeta：*ldap.Error 直接提取
// （matchedDN 空/非空）、fmt.Errorf 包装后的间接提取、非 LDAP 错误
// 返回 ok=false（含 nil）。
package ldapconn

import (
	"errors"
	"fmt"
	"testing"

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
