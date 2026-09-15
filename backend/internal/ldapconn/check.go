// check.go（L-A 路）：ldap/check 连接分级检查（对标 ADS 的 Check Network
// Parameter / 整体测试）：
//   - network 段：按 profile 的 host/port + TLS 语义全新短拨号，3s 超时，
//     成功报 latencyMs（毫秒取整）；
//   - bind 段：对既有活跃会话发一次 RootDSE base 读取验证存活。
//
// 只读安全：检查零目录写副作用、不发审计、不改写连接表状态（status/
// lastUsedAt 均不触碰）；bind 段绝不静默自动建连——这与 WithConn 的惰性
// 建连语义刻意相反，检查必须无副作用。
package ldapconn

import (
	"context"
	"fmt"
	"strings"
	"time"

	ldap "github.com/go-ldap/ldap/v3"
)

// checkNetworkTimeout 是 network 段全新拨号与 bind 段会话探活的统一上限：
// 检查入口要快，不能用连接配置缺省的 30s 长等。
const checkNetworkTimeout = 3 * time.Second

// level 取值：network 只做网络段；bind（缺省）= 整体测试，network 段先行、
// 成功后才探 bind。
const (
	checkLevelNetwork = "network"
	checkLevelBind    = "bind"
)

// LDAPCheckRequest 对应 ldap/check 入参（connectionId 必填；level 可选
// network|bind，缺省 = 两段都做）。
type LDAPCheckRequest struct {
	ConnectionID string `json:"connectionId"`
	Level        string `json:"level,omitempty"`
}

// LDAPCheckSegment 单段结果。LatencyMs 仅 network 段成功时出现；Skipped
// 表示该段未执行（network 失败被跳过，或请求只覆盖 network 段），skipped
// 时 ok 恒为 false 且不计入顶层 ok。
type LDAPCheckSegment struct {
	OK        bool   `json:"ok"`
	LatencyMs *int   `json:"latencyMs,omitempty"`
	Skipped   bool   `json:"skipped,omitempty"`
	Error     string `json:"error,omitempty"`
}

// LDAPCheckResult 对应 ldap/check 出参；顶层 ok = 本次请求覆盖的段全部
// 成功。
type LDAPCheckResult struct {
	OK      bool             `json:"ok"`
	Network LDAPCheckSegment `json:"network"`
	Bind    LDAPCheckSegment `json:"bind"`
}

// normalizeCheckLevel 归一化 level：空 = bind（整体两段）；大小写/空白容错；
// 非法值报错（经桥层折算业务错误，不让坏参数静默变成"两段都做"）。
func normalizeCheckLevel(level string) (string, error) {
	switch value := strings.ToLower(strings.TrimSpace(level)); value {
	case "":
		return checkLevelBind, nil
	case checkLevelNetwork:
		return checkLevelNetwork, nil
	case checkLevelBind:
		return checkLevelBind, nil
	default:
		return "", fmt.Errorf("unsupported check level %q (want \"network\" or \"bind\")", level)
	}
}

// Check 处理 ldap/check。connectionId 在连接表无条目（未 connect 过）返回
// 错误——那是入口错误，走业务错误通道而不是 ok:false 包络；检查结果本身
// （网络不通、会话失效等）一律在包络内表达，不占 error 通道。
func (s *Service) Check(ctx context.Context, req LDAPCheckRequest) (LDAPCheckResult, error) {
	level, err := normalizeCheckLevel(req.Level)
	if err != nil {
		return LDAPCheckResult{}, err
	}
	entry := s.lookup(req.ConnectionID)
	if entry == nil {
		return LDAPCheckResult{}, errConnectionNotFound(strings.TrimSpace(req.ConnectionID))
	}

	entry.mu.Lock()
	profile, target := entry.profile, entry.target
	hasSession := entry.conn != nil
	entry.mu.Unlock()

	// 成功路径为缺省：顶层 ok 与两段初始为 true，各失败分支显式翻 false。
	result := LDAPCheckResult{
		OK:      true,
		Network: LDAPCheckSegment{OK: true},
		Bind:    LDAPCheckSegment{OK: true},
	}

	// network 段：全新短拨号（拨完即关，不残留连接、不改连接表状态）。
	latencyMs, err := s.checkDial(ctx, profile, target)
	if err != nil {
		result.OK = false
		result.Network = LDAPCheckSegment{OK: false, Error: err.Error()}
		// network 失败时 bind 段不执行（契约：{"ok":false,"skipped":true}）。
		result.Bind = LDAPCheckSegment{OK: false, Skipped: true}
		return result, nil
	}
	result.Network.LatencyMs = &latencyMs

	if level == checkLevelNetwork {
		// 请求只覆盖 network 段：bind 未执行，同样以 skipped 标记，顶层 ok
		// 只看 network。
		result.Bind = LDAPCheckSegment{OK: false, Skipped: true}
		return result, nil
	}

	// bind 段：只验证既有会话；无会话按契约报 "not connected"。
	if !hasSession {
		result.OK = false
		result.Bind = LDAPCheckSegment{OK: false, Error: "not connected"}
		return result, nil
	}
	if err := s.checkProbe(entry); err != nil {
		result.OK = false
		result.Bind = LDAPCheckSegment{OK: false, Error: err.Error()}
		return result, nil
	}
	return result, nil
}

// checkDial 执行 network 段：3s 超时内全新拨号一次并返回毫秒延迟。
// ldap.DialURL 不感知 ctx，超时经 net.Dialer 期限生效；父 ctx 更紧时收缩
// 拨号窗口。
func (s *Service) checkDial(ctx context.Context, profile Profile, target connTarget) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, checkNetworkTimeout)
	defer cancel()
	timeout := checkNetworkTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining < timeout {
			timeout = remaining
		}
	}
	start := time.Now()
	conn, err := s.checkDialFn(profile, target, timeout)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	return int(time.Since(start).Milliseconds()), nil
}

// checkProbe 执行 bind 段：持 entry.mu 直接用既有 conn 探活（不经 WithConn
// ——它会惰性建连、断线重连，违反检查无副作用约束）。探活窗口收紧到
// checkNetworkTimeout，用完还原（WithConn 每次操作前会重设，还原只为不
// 留意外状态）。
func (s *Service) checkProbe(entry *connEntry) error {
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.conn == nil {
		// 双检：Check 开头的 hasSession 快照与加锁间隙可能被并发 disconnect
		// 关闭。
		return fmt.Errorf("not connected")
	}
	prevTimeout := time.Duration(entry.profile.TimeoutSeconds) * time.Second
	if prevTimeout <= 0 {
		prevTimeout = 30 * time.Second
	}
	entry.conn.SetTimeout(checkNetworkTimeout)
	defer entry.conn.SetTimeout(prevTimeout)
	return s.checkProbeFn(entry.conn)
}

// probeBindSession 对既有会话发一次 RootDSE base 读取验证存活（请求形状同
// readEntry 的 base 探测：scope=base、sizeLimit=1、filter=(objectClass=*)；
// dn="" 即 RootDSE，attributes=["1.1"] 最小流量）。
func probeBindSession(conn *ldap.Conn) error {
	_, err := conn.Search(ldap.NewSearchRequest(
		"",
		ldap.ScopeBaseObject,
		ldap.NeverDerefAliases,
		1,
		0,
		false,
		"(objectClass=*)",
		[]string{"1.1"}, // no attributes，只验证往返
		nil,
	))
	return err
}
