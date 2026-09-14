// 连接表单全组合矩阵守卫：tls_mode × auth_type 的每种组合经
// NewProfileFromLifecycle 必须「成功产出合法 profile」或「返回非空的明确
// 错误」——不允许 panic、空错误或与表单语义相悖的静默配置（发布前回归
// 守卫，对应宿主连接表单多组合选项的逻辑冲突排查）。
package ldapconn

import (
	"encoding/json"
	"strings"
	"testing"

	"io.dbx.ldap.plugin/internal/lifecycle"
)

func matrixParams(t *testing.T, tlsMode, authType string) *lifecycle.Params {
	t.Helper()
	raw := `{
	  "connection": {
	    "id": "matrix", "name": "matrix", "host": "ldap.example.org",
	    "external_config": {
	      "tls_mode": "` + tlsMode + `", "auth_type": "` + authType + `",
	      "bind_dn": "cn=admin,dc=example,dc=org", "username": "admin",
	      "bind_password": "s3cret", "ntlm_hash": "aabbccddeeff00112233445566778899",
	      "krb_credential_type": "password", "krb_password": "k3rb3ros"
	    }
	  },
	  "runtime": {"host": "ldap.example.org", "port": 389}
	}`
	params, err := lifecycle.Parse(json.RawMessage(raw))
	if err != nil {
		t.Fatalf("lifecycle parse: %v", err)
	}
	return params
}

func TestNewProfileFromLifecycleCombinationMatrix(t *testing.T) {
	tlsModes := []string{"none", "starttls", "ldaps"}
	authTypes := []string{
		"anonymous", "unauthenticated", "simple", "kerberos",
		"ntlm", "ntlm_hash", "digest_md5", "external",
	}

	for _, tlsMode := range tlsModes {
		for _, authType := range authTypes {
			t.Run(tlsMode+"/"+authType, func(t *testing.T) {
				profile, _, err := NewProfileFromLifecycle(matrixParams(t, tlsMode, authType))
				if err != nil {
					// 错误必须可读：非空、带归因，不允许空串或内部堆栈文案。
					if strings.TrimSpace(err.Error()) == "" {
						t.Fatalf("tls_mode=%s auth_type=%s: empty error", tlsMode, authType)
					}
					return
				}
				// 组合语义守卫：starttls 只允许落在 ldap:// 上（与 ldaps 互斥，
				// dial 层也会拒绝，但配置面不允许构造出这种静默组合）；ldaps
				// 必须 ldaps://；none 必须 ldap://。
				switch tlsMode {
				case "starttls":
					if !profile.UseStartTLS || strings.HasPrefix(profile.URL, "ldaps://") {
						t.Fatalf("tls_mode=starttls: UseStartTLS=%v url=%s", profile.UseStartTLS, profile.URL)
					}
				case "ldaps":
					if profile.UseStartTLS || !strings.HasPrefix(profile.URL, "ldaps://") {
						t.Fatalf("tls_mode=ldaps: UseStartTLS=%v url=%s", profile.UseStartTLS, profile.URL)
					}
				case "none":
					if profile.UseStartTLS || strings.HasPrefix(profile.URL, "ldaps://") {
						t.Fatalf("tls_mode=none: UseStartTLS=%v url=%s", profile.UseStartTLS, profile.URL)
					}
				}
				if profile.AuthType != authType {
					t.Fatalf("AuthType = %q, want %q", profile.AuthType, authType)
				}
			})
		}
	}
}

// TestCombinationMatrixLegacyURLConflicts 钉住旧连接的完整 URL 透传与结构化
// tls_mode 的互斥面：ldaps:// + legacy startTLS 必须在配置解析期被拒绝，而不是
// 拨号期才炸（组合逻辑冲突前置到报错最早点）。
func TestCombinationMatrixLegacyURLConflicts(t *testing.T) {
	if _, _, err := buildLDAPURL("ldaps://ldap.example.org", "none", true); err == nil {
		t.Fatal("legacy ldaps URL + startTLS must be rejected at config parse time")
	}
	if _, _, err := buildLDAPURL("ftp://ldap.example.org", "none", false); err == nil {
		t.Fatal("unsupported scheme must be rejected at config parse time")
	}
	if _, _, err := buildLDAPURL("ldap.example.org:389", "none", false); err == nil {
		t.Fatal("host with inline port must be rejected pointing at the port field")
	}
}
