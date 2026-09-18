package ldapconn

// dedicated_conn_test.go（K-5）：withDedicatedConn 单测。约束与 check_test.go
// 一致——真网络拨号不可进单测，Service.dedicatedDialFn 注入 stub；独立连接
// 用 net.Pipe + go-ldap NewConn 造占位（fn 不做真实 LDAP 往返，只验证指针
// 传递与生命周期）。覆盖：独立建连复用（用完即关）/ dial 失败回退共享
// WithConn / 断线类错误重拨重试一次 / 非断线错误不重试 / 未知连接拒绝。

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	ldap "github.com/go-ldap/ldap/v3"
)

// dialStubRecord 记录 dedicatedDialFn 的调用形态（次数 + 返回的独立连接）。
type dialStubRecord struct {
	calls int
	conns []*ldap.Conn
}

// stubDialOK 返回恒成功的拨号 stub：每次调用给一根新 pipe 占位连接（重试
// 场景每次拨号必须是不同连接）。
func stubDialOK(t *testing.T, rec *dialStubRecord) func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
	return func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
		rec.calls++
		client, server := net.Pipe()
		t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
		conn := ldap.NewConn(client, false)
		conn.Start()
		t.Cleanup(func() { _ = conn.Close() })
		rec.conns = append(rec.conns, conn)
		return conn, nil
	}
}

// pipeReadEOF 阻塞等待 server 端读到 EOF（对端 Close 的信号），超时视为
// 独立连接未被关闭。
func pipeReadEOF(t *testing.T, server net.Conn) {
	t.Helper()
	errCh := make(chan error, 1)
	go func() {
		buf := make([]byte, 1)
		_, err := server.Read(buf)
		errCh <- err
	}()
	select {
	case err := <-errCh:
		if !errors.Is(err, io.EOF) {
			t.Errorf("pipe read after fn = %v, want io.EOF (dedicated conn closed)", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("dedicated conn was not closed after aggregate fn completed")
	}
}

// 独立建连成功：fn 跑在 stub 返回的独立连接上（不是连接表共享 conn），且
// 聚合完成后独立连接被无条件关闭（用完即关，不占共享互斥区/服务端资源）。
func TestWithDedicatedConnRunsOnStandaloneConnAndClosesIt(t *testing.T) {
	s := NewService()
	entry := registerCheckEntry(t, s, "c1", true)

	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	dialConn := ldap.NewConn(client, false)
	dialConn.Start()
	t.Cleanup(func() { _ = dialConn.Close() })
	dialCalls := 0
	s.dedicatedDialFn = func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
		dialCalls++
		return dialConn, nil
	}

	var fnConn *ldap.Conn
	err := s.withDedicatedConn(context.Background(), "c1", func(conn *ldap.Conn) error {
		fnConn = conn
		return nil
	})
	if err != nil {
		t.Fatalf("withDedicatedConn err = %v", err)
	}
	if dialCalls != 1 {
		t.Errorf("dedicated dial calls = %d, want 1", dialCalls)
	}
	if fnConn == nil || fnConn != dialConn {
		t.Errorf("fn ran on %v, want the dedicated dial conn", fnConn)
	}
	if fnConn == entry.conn {
		t.Errorf("fn must not run on the shared session conn")
	}
	pipeReadEOF(t, server)
}

// K-5 回退路径：独立拨号失败 → 回退共享连接（WithConn）执行同一 fn，fn
// 收到的正是连接表里的共享会话；fn 的返回值原样透传（真实错误面由共享路径给出）。
func TestWithDedicatedConnFallsBackToSharedOnDialFailure(t *testing.T) {
	s := NewService()
	entry := registerCheckEntry(t, s, "c1", true)
	s.dedicatedDialFn = func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
		return nil, errors.New("dial tcp: connection refused")
	}

	var fnConn *ldap.Conn
	boom := errors.New("boom from fn")
	err := s.withDedicatedConn(context.Background(), "c1", func(conn *ldap.Conn) error {
		fnConn = conn
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("fallback err = %v, want fn error passthrough", err)
	}
	if fnConn != entry.conn {
		t.Errorf("fn ran on %v, want the shared session conn (fallback path)", fnConn)
	}
}

// 断线类错误（io.EOF 命中 ldapNeedsReconnect）：重拨一次并重试，第二次
// 成功则整体成功（语义对齐 WithConn 的「断线重连一次」）。
func TestWithDedicatedConnRetriesOnceOnReconnectError(t *testing.T) {
	s := NewService()
	registerCheckEntry(t, s, "c1", true)
	rec := &dialStubRecord{}
	s.dedicatedDialFn = stubDialOK(t, rec)

	calls := 0
	err := s.withDedicatedConn(context.Background(), "c1", func(*ldap.Conn) error {
		calls++
		if calls == 1 {
			return io.EOF // 断线类错误
		}
		return nil
	})
	if err != nil {
		t.Fatalf("withDedicatedConn err = %v, want retry success", err)
	}
	if rec.calls != 2 {
		t.Errorf("dedicated dial calls = %d, want 2 (initial + retry)", rec.calls)
	}
	if calls != 2 {
		t.Errorf("fn calls = %d, want 2", calls)
	}
}

// 非断线类错误（如服务端结果码）：不重拨不重试，错误原样返回。
func TestWithDedicatedConnNonReconnectErrorNoRetry(t *testing.T) {
	s := NewService()
	registerCheckEntry(t, s, "c1", true)
	rec := &dialStubRecord{}
	s.dedicatedDialFn = stubDialOK(t, rec)

	boom := errors.New("ldap: result code 32 no such object")
	calls := 0
	err := s.withDedicatedConn(context.Background(), "c1", func(*ldap.Conn) error {
		calls++
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want original fn error", err)
	}
	if rec.calls != 1 || calls != 1 {
		t.Errorf("dial/fn calls = %d/%d, want 1/1 (no retry for non-reconnect errors)", rec.calls, calls)
	}
}

// 未知连接（连接表无条目）：入口错误直接返回，不发起独立拨号。
func TestWithDedicatedConnUnknownConnection(t *testing.T) {
	s := NewService()
	s.dedicatedDialFn = func(context.Context, Profile, connTarget, bindSecrets) (*ldap.Conn, error) {
		t.Errorf("dedicatedDialFn must not run for unknown connection")
		return nil, nil
	}
	err := s.withDedicatedConn(context.Background(), "missing", func(*ldap.Conn) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "not connected") {
		t.Fatalf("unknown conn err = %v, want not-connected", err)
	}
}
