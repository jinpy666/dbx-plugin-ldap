/**
 * Active Directory FILETIME（Interval / LargeInteger 时间属性）转换（纯函数）。
 *
 * FILETIME = 自 1601-01-01 UTC 起 100 纳秒间隔数（有符号 64 位十进制串）。
 * 行为对齐 Apache Directory Studio ActiveDirectoryTimeValueEditor：
 * - "0" 特殊值不渲染日期（显示「未设置」）；
 * - 展示「人类可读时间（原始值）」并列，存储保持原始串；
 * - 空值/非法值如实降级，不伪造日期。
 * 参考换算：Microsoft「Convert AD date/time attributes」文档。
 */

/** 1601-01-01 UTC 与 1970-01-01 UTC 的毫秒差。 */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;

/** INT64_MAX：AD 语义上的「永不」（如 accountExpires）。 */
export const FILETIME_MAX = "9223372036854775807";

/** 整数十进制串（允许 +/-，允许前后空白）。 */
const INTEGER_RE = /^[+-]?\d+$/;

export function isFiletimeShape(value: string): boolean {
  return INTEGER_RE.test(String(value ?? "").trim());
}

/** FILETIME 串 → UTC Date；非法/越界返回 null。 */
export function filetimeToDate(value: string): Date | null {
  const text = String(value ?? "").trim();
  if (!INTEGER_RE.test(text)) return null;
  try {
    const intervals = BigInt(text);
    const ms = intervals / 10_000n - FILETIME_EPOCH_OFFSET_MS;
    // 超出 Date 安全范围（约 ±8.64e15 ms）不渲染
    if (ms > 8_640_000_000_000_000n || ms < -8_640_000_000_000_000n) return null;
    return new Date(Number(ms));
  } catch {
    return null;
  }
}

/** Date → FILETIME 十进制串。 */
export function dateToFiletime(date: Date): string {
  const ms = BigInt(date.getTime()) + FILETIME_EPOCH_OFFSET_MS;
  return (ms * 10_000n).toString();
}

/** ADS 对齐的特殊值语义；非哨兵返回 null。 */
export function filetimeSentinelLabel(value: string, labels: { notSet: string; never: string }): string | null {
  const text = String(value ?? "").trim();
  if (text === "0") return labels.notSet;
  if (text === FILETIME_MAX || text === "-1") return labels.never;
  return null;
}

/**
 * FILETIME → 预览文本：哨兵值显示语义标签；普通值显示「本地时间 (原始值)」；
 * 非法值返回空串（编辑器另有错误提示）。
 */
export function filetimeDisplay(value: string, labels: { notSet: string; never: string }): string {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  const sentinel = filetimeSentinelLabel(text, labels);
  if (sentinel) return sentinel;
  const date = filetimeToDate(text);
  if (!date) return "";
  return `${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })} (${text})`;
}
