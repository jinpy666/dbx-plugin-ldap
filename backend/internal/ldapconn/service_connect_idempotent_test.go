package ldapconn

// service_connect_idempotent_test.go：2026-09-30 审查修复的回归测试。
// H-B1：同配置重复 Connect 必须是无操作（保留条目/在跑连接/schema 缓存），
// 配置或凭据变化才替换并失效。M-B1：WithConnOnce（写路径）对可重连错误
// 不自动重试（at-most-once），WithConn（读路径）保留重连一次语义。

import (
	"context"
	"errors"
	"io"
	"testing"

	ldap "github.com/go-ldap/ldap/v3"

	"io.dbx.ldap.plugin/internal/lifecycle"
)

// connectParams 构造最小 simple 认证 lifecycle.Params。
func connectParams(id string) *lifecycle.Params {
	return &lifecycle.Params{
		Connection: lifecycle.Connection{
			ID:   id,
			Name: "conn-" + id,
			Host: "ldap.example.com",
			ExternalConfig: map[string]any{
				"auth_type": "simple",
				"bind_dn":   "cn=admin,dc=example,dc=com",
				"base_dn":   "dc=example,dc=com",
				"tls_mode":  "none",
			},
			Secrets: map[string]any{"bind_password": "s3cret"},
		},
		Runtime: lifecycle.Runtime{Host: "ldap.example.com", Port: 389},
	}
}

// 同配置重放 connect（宿主桥接的 MCP 调用每次都带 lifecycle）是无操作：
// 条目不替换、在跑连接不断、schema 缓存不失效（审查 H-B1：此前无条件
// 替换会让每次工具调用杀掉全部搜索游标并清空 10 分钟 schema 缓存）。
func TestConnectSameConfigIsNoOp(t *testing.T) {
	s := NewService()
	if err := s.Connect(connectParams("c1")); err != nil {
		t.Fatalf("first connect: %v", err)
	}
	entry := s.lookup("c1")
	entry.mu.Lock()
	entry.conn = newPipeConn(t)
	entry.mu.Unlock()
	s.schemaCache().Put("c1", LDAPSchemaMetadata{SubschemaSubentry: "cn=subschema"})

	if err := s.Connect(connectParams("c1")); err != nil {
		t.Fatalf("reconnect same config: %v", err)
	}
	if s.lookup("c1") != entry {
		t.Errorf("entry was replaced on same-config reconnect")
	}
	entry.mu.Lock()
	conn := entry.conn
	entry.mu.Unlock()
	if conn == nil {
		t.Errorf("live conn was closed on same-config reconnect")
	}
	if s.schemaCache().Get("c1") == nil {
		t.Errorf("schema cache was invalidated on same-config reconnect")
	}
}

// 配置变化（base_dn）的重注册保持原语义：替换条目、断开旧连接、失效缓存。
func TestConnectChangedConfigReplacesEntryAndInvalidates(t *testing.T) {
	s := NewService()
	if err := s.Connect(connectParams("c1")); err != nil {
		t.Fatalf("first connect: %v", err)
	}
	entry := s.lookup("c1")
	entry.mu.Lock()
	entry.conn = newPipeConn(t)
	entry.mu.Unlock()
	s.schemaCache().Put("c1", LDAPSchemaMetadata{SubschemaSubentry: "cn=subschema"})

	changed := connectParams("c1")
	changed.Connection.ExternalConfig["base_dn"] = "dc=other,dc=com"
	if err := s.Connect(changed); err != nil {
		t.Fatalf("reconnect changed config: %v", err)
	}
	if s.lookup("c1") == entry {
		t.Errorf("entry must be replaced when config changes")
	}
	if got := s.schemaCache().Get("c1"); got != nil {
		t.Errorf("schema cache must be invalidated when config changes")
	}
	entry.mu.Lock()
	closed := entry.conn == nil
	entry.mu.Unlock()
	if !closed {
		t.Errorf("old conn must be closed when config changes")
	}
}

// 凭据变化的重注册同样替换（bind_password 换了 = 换了身份）。
func TestConnectChangedSecretReplacesEntry(t *testing.T) {
	s := NewService()
	if err := s.Connect(connectParams("c1")); err != nil {
		t.Fatalf("first connect: %v", err)
	}
	old := s.lookup("c1")

	changed := connectParams("c1")
	changed.Connection.Secrets["bind_password"] = "other-s3cret"
	if err := s.Connect(changed); err != nil {
		t.Fatalf("reconnect changed secret: %v", err)
	}
	if s.lookup("c1") == old {
		t.Errorf("entry must be replaced when bind secret changes")
	}
}

// 读路径（WithConn）保留断线重连一次：fn 第二次成功即整体成功。
func TestWithConnRetriesOnceOnReconnectableError(t *testing.T) {
	s := NewService()
	registerCheckEntry(t, s, "c1", false)
	dials := 0
	s.connectDialFn = func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
		dials++
		return newPipeConn(t), nil
	}
	calls := 0
	err := s.WithConn(context.Background(), "c1", func(*ldap.Conn) error {
		calls++
		if calls == 1 {
			return io.EOF
		}
		return nil
	})
	if err != nil {
		t.Fatalf("WithConn err = %v", err)
	}
	if calls != 2 || dials != 2 {
		t.Errorf("calls/dials = %d/%d, want 2/2 (retry once after reconnect)", calls, dials)
	}
}

// 写路径（WithConnOnce，M-B1）：可重连错误只关死连接并上抛，fn 不重试、
// 不重拨——重试会把服务端可能已应用的写入重放（响应包丢失场景）。
func TestWithConnOnceDoesNotRetryOnReconnectableError(t *testing.T) {
	s := NewService()
	registerCheckEntry(t, s, "c1", false)
	dials := 0
	s.connectDialFn = func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
		dials++
		return newPipeConn(t), nil
	}
	calls := 0
	err := s.WithConnOnce(context.Background(), "c1", func(*ldap.Conn) error {
		calls++
		return io.EOF
	})
	if !errors.Is(err, io.EOF) {
		t.Fatalf("WithConnOnce err = %v, want io.EOF surfaced", err)
	}
	if calls != 1 {
		t.Errorf("fn invoked %d times, want 1 (no write replay)", calls)
	}
	if dials != 1 {
		t.Errorf("dials = %d, want 1 (dead conn closed, no auto redial)", dials)
	}
	entry := s.lookup("c1")
	entry.mu.Lock()
	conn := entry.conn
	entry.mu.Unlock()
	if conn != nil {
		t.Errorf("dead conn must be closed (entry.conn = nil), got live conn")
	}
}
