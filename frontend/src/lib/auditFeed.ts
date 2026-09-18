// 审计事件流数据面：工作台对 sidecar `ldap/audit` 事件（ok/denied/error，
// 契约见 lib/api.ts LdapAuditEvent）的最近操作记录。纯函数实现便于单测，
// 组件（AuditFeedPanel.vue）只持有列表并调用 push。

export type AuditResult = "ok" | "denied" | "error";

export interface AuditFeedItem {
  id: number;
  action: string;
  target: string;
  result: AuditResult;
  at: number; // unix ms（本地事件到达时间，非服务器时间）
  detail?: string;
  /** 操作类型（F10，后端新增，如 "add"/"modify"/"delete"；旧事件缺省 → 键不出现）。 */
  operation?: string;
  /** 耗时毫秒（F10，后端新增；旧事件/非法值缺省 → 键不出现，展示按 >0 判定）。 */
  durationMs?: number;
}

export const AUDIT_FEED_MAX = 100;

export function normalizeAuditResult(value: unknown): AuditResult {
  return value === "ok" || value === "denied" ? value : "error";
}

// 事件 params（与后端 AuditRecord JSON 同面）→ 展示条目；缺省字段兜底，
// 未知 result 折算为 error（保守告警，不静默吞掉未知取值）。
// F10：operation/durationMs 为新增字段，旧事件没有——缺失或类型不符一律
// 视为无（同 detail 约定不产出键），绝不抛错。
export function parseAuditEvent(params: unknown, id: number, nowMs: number): AuditFeedItem {
  const source = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const detail = typeof source.detail === "string" && source.detail ? source.detail : undefined;
  const operation = typeof source.operation === "string" && source.operation ? source.operation : undefined;
  const durationMs =
    typeof source.durationMs === "number" && Number.isFinite(source.durationMs) && source.durationMs > 0
      ? source.durationMs
      : undefined;
  return {
    id,
    action: typeof source.action === "string" && source.action ? source.action : "ldap",
    target: typeof source.target === "string" ? source.target : "",
    result: normalizeAuditResult(source.result),
    at: Number.isFinite(nowMs) ? nowMs : Date.now(),
    ...(detail ? { detail } : {}),
    ...(operation ? { operation } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

// 最新事件插到头部；超出上限从尾部裁剪（最近操作语义，旧事件丢弃）。
export function pushAuditItem(items: AuditFeedItem[], item: AuditFeedItem, max = AUDIT_FEED_MAX): AuditFeedItem[] {
  const next = [item, ...items];
  return next.length > max ? next.slice(0, max) : next;
}

// 本地时间 HH:MM:SS；跨天事件加 MM-DD 前缀，避免陈旧条目误导。
export function formatAuditTime(at: number, nowMs = Date.now()): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  return date.toDateString() === now.toDateString() ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
