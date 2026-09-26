package ldapconn

// service_connect_test.go：WithConn/connectLocked 惰性建连与断线重连路径的
// 单测（2026-09-26 审查 L1）。约束与 check_test.go/dedicated_conn_test.go
// 一致——真网络拨号不可进单测，Service.connectDialFn 注入 stub；占位连接
// 用 net.Pipe + go-ldap NewConn 造。覆盖：正常惰性建连装进连接表 / 条目在
// 拨号前已被移出表则不拨号 / 条目在拨号期间被移出表则关闭刚拨的连接并
// 放弃（防 fd 泄漏）。

import (
	"context"
	"net"
	"testing"

	ldap "github.com/go-ldap/ldap/v3"
)

// 惰性建连正常路径：fn 跑在 connectDialFn 拨出的连接上，且该连接装回连接
// 表条目（entry.conn），状态转 connected。
func TestWithConnLazilyConnectsAndInstallsConn(t *testing.T) {
	s := NewService()
	entry := registerCheckEntry(t, s, "c1", false)
	fresh := newPipeConn(t)
	s.connectDialFn = func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
		return fresh, nil
	}

	var fnConn *ldap.Conn
	err := s.WithConn(context.Background(), "c1", func(conn *ldap.Conn) error {
		fnConn = conn
		return nil
	})
	if err != nil {
		t.Fatalf("WithConn err = %v", err)
	}
	if fnConn != fresh || entry.conn != fresh {
		t.Errorf("fn/entry.conn = %v/%v, want the freshly dialed conn", fnConn, entry.conn)
	}
	entry.mu.Lock()
	status := entry.status
	entry.mu.Unlock()
	if status != "connected" {
		t.Errorf("status = %q, want connected", status)
	}
}

// 前置身份检查：条目已被并发 Disconnect 移出连接表（拨号前发现），不发起
// 拨号，直接返回可重试错误。
func TestConnectLockedSkipsDialWhenEntryAlreadyDetached(t *testing.T) {
	s := NewService()
	entry := registerCheckEntry(t, s, "c1", false)
	s.mu.Lock()
	delete(s.conns, "c1") // 模拟 Disconnect 已完成移除
	s.mu.Unlock()
	s.connectDialFn = func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
		t.Errorf("connectDialFn must not run for a detached entry")
		return nil, nil
	}

	err := s.connectLocked(context.Background(), entry)
	if err == nil || err.Error() != errEntryDetached("c1").Error() {
		t.Fatalf("connectLocked err = %v, want detached-entry error", err)
	}
	if entry.conn != nil {
		t.Errorf("entry.conn = %v, want nil (no connection installed)", entry.conn)
	}
}

// 拨号后身份双检（L1 核心）：条目在拨号期间被移出表（Disconnect 不等
// entry.mu），刚拨出的连接必须立即关闭而非装进孤儿条目——装进去就永久
// 泄漏 fd（连接表已无该条目，无人负责关闭）。
func TestConnectLockedClosesFreshConnWhenEntryDetachedAfterDial(t *testing.T) {
	s := NewService()
	entry := registerCheckEntry(t, s, "c1", false)
	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	fresh := ldap.NewConn(client, false)
	fresh.Start()
	t.Cleanup(func() { _ = fresh.Close() })
	s.connectDialFn = func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
		// 拨号期间 Disconnect 完成移除（真实路径还会 closeLocked 旧会话，
		// 此处旧会话为 nil，只关注连接表身份）。
		s.mu.Lock()
		delete(s.conns, "c1")
		s.mu.Unlock()
		return fresh, nil
	}

	err := s.connectLocked(context.Background(), entry)
	if err == nil || err.Error() != errEntryDetached("c1").Error() {
		t.Fatalf("connectLocked err = %v, want detached-entry error", err)
	}
	if entry.conn != nil {
		t.Errorf("entry.conn = %v, want nil (fresh conn must not be installed into a detached entry)", entry.conn)
	}
	// 对端读到 EOF 才证明刚拨出的连接确实被关闭（fd 未泄漏）。
	pipeReadEOF(t, server)
}
