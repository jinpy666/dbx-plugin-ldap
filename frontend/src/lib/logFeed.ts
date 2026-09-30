// 请求日志流数据面：工作台对 sidecar `ldap/log` 事件（请求级 + 连接生命周期，
// 契约见 backend/internal/logbuf Entry）的日志面板记录。纯函数实现便于单测，
// 组件（LogPanelView.vue）只持有列表并调用 push。
// 与 auditFeed 的差异：日志面板是 VSCode Output 语义——时间轴正序（新条目追加
// 到尾部）、以 sidecar 单调 seq 做增量游标（tail 回填）、容量 1000 与后端环形
// 缓冲一致。

export type LogLevel = "info" | "warn" | "error";
export type LogResult = "ok" | "denied" | "error";

export interface LogFeedItem {
  /** sidecar 单调递增序号（进程内唯一），兼作列表 key 与 tail 游标。 */
  seq: number;
  /** sidecar 记录时间（unix ms；非法值回退本地到达时间）。 */
  at: number;
  level: LogLevel;
  /** 请求方法名（ldap/search）或生命周期动作（connect/reconnect/disconnect）。 */
  method: string;
  connectionId?: string;
  /** 目标摘要：请求为 DN/base DN，生命周期为 host:port。 */
  target?: string;
  /** 补充摘要（scope/filter/tool/错误消息），已由后端截断且不含敏感值。 */
  detail?: string;
  result: LogResult;
  /** 请求耗时毫秒（生命周期条目缺省）。 */
  durationMs?: number;
  /** 来源：ui | mcp | system。 */
  source?: string;
}

export const LOG_FEED_MAX = 1000;

export function normalizeLogLevel(value: unknown): LogLevel {
  return value === "warn" || value === "error" ? value : "info";
}

// 与 audit 同词汇：ok/denied 原样保留，未知取值保守折算为 error（可见即告警，
// 不静默吞掉），同 auditFeed.normalizeAuditResult 的取向。
export function normalizeLogResult(value: unknown): LogResult {
  return value === "ok" || value === "denied" ? value : "error";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// 事件 params（与后端 logbuf.Entry JSON 同面）→ 展示条目。seq 非法（缺失/
// 非正数）返回 undefined——没有游标的条目无法参与增量回填，宁可丢弃也不
// 让游标回退造成重复。
export function parseLogEvent(params: unknown, nowMs: number): LogFeedItem | undefined {
  const source = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const seq = source.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq <= 0) return undefined;
  const durationMs =
    typeof source.durationMs === "number" && Number.isFinite(source.durationMs) && source.durationMs > 0
      ? source.durationMs
      : undefined;
  const at = typeof source.at === "number" && Number.isFinite(source.at) && source.at > 0 ? source.at : Number.isFinite(nowMs) ? nowMs : Date.now();
  return {
    seq,
    at,
    level: normalizeLogLevel(source.level),
    method: typeof source.method === "string" && source.method ? source.method : "ldap",
    ...(optionalText(source.connectionId) ? { connectionId: source.connectionId as string } : {}),
    ...(optionalText(source.target) ? { target: source.target as string } : {}),
    ...(optionalText(source.detail) ? { detail: source.detail as string } : {}),
    result: normalizeLogResult(source.result),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(optionalText(source.source) ? { source: source.source as string } : {}),
  };
}

// 新事件追加到尾部（时间轴正序）；超出上限从头部裁剪（最旧丢弃）。
export function pushLogItem(items: LogFeedItem[], item: LogFeedItem, max = LOG_FEED_MAX): LogFeedItem[] {
  const next = [...items, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

// tail 回填：把历史条目按 seq 升序合并到现有列表（跳过已存在的 seq），
// 仍受 LOG_FEED_MAX 裁剪。面板重开时后端 ring 可能已滚动，天然去重。
export function mergeLogTail(items: LogFeedItem[], tail: LogFeedItem[], max = LOG_FEED_MAX): LogFeedItem[] {
  const known = new Set(items.map((item) => item.seq));
  const merged = [...items];
  for (const item of [...tail].sort((a, b) => a.seq - b.seq)) {
    if (known.has(item.seq)) continue;
    known.add(item.seq);
    merged.push(item);
  }
  merged.sort((a, b) => a.seq - b.seq);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

// 增量游标：已见最大 seq（ldap/log/tail 的 after 语义 = seq > after）。
export function nextLogCursor(items: LogFeedItem[]): number {
  let cursor = 0;
  for (const item of items) if (item.seq > cursor) cursor = item.seq;
  return cursor;
}

export interface LogFeedFilter {
  /** "all" 或具体级别。 */
  level: "all" | LogLevel;
  /** "all" 或具体 connectionId。 */
  connectionId: "all" | string;
  /** 大小写不敏感子串，匹配 method/target/detail/connectionId。 */
  query: string;
}

export function filterLogItems(items: LogFeedItem[], filter: LogFeedFilter): LogFeedItem[] {
  const query = filter.query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter.level !== "all" && item.level !== filter.level) return false;
    if (filter.connectionId !== "all" && item.connectionId !== filter.connectionId) return false;
    if (query) {
      const haystack = `${item.method} ${item.target ?? ""} ${item.detail ?? ""} ${item.connectionId ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

// 面板连接下拉的选项源（保持首次出现顺序，稳定性优于字典序）。
export function collectConnectionIds(items: LogFeedItem[]): string[] {
  const seen: string[] = [];
  for (const item of items) {
    if (item.connectionId && !seen.includes(item.connectionId)) seen.push(item.connectionId);
  }
  return seen;
}

// 复制用单行格式（同面板行内信息）。
export function formatLogLine(item: LogFeedItem, timeLabel: string): string {
  const parts = [
    timeLabel,
    `[${item.level}]`,
    item.method,
    item.target ?? "",
    item.detail ?? "",
    item.durationMs ? `${item.durationMs}ms` : "",
  ].filter((part) => part !== "");
  return parts.join(" ");
}

// 本地时间 HH:MM:SS；跨天条目加 MM-DD 前缀（语义同 auditFeed.formatAuditTime，
// 独立导出避免日志面板反向依赖审计模块）。
export function formatLogTime(at: number, nowMs = Date.now()): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  return date.toDateString() === now.toDateString() ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
