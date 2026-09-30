// Package logbuf 是请求级日志的进程内环形缓冲（会话级，不落盘——写操作落盘
// 已由 audit.jsonl 覆盖）。日志面板（io.dbx.ldap.logpanel）打开时经
// ldap/log/tail 回填增量，关闭期间缓冲持续滚动，重开不丢最近记录。
//
// 安全契约：Entry 只承载非敏感摘要（DN/base/filter 截断、结果码、耗时），
// 绑定密码、属性值与任何凭据绝不进入 Entry（与 connEntry.secrets 同一红线）。
package logbuf

import (
	"sync"
	"time"
)

// Entry 单条请求/生命周期日志（ldap/log 事件与 ldap/log/tail 同一形状）。
type Entry struct {
	// Seq 单调递增序号（进程内唯一），面板用它做 tail 游标。
	Seq uint64 `json:"seq"`
	// At 记录时间（unix ms，sidecar 时钟）。
	At int64 `json:"at"`
	// Level 级别：info | warn | error。
	Level string `json:"level"`
	// Method 请求方法名（ldap/search）或生命周期动作（connect/reconnect/disconnect）。
	Method string `json:"method"`
	// ConnectionID 所属宿主连接（空 = 无连接上下文）。
	ConnectionID string `json:"connectionId,omitempty"`
	// Target 目标摘要：请求为 DN/base DN，生命周期为 host:port。
	Target string `json:"target,omitempty"`
	// Detail 补充摘要（filter/scope/错误消息等），写入前须已截断且不含敏感值。
	Detail string `json:"detail,omitempty"`
	// Result 结果：ok | error | denied（与 audit 词汇一致）。
	Result string `json:"result"`
	// DurationMs 请求耗时毫秒（生命周期条目缺省）。
	DurationMs int64 `json:"durationMs,omitempty"`
	// Source 来源：ui | mcp | system（与 audit 的 Source 词汇对齐）。
	Source string `json:"source,omitempty"`
}

// DefaultMax 是缺省缓冲容量（条）；Tail(after, 0) 用同一上限。
const DefaultMax = 1000

// Buffer 定容环形缓冲；零值不可用，经 New 创建。全方法并发安全。
type Buffer struct {
	mu   sync.Mutex
	max  int
	seq  uint64
	buf  []Entry // 定长环；write 指向下一个写入槽
	next int
	full bool
}

// New 创建容量 max 的缓冲（max <= 0 取 DefaultMax）。
func New(max int) *Buffer {
	if max <= 0 {
		max = DefaultMax
	}
	return &Buffer{max: max, buf: make([]Entry, max)}
}

// Append 填充 Seq/At 后写入环；返回带序号的条目（供事件通道复用同一份数据）。
func (b *Buffer) Append(e Entry) Entry {
	b.mu.Lock()
	b.seq++
	e.Seq = b.seq
	e.At = time.Now().UnixMilli()
	b.buf[b.next] = e
	b.next = (b.next + 1) % b.max
	if b.next == 0 {
		b.full = true
	}
	b.mu.Unlock()
	return e
}

// Tail 返回 seq > after 的条目（最旧在前）；limit <= 0 时不超过缓冲容量。
// 面板打开/重开时以自身游标调用，实现增量回填。
func (b *Buffer) Tail(after uint64, limit int) []Entry {
	b.mu.Lock()
	defer b.mu.Unlock()
	if limit <= 0 || limit > b.max {
		limit = b.max
	}
	out := make([]Entry, 0, limit)
	// 环内最旧到最新遍历：full 时 write 位即最旧槽，从它转一圈；否则 [0, write)。
	start, count := 0, b.next
	if b.full {
		start, count = b.next, b.max
	}
	for i := 0; i < count && len(out) < limit; i++ {
		e := b.buf[(start+i)%b.max]
		if e.Seq > after {
			out = append(out, e)
		}
	}
	return out
}

// Len 返回当前缓冲条数。
func (b *Buffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.full {
		return b.max
	}
	return b.next
}
