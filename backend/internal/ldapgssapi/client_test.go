package ldapgssapi

import (
	"testing"

	krbgssapi "github.com/jcmturner/gokrb5/v8/gssapi"
)

func TestClientOptionsContextFlags_DefaultsToIntegrityOnly(t *testing.T) {
	flags := (ClientOptions{}).contextFlags()
	if len(flags) != 1 || flags[0] != krbgssapi.ContextFlagInteg {
		t.Fatalf("contextFlags() = %#v, want only ContextFlagInteg", flags)
	}
}

func TestClientOptionsContextFlags_AuthConfMutual(t *testing.T) {
	flags := (ClientOptions{
		UseIntegrity:       true,
		UseConfidentiality: true,
		MutualAuth:         true,
	}).contextFlags()

	if len(flags) != 3 {
		t.Fatalf("contextFlags() len = %d, want 3", len(flags))
	}
	if flags[0] != krbgssapi.ContextFlagInteg || flags[1] != krbgssapi.ContextFlagConf || flags[2] != krbgssapi.ContextFlagMutual {
		t.Fatalf("contextFlags() = %#v", flags)
	}
}

func TestClientOptionsNeedInitContinuation(t *testing.T) {
	if (ClientOptions{}).needInitContinuation() {
		t.Fatal("needInitContinuation() should default to false when mutual auth is disabled")
	}
	if !(ClientOptions{MutualAuth: true}).needInitContinuation() {
		t.Fatal("needInitContinuation() should be true when mutual auth is enabled")
	}
}

// guardInitialToken：初始 AP-REQ 发出后，go-ldap 的 bind 循环在服务端直接
// Bind-OK（无 continuation token）时会再次以空输入调用 InitSecContext——
// 必须拒绝（fail-closed），否则循环会重新取票重发 bind 无限挂死。
func TestGuardInitialTokenRefusesRestart(t *testing.T) {
	client := &Client{}
	if err := client.guardInitialToken(); err != nil {
		t.Fatalf("first initial token must proceed: %v", err)
	}
	if err := client.guardInitialToken(); err == nil {
		t.Fatal("empty-input re-entry after initial AP-REQ must fail: mutual-auth continuation is impossible")
	}
	if err := client.DeleteSecContext(); err != nil {
		t.Fatalf("DeleteSecContext: %v", err)
	}
	if err := client.guardInitialToken(); err != nil {
		t.Fatalf("DeleteSecContext must reset the guard: %v", err)
	}
}
