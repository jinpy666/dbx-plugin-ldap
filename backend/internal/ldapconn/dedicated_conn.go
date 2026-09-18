// dedicated_conn.go（K-5 性能审计）：聚合型大读的独立短连接。
//
// 背景：WithConn（service.go）为统一断线重连/失败处理，对整个 fn 持连接级
// 互斥（entry.mu）。legacy 聚合 Search（客户端聚合上限缺省 500、sizeLimit
// 可达 5000，子树导出复用）与 ldap/count（计数上限 5000）执行期间，同一
// 连接的交互读（entry/get、childrenCount）与写全部排队（队头阻塞，慢链路
// 可达秒级）。
//
// 方案：对齐 search_sessions.go 的独立短连接模式（SearchStart 只短暂持
// entry.mu 拍快照，随后自行 dialProfile + bind，用完即关）——聚合请求每次
// 独立建一条连接，聚合完成后立即关闭，长聚合不再占用共享连接互斥区。
// 独立 dial 失败时回退共享连接路径（WithConn）保持可用性，并记一条
// NOTICE 日志（形态对齐 dial.go 的 Kerberos 88 端口回退日志）。
package ldapconn

import (
	"context"
	"log"
	"time"

	ldap "github.com/go-ldap/ldap/v3"
)

// withDedicatedConn 在一条独立短连接上执行 fn（调用方负责 fn 内不做长驻
// 状态依赖）。流程：
//  1. 短暂持 entry.mu 拍 profile/secrets/target 快照（对齐 SearchStart），
//     互斥区内不含任何网络往返；
//  2. dedicatedDialFn（缺省 dialProfile）独立建连（dial → StartTLS → bind），
//     失败则回退 s.WithConn 共享路径（可用性优先），真实错误面由共享路径给出；
//  3. fn 返回后无条件关闭连接；fn 失败且属断线类错误（ldapNeedsReconnect）
//     时重拨一次重试，语义对齐 WithConn 的「断线重连一次」。
//
// 与 WithConn 的差异（有意为之）：独立连接不回写 entry.status/lastError/
// lastUsedAt——SnapshotStatuses 描述的是共享连接本身，独立连接的瞬时失败
// 不应把共享连接标成 error（共享连接可能完全健康）。
func (s *Service) withDedicatedConn(ctx context.Context, connectionID string, fn func(conn *ldap.Conn) error) error {
	entry := s.lookup(connectionID)
	if entry == nil {
		return errConnectionNotFound(connectionID)
	}

	// 快照当前连接配置（SearchStart 同款）：只持 entry.mu 拷贝字段，
	// 凭据不落日志/审计。
	entry.mu.Lock()
	profile := entry.profile
	secrets := entry.secrets
	target := entry.target
	entry.mu.Unlock()

	requestCtx, cancel := contextWithTimeout(ctx, profile)
	defer cancel()

	conn, err := s.dedicatedDialFn(requestCtx, profile, target, secrets)
	if err != nil {
		// K-5 回退：独立拨号失败 → 共享连接路径保持可用；NOTICE 留观测点
		// （err 与 WithConn 的拨号失败同源，均不含凭据）。
		log.Printf("NOTICE: [dbx-plugin-ldap] dedicated aggregate dial failed for connection %q, falling back to shared connection: %v", connectionID, err)
		return s.WithConn(ctx, connectionID, fn)
	}

	// dialProfile 成功路径已设过同规则超时；stub 注入路径（单测）可能未设，
	// 这里统一再设一次（0 归一为 30s，避免 WithConn 的 0=无限等待面）。
	timeout := time.Duration(profile.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	conn.SetTimeout(timeout)

	err = fn(conn)
	_ = conn.Close() // 聚合完成即关：不占服务端分页/连接资源
	if err == nil {
		return nil
	}
	if !ldapNeedsReconnect(err) {
		return err
	}
	// 断线重连一次（语义对齐 WithConn service.go「断线重连」段）。
	retryConn, dialErr := s.dedicatedDialFn(requestCtx, profile, target, secrets)
	if dialErr != nil {
		return dialErr
	}
	defer retryConn.Close()
	return fn(retryConn)
}
