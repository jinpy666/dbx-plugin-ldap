package ldapconn

// config_tls_verify_test.go：审查 M1 修复的回归测试——tls_verify 以
// fail-closed 语义解析，只有显式 false 形态才关闭证书校验。

import "testing"

func TestConfigTLSVerifyFailClosed(t *testing.T) {
	cases := []struct {
		name string
		raw  any
		want bool
	}{
		{"missing-default", nil, true},
		{"bool-false", false, false},
		{"bool-true", true, true},
		{"string-false", "false", false},
		{"string-FALSE-space", " FALSE ", false},
		{"string-f", "f", false},
		{"string-0", "0", false},
		{"string-no", "no", false},
		{"string-off", "off", false},
		// fail-closed 核心：人类习惯真值/乱码/JSON 数字形态一律保持校验开启。
		{"string-yes", "yes", true},
		{"string-on", "on", true},
		{"string-garbage", "???", true},
		{"string-empty", "", true},
		{"number-1", float64(1), true},
		{"number-0", float64(0), false},
		{"number-2", float64(2), true},
		{"unexpected-type", struct{}{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := configTLSVerify(tc.raw); got != tc.want {
				t.Errorf("configTLSVerify(%#v) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}
