/**
 * RFC 4517 GeneralizedTime 解析/格式化（纯函数）。
 *
 * 格式：`YYYYMMDDHHMM[SS][.f...][Z|±HHMM]`；秒与分数可省，时区缺省按
 * UTC 处理（LDAP 规范要求显式时区，这里对省略形态容错——部分服务器
 * 会发出无后缀值）。对齐 Apache Directory Studio GeneralizedTimeValueEditor
 * 的行为：显示人类可读时间，存储保持原始串。
 */

const SHAPE_RE =
  /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:[.,](\d+))?(Z|[+-]\d{2}(?:\d{2})?)?$/;

/**
 * 解析 GeneralizedTime 串为 UTC Date。非法/越界返回 null。
 * 分数秒仅接受毫秒精度（Date 精度上限），更长的小数截断。
 */
export function parseGeneralizedTime(value: string): Date | null {
  const text = String(value ?? "").trim();
  const match = SHAPE_RE.exec(text);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00", fraction, zone] = match;
  const milli = fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0;
  let offsetMinutes = 0;
  if (zone && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1);
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMins = digits.length >= 4 ? Number(digits.slice(2, 4)) : 0;
    if (offsetHours > 14 || offsetMins > 59) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  // 日历有效性用「未加时区偏移的墙上时钟」校验：偏移会让 UTC 日期字段
  // 跨日（如 02 日 03:04+0800 = 01 日 19:04 UTC），不能拿 UTC 字段反查。
  const wallMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milli);
  const wall = new Date(wallMs);
  if (
    wall.getUTCFullYear() !== Number(year) ||
    wall.getUTCMonth() !== Number(month) - 1 ||
    wall.getUTCDate() !== Number(day) ||
    wall.getUTCHours() !== Number(hour) ||
    wall.getUTCMinutes() !== Number(minute)
  ) {
    return null;
  }
  return new Date(wallMs - offsetMinutes * 60_000);
}

/** Date → GeneralizedTime（UTC、秒精度、Z 后缀）。 */
export function formatGeneralizedTime(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** 快速形态判断（不校验日历有效性；用于分流展示，不做语义判断）。 */
export function isGeneralizedTimeShape(value: string): boolean {
  return SHAPE_RE.test(String(value ?? "").trim());
}

/**
 * GeneralizedTime → 本地时区展示文本；解析失败返回空串。
 * 供 DatetimeValueEditor 的预览行使用。
 */
export function generalTimeDisplay(value: string): string {
  const date = parseGeneralizedTime(value);
  if (!date) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** datetime-local input 值（YYYY-MM-DDTHH:mm，本地时区）→ UTC Date。 */
export function parseDatetimeLocalValue(value: string): Date | null {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null;
  }
  return date;
}

/** UTC Date → datetime-local input 值（本地时区呈现，含秒：picker step=1
 *  需要完整时分秒字段，LDAP GeneralizedTime/FILETIME 本身也精确到秒）。 */
export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// -- 墙上时钟（timezone-aware picker）-----------------------------------------
// 选择器语义：显示原值自身的墙上时钟（所见即存储，不做时区换算），时区由
// 独立后缀承载（"Z" | "±HHMM" | ""），写回 = 墙上时钟 + 后缀。

export interface GeneralizedTimeWall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** "Z" | "±HHMM" | ""（无后缀容错形态，写回时原样保留）。 */
  zone: string;
}

/** 解析 GeneralizedTime 的墙上时钟与时区后缀（不换算时刻）；非法/越界返回 null。 */
export function parseGeneralizedTimeWall(value: string): GeneralizedTimeWall | null {
  const text = String(value ?? "").trim();
  const match = SHAPE_RE.exec(text);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00", , zone = ""] = match;
  // 日历有效性校验与 parseGeneralizedTime 同款：拿「未加偏移的 UTC 字段」反查。
  const wallMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const wall = new Date(wallMs);
  if (
    wall.getUTCFullYear() !== Number(year) ||
    wall.getUTCMonth() !== Number(month) - 1 ||
    wall.getUTCDate() !== Number(day) ||
    wall.getUTCHours() !== Number(hour) ||
    wall.getUTCMinutes() !== Number(minute)
  ) {
    return null;
  }
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    zone,
  };
}

/** 墙上时钟 + 时区后缀 → GeneralizedTime 串（全字段、秒精度）。 */
export function formatGeneralizedTimeWall(wall: GeneralizedTimeWall): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(wall.year, 4)}${pad(wall.month)}${pad(wall.day)}` +
    `${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}${wall.zone}`
  );
}

/** datetime-local 值 → 墙上时钟字段（无时区语义）；非法/越界返回 null。 */
export function parseDatetimeLocalWall(value: string): Omit<GeneralizedTimeWall, "zone"> | null {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const numbers = { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute), second: Number(second) };
  const wallMs = Date.UTC(numbers.year, numbers.month - 1, numbers.day, numbers.hour, numbers.minute, numbers.second);
  const wall = new Date(wallMs);
  if (
    wall.getUTCFullYear() !== numbers.year ||
    wall.getUTCMonth() !== numbers.month - 1 ||
    wall.getUTCDate() !== numbers.day
  ) {
    return null;
  }
  return numbers;
}

/** 浏览器本地时区的 ±HHMM 后缀（供时区选择器的「本地」选项）。 */
export function localTimeZoneSuffix(): string {
  const totalMinutes = -new Date().getTimezoneOffset();
  const sign = totalMinutes < 0 ? "-" : "+";
  const abs = Math.abs(totalMinutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.trunc(abs / 60))}${pad(abs % 60)}`;
}
