package ldapconn

// check_test.go：ldap/check 单测。约束：真网络拨号与真目录往返不可进单测
// （不起容器）——Service.checkDialFn / checkProbeFn 注入 stub；"活跃会话"
// 用 net.Pipe + go-ldap NewConn 造占位连接（不 Start、不读写，仅验证指针
// 传递与生命周期）。

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	ldap "github.com/go-ldap/ldap/v3"
)

// registerCheckEntry 直接向连接表塞一条条目（绕过 lifecycle：check 单测只
// 关心连接表既有状态，connect/解析路径在别处已覆盖）。withConn=true 时给
// 条目挂一个占位会话。
func registerCheckEntry(t *testing.T, s *Service, id string, withConn bool) *connEntry {
	t.Helper()
	entry := &connEntry{
		profile: Profile{ID: id, URL: "ldap://ldap.example.com", AuthType: LDAPAuthSimple, TimeoutSeconds: 5},
		target:  connTarget{Host: "ldap.example.com", Port: 389},
		status:  "idle",
	}
	if withConn {
		entry.conn = newPipeConn(t)
	}
	s.mu.Lock()
	s.conns[id] = entry
	s.mu.Unlock()
	return entry
}

// newPipeConn 用 net.Pipe 两端造一个 go-ldap 占位连接：一端交给 ldap.Conn，
// 另一端悬空，测试结束时统一关闭。必须调用 Start()：Conn.Close() 要等
// processMessages goroutine 回 chanConfirm，不 Start 且 requestTimeout=0 时
// Close 会永久阻塞（test 超时 600s 的教训）；此处无人写管道，Start 无竞态。
func newPipeConn(t *testing.T) *ldap.Conn {
	t.Helper()
	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	conn := ldap.NewConn(client, false)
	conn.Start()
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// stubDialSuccess 返回拨号成功的注入 stub：返回 net.Pipe 占位连接（checkDial
// 会立即 Close，清理由 newPipeConn 的 Cleanup 兜底）。
func stubDialSuccess(t *testing.T) func(Profile, connTarget, time.Duration) (*ldap.Conn, error) {
	return func(Profile, connTarget, time.Duration) (*ldap.Conn, error) {
		return newPipeConn(t), nil
	}
}

func TestNormalizeCheckLevel(t *testing.T) {
	cases := []struct {
		in   string
		want string
		err  string
	}{
		{in: "", want: checkLevelBind}, // 缺省 = 两段都做
		{in: "bind", want: checkLevelBind},
		{in: " BIND ", want: checkLevelBind},
		{in: "network", want: checkLevelNetwork},
		{in: "Network", want: checkLevelNetwork},
		{in: "trace", err: "unsupported check level"},
		{in: "network,bind", err: "unsupported check level"},
	}
	for _, testCase := range cases {
		got, err := normalizeCheckLevel(testCase.in)
		if testCase.err != "" {
			if err == nil || !strings.Contains(err.Error(), testCase.err) {
				t.Errorf("normalizeCheckLevel(%q) err = %v, want contains %q", testCase.in, err, testCase.err)
			}
			continue
		}
		if err != nil {
			t.Errorf("normalizeCheckLevel(%q) unexpected err: %v", testCase.in, err)
			continue
		}
		if got != testCase.want {
			t.Errorf("normalizeCheckLevel(%q) = %q, want %q", testCase.in, got, testCase.want)
		}
	}
}

// 未知 connectionId（连接表无条目）= 入口错误：走 error 通道（桥层折算
// 业务错误），不产出 ok:false 包络。
func TestCheckUnknownConnectionIsEntryError(t *testing.T) {
	s := NewService()
	result, err := s.Check(context.Background(), LDAPCheckRequest{ConnectionID: "missing"})
	if err == nil || !strings.Contains(err.Error(), "not connected") {
		t.Fatalf("Check unknown connection err = %v, want not-connected entry error", err)
	}
	if result.OK || result.Network.OK || result.Bind.OK {
		t.Fatalf("Check unknown connection should return zero envelope, got %+v", result)
	}
}

// network 段失败：bind 段不执行（{ok:false,skipped:true}），顶层 ok=false，
// 结果不占 error 通道。
func TestCheckNetworkFailureSkipsBind(t *testing.T) {
	s := NewService()
	registerCheckEntry(t, s, "c1", false)
	s.checkDialFn = func(Profile, connTarget, time.Duration) (*ldap.Conn, error) {
		return nil, errors.New("dial tcp: connection refused")
	}
	result, err := s.Check(context.Background(), LDAPCheckRequest{ConnectionID: "c1"})
	if err != nil {
		t.Fatalf("Check returned err %v, want envelope only", err)
	}
	if result.OK {
		t.Errorf("result.ok = true, want false")
	}
	if result.Network.OK || !strings.Contains(result.Network.Error, "connection refused") {
		t.Errorf("network segment = %+v, want ok=false with dial error", result.Network)
	}
	if result.Network.LatencyMs != nil {
		t.Errorf("network.latencyMs should be absent on failure, got %d", *result.Network.LatencyMs)
	}
	if result.Bind.OK || !result.Bind.Skipped || result.Bind.Error != "" {
		t.Errorf("bind segment = %+v, want {ok:false, skipped:true} without error", result.Bind)
	}
}

// level=network 只覆盖 network 段：bind 段以 skipped 标记且探活 stub 不得
// 被调用；顶层 ok 只看 network。
func TestCheckLevelNetworkOnly(t *testing.T) {
	s := NewService()
	registerCheckEntry(t, s, "c1", true)
	var gotTimeout time.Duration
	s.checkDialFn = func(_ Profile, _ connTarget, timeout time.Duration) (*ldap.Conn, error) {
		gotTimeout = timeout
		return newPipeConn(t), nil
	}
	s.checkProbeFn = func(*ldap.Conn) error {
		t.Errorf("checkProbeFn must not run at level=network")
		return nil
	}
	result, err := s.Check(context.Background(), LDAPCheckRequest{ConnectionID: "c1", Level: "network"})
	if err != nil {
		t.Fatalf("Check returned err %v, want envelope only", err)
	}
	if !result.OK || !result.Network.OK || result.Network.LatencyMs == nil {
		t.Errorf("result = %+v, want ok with network latency", result)
	}
	if gotTimeout <= 0 || gotTimeout > checkNetworkTimeout {
		t.Errorf("dial timeout = %v, want in (0, %v]", gotTimeout, checkNetworkTimeout)
	}
	if result.Bind.OK || !result.Bind.Skipped {
		t.Errorf("bind segment = %+v, want {ok:false, skipped:true} when only network covered", result.Bind)
	}
}

// bind 段无活跃会话（connect 过但从未建连，status idle）：报
// {"ok":false,"error":"not connected"}，禁止静默自动建连。
func TestCheckBindWithoutSession(t *testing.T) {
	s := NewService()
	registerCheckEntry(t, s, "c1", false)
	s.checkDialFn = stubDialSuccess(t)
	s.checkProbeFn = func(*ldap.Conn) error {
		t.Errorf("checkProbeFn must not run without an active session")
		return nil
	}
	result, err := s.Check(context.Background(), LDAPCheckRequest{ConnectionID: "c1"}) // 缺省 level=bind
	if err != nil {
		t.Fatalf("Check returned err %v, want envelope only", err)
	}
	if result.OK {
		t.Errorf("result.ok = true, want false")
	}
	if !result.Network.OK || result.Network.LatencyMs == nil {
		t.Errorf("network segment = %+v, want ok with latency", result.Network)
	}
	if result.Bind.OK || result.Bind.Skipped || result.Bind.Error != "not connected" {
		t.Errorf("bind segment = %+v, want {ok:false, error:\"not connected\"}", result.Bind)
	}
}

// bind 段有活跃会话：探活 stub 收到的正是连接表里的 conn；探活成功则两段
// 全绿、顶层 ok=true。
func TestCheckBindWithSessionOK(t *testing.T) {
	s := NewService()
	entry := registerCheckEntry(t, s, "c1", true)
	s.checkDialFn = stubDialSuccess(t)
	var probed *ldap.Conn
	s.checkProbeFn = func(conn *ldap.Conn) error {
		probed = conn
		return nil
	}
	result, err := s.Check(context.Background(), LDAPCheckRequest{ConnectionID: "c1"})
	if err != nil {
		t.Fatalf("Check returned err %v, want envelope only", err)
	}
	if !result.OK || !result.Network.OK || !result.Bind.OK {
		t.Errorf("result = %+v, want all segments ok", result)
	}
	if probed != entry.conn {
		t.Errorf("probe ran on %v, want the session stored in the connection table", probed)
	}
	if result.Bind.Error != "" || result.Bind.Skipped {
		t.Errorf("bind segment = %+v, want plain ok", result.Bind)
	}
}

// bind 段会话探活失败（会话已死）：bind 段携带底层错误，顶层 ok=false。
func TestCheckBindProbeError(t *testing.T) {
	s := NewService()
	registerCheckEntry(t, s, "c1", true)
	s.checkDialFn = stubDialSuccess(t)
	s.checkProbeFn = func(*ldap.Conn) error { return errors.New("ldap: connection closed") }
	result, err := s.Check(context.Background(), LDAPCheckRequest{ConnectionID: "c1"})
	if err != nil {
		t.Fatalf("Check returned err %v, want envelope only", err)
	}
	if result.OK {
		t.Errorf("result.ok = true, want false")
	}
	if !result.Network.OK || result.Network.LatencyMs == nil {
		t.Errorf("network segment = %+v, want ok with latency", result.Network)
	}
	if result.Bind.OK || !strings.Contains(result.Bind.Error, "connection closed") {
		t.Errorf("bind segment = %+v, want ok=false with probe error", result.Bind)
	}
}

// 出参 envelope 形状：成功态只有 ok/latencyMs；跳过态只有 ok:false+skipped，
// error 缺省不出现（契约字段白名单）。
func TestLDAPCheckResultJSONEnvelope(t *testing.T) {
	latency := 12
	success, err := json.Marshal(LDAPCheckResult{
		OK:      true,
		Network: LDAPCheckSegment{OK: true, LatencyMs: &latency},
		Bind:    LDAPCheckSegment{OK: true},
	})
	if err != nil {
		t.Fatalf("marshal success envelope: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(success, &doc); err != nil {
		t.Fatalf("unmarshal success envelope: %v", err)
	}
	if len(doc) != 3 {
		t.Errorf("top-level keys = %v, want exactly ok/network/bind", doc)
	}
	network, _ := doc["network"].(map[string]any)
	if network["latencyMs"] != float64(12) || len(network) != 2 {
		t.Errorf("network keys = %v, want exactly ok+latencyMs", network)
	}
	bind, _ := doc["bind"].(map[string]any)
	if bind["ok"] != true || len(bind) != 1 {
		t.Errorf("bind keys = %v, want exactly ok", bind)
	}

	skipped, err := json.Marshal(LDAPCheckResult{
		OK:      false,
		Network: LDAPCheckSegment{OK: false, Error: "boom"},
		Bind:    LDAPCheckSegment{OK: false, Skipped: true},
	})
	if err != nil {
		t.Fatalf("marshal skipped envelope: %v", err)
	}
	doc = nil
	if err := json.Unmarshal(skipped, &doc); err != nil {
		t.Fatalf("unmarshal skipped envelope: %v", err)
	}
	network, _ = doc["network"].(map[string]any)
	if network["error"] != "boom" || len(network) != 2 {
		t.Errorf("network keys = %v, want exactly ok+error", network)
	}
	bind, _ = doc["bind"].(map[string]any)
	if bind["skipped"] != true || len(bind) != 2 {
		t.Errorf("bind keys = %v, want exactly ok+skipped", bind)
	}
}
