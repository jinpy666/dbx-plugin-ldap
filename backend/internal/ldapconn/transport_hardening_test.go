// transport_hardening_test.go（GAP §1/§2 P2 落地）：传输层加固单测。
//
// 覆盖三块（全部离线，不起网络/容器）：
//   - dial/read 两档超时：ldapDialTimeout 的拨号窗口解析与回落语义；
//   - mTLS 客户端证书：ldapTLSConfig 加载成功/失败/残缺配置路径（自签
//     证书现场生成，密钥不落测试日志）；
//   - lifecycle 接线：dial_timeout_secs / tls_client_cert_path /
//     tls_client_key_path 经 NewProfileFromLifecycle 进入 Profile。
package ldapconn

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"io.dbx.ldap.plugin/internal/lifecycle"
)

func TestLDAPDialTimeoutResolution(t *testing.T) {
	const fallback = 30 * time.Second
	cases := []struct {
		name            string
		dialTimeoutSecs int
		want            time.Duration
	}{
		{"unset falls back to operation timeout", 0, fallback},
		{"negative falls back to operation timeout", -5, fallback},
		{"positive overrides operation timeout", 5, 5 * time.Second},
		{"long positive also wins", 120, 120 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ldapDialTimeout(Profile{DialTimeoutSeconds: tc.dialTimeoutSecs}, fallback)
			if got != tc.want {
				t.Fatalf("ldapDialTimeout(dial=%d) = %v, want %v", tc.dialTimeoutSecs, got, tc.want)
			}
		})
	}
	// NormalizeProfile 不得给 DialTimeoutSeconds 兜底非零值：0 = 回落语义
	// 必须原样穿透到 dial 层，否则旧连接的拨号行为会被暗中改变。
	if got := NormalizeProfile(Profile{}).DialTimeoutSeconds; got != 0 {
		t.Fatalf("NormalizeProfile dial timeout = %d, want 0 (fallback semantics)", got)
	}
}

// writeSelfSignedClientCert 生成一对自签 PEM（cert/key）写入临时目录并返回
// 路径。仅测试内使用；密钥只落 t.TempDir()，不进日志。
func writeSelfSignedClientCert(t *testing.T) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "dbx-ldap-test-client"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	dir := t.TempDir()
	certPath = filepath.Join(dir, "client.pem")
	keyPath = filepath.Join(dir, "client.key")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return certPath, keyPath
}

func TestLDAPTLSConfigClientCertificates(t *testing.T) {
	certPath, keyPath := writeSelfSignedClientCert(t)

	t.Run("both empty keeps current behavior", func(t *testing.T) {
		cfg, err := ldapTLSConfig(Profile{URL: "ldaps://h:636", TLSVerify: true}, true, "h")
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.Certificates) != 0 {
			t.Fatalf("no client cert configured but got %d", len(cfg.Certificates))
		}
	})

	t.Run("cert without key is rejected", func(t *testing.T) {
		_, err := ldapTLSConfig(Profile{URL: "ldaps://h:636", TLSVerify: true, TLSClientCertPath: certPath}, true, "h")
		if err == nil || !strings.Contains(err.Error(), "tls_client_key_path") {
			t.Fatalf("err = %v, want missing-key error naming both fields", err)
		}
	})

	t.Run("key without cert is rejected", func(t *testing.T) {
		_, err := ldapTLSConfig(Profile{URL: "ldaps://h:636", TLSVerify: true, TLSClientKeyPath: keyPath}, true, "h")
		if err == nil || !strings.Contains(err.Error(), "tls_client_cert_path") {
			t.Fatalf("err = %v, want missing-cert error naming both fields", err)
		}
	})

	t.Run("missing file surfaces the load error with the path only", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "absent.pem")
		_, err := ldapTLSConfig(Profile{URL: "ldaps://h:636", TLSVerify: true, TLSClientCertPath: missing, TLSClientKeyPath: keyPath}, true, "h")
		if err == nil || !strings.Contains(err.Error(), "load tls client certificate") || !strings.Contains(err.Error(), missing) {
			t.Fatalf("err = %v, want load error with the path", err)
		}
		// 私钥红线：错误消息不得携带任何文件内容/PEM 报文片段。
		if strings.Contains(err.Error(), "PRIVATE KEY") {
			t.Fatalf("error leaked key material: %v", err)
		}
	})

	t.Run("valid pair is attached to the tls config", func(t *testing.T) {
		cfg, err := ldapTLSConfig(Profile{URL: "ldaps://h:636", TLSVerify: true, TLSClientCertPath: certPath, TLSClientKeyPath: keyPath}, true, "h")
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.Certificates) != 1 {
			t.Fatalf("Certificates = %d, want 1", len(cfg.Certificates))
		}
		// LoadX509KeyPair 成对校验通过后 Leaf/PrivateKey 均已就绪。
		cert := cfg.Certificates[0]
		if cert.PrivateKey == nil || cert.Leaf == nil {
			t.Fatalf("attached keypair incomplete: private=%v leaf=%v", cert.PrivateKey != nil, cert.Leaf != nil)
		}
		if got := cert.Leaf.Subject.CommonName; got != "dbx-ldap-test-client" {
			t.Fatalf("attached certificate CN = %q", got)
		}
	})

	t.Run("plain connection ignores hidden cert fields", func(t *testing.T) {
		cfg, err := ldapTLSConfig(Profile{URL: "ldap://h:389", TLSClientCertPath: "/missing/x.pem", TLSClientKeyPath: "/missing/y.key"}, false, "h")
		if err != nil || cfg != nil {
			t.Fatalf("plain connection triggered certificate I/O: config=%v err=%v", cfg, err)
		}
	})

	t.Run("starttls config also loads the pair", func(t *testing.T) {
		cfg, err := ldapTLSConfig(Profile{URL: "ldap://h:389", UseStartTLS: true, TLSVerify: true, TLSClientCertPath: certPath, TLSClientKeyPath: keyPath}, true, "h")
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.Certificates) != 1 {
			t.Fatalf("StartTLS Certificates = %d, want 1", len(cfg.Certificates))
		}
	})
}

func TestNewProfileFromLifecycleTransportFields(t *testing.T) {
	raw := `{
	  "connection": {
	    "id": "transport", "name": "transport", "host": "ldap.example.org",
	    "external_config": {
	      "tls_mode": "ldaps", "auth_type": "simple", "bind_dn": "cn=admin",
	      "bind_password": "s3cret",
	      "timeout_secs": 42,
	      "dial_timeout_secs": 7,
	      "tls_client_cert_path": "  /etc/pki/client.pem ",
	      "tls_client_key_path": "  /etc/pki/client.key  "
	    }
	  },
	  "runtime": {"host": "ldap.example.org", "port": 636}
	}`
	params, err := lifecycle.Parse([]byte(raw))
	if err != nil {
		t.Fatalf("lifecycle parse: %v", err)
	}
	profile, _, err := NewProfileFromLifecycle(params)
	if err != nil {
		t.Fatal(err)
	}
	if profile.TimeoutSeconds != 42 {
		t.Fatalf("TimeoutSeconds = %d, want 42", profile.TimeoutSeconds)
	}
	if profile.DialTimeoutSeconds != 7 {
		t.Fatalf("DialTimeoutSeconds = %d, want 7", profile.DialTimeoutSeconds)
	}
	if profile.TLSClientCertPath != "/etc/pki/client.pem" || profile.TLSClientKeyPath != "/etc/pki/client.key" {
		t.Fatalf("client cert/key = %q/%q, want trimmed paths", profile.TLSClientCertPath, profile.TLSClientKeyPath)
	}

	// 缺省连接：dial_timeout_secs 未下发 → 0（回落 timeout_secs），mTLS 两个
	// 路径为空（现行为不变）。
	params, err = lifecycle.Parse([]byte(`{
	  "connection": {"id": "legacy", "name": "legacy", "host": "ldap.example.org"},
	  "runtime": {"host": "ldap.example.org", "port": 389}
	}`))
	if err != nil {
		t.Fatalf("lifecycle parse: %v", err)
	}
	profile, _, err = NewProfileFromLifecycle(params)
	if err != nil {
		t.Fatal(err)
	}
	if profile.DialTimeoutSeconds != 0 || profile.TLSClientCertPath != "" || profile.TLSClientKeyPath != "" {
		t.Fatalf("legacy profile = dial:%d cert:%q key:%q, want zero values (backward compatible)",
			profile.DialTimeoutSeconds, profile.TLSClientCertPath, profile.TLSClientKeyPath)
	}
}
