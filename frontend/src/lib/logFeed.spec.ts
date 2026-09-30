// 请求日志流纯函数单测（LogPanelView 数据面依赖）。
import { describe, expect, it } from "vitest";
import {
  LOG_FEED_MAX,
  collectConnectionIds,
  filterLogItems,
  formatLogLine,
  formatLogTime,
  mergeLogTail,
  nextLogCursor,
  parseLogEvent,
  pushLogItem,
  type LogFeedItem,
} from "./logFeed";

function item(seq: number, overrides: Partial<LogFeedItem> = {}): LogFeedItem {
  return { seq, at: seq * 1000, level: "info", method: "ldap/search", result: "ok", ...overrides };
}

describe("parseLogEvent", () => {
  it("解析完整 Entry params", () => {
    const parsed = parseLogEvent({ seq: 7, at: 1234, level: "error", method: "ldap/search", connectionId: "c1", target: "dc=x", detail: "filter=(cn=a)", result: "error", durationMs: 88, source: "ui" }, 0);
    expect(parsed).toEqual({ seq: 7, at: 1234, level: "error", method: "ldap/search", connectionId: "c1", target: "dc=x", detail: "filter=(cn=a)", result: "error", durationMs: 88, source: "ui" });
  });

  it("seq 非法的条目丢弃（返回 undefined）", () => {
    expect(parseLogEvent({}, 0)).toBeUndefined();
    expect(parseLogEvent({ seq: 0 }, 0)).toBeUndefined();
    expect(parseLogEvent({ seq: "7" }, 0)).toBeUndefined();
    expect(parseLogEvent({ seq: Number.NaN }, 0)).toBeUndefined();
  });

  it("缺省字段兜底为安全默认值", () => {
    const parsed = parseLogEvent({ seq: 1 }, 2000);
    expect(parsed).toMatchObject({ seq: 1, level: "info", method: "ldap", result: "error", at: 2000 });
    expect(parsed).not.toHaveProperty("target");
    expect(parsed).not.toHaveProperty("durationMs");
  });

  it("未知 result 折算为 error（不静默吞掉）", () => {
    expect(parseLogEvent({ seq: 1, result: "weird" }, 0)?.result).toBe("error");
    expect(parseLogEvent({ seq: 1, result: "denied" }, 0)?.result).toBe("denied");
  });

  it("非法 at 回退本地时间；非法 durationMs 丢弃且不抛错", () => {
    expect(Number.isFinite(parseLogEvent({ seq: 1, at: "x" }, 3000)?.at)).toBe(true);
    expect(parseLogEvent({ seq: 1, durationMs: "slow" }, 0)).not.toHaveProperty("durationMs");
    expect(parseLogEvent({ seq: 1, durationMs: 0 }, 0)).not.toHaveProperty("durationMs");
  });
});

describe("pushLogItem / mergeLogTail", () => {
  it("新事件追加尾部，超上限裁头部", () => {
    let items: LogFeedItem[] = [];
    for (let seq = 1; seq <= LOG_FEED_MAX + 5; seq += 1) items = pushLogItem(items, item(seq));
    expect(items.length).toBe(LOG_FEED_MAX);
    expect(items[0].seq).toBe(6);
    expect(items[items.length - 1].seq).toBe(LOG_FEED_MAX + 5);
  });

  it("tail 按 seq 升序合并并去重", () => {
    const items = [item(1), item(3)];
    const merged = mergeLogTail(items, [item(4), item(2), item(3)]);
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it("合并后超上限仍裁最旧", () => {
    const items: LogFeedItem[] = [];
    for (let seq = 1; seq <= LOG_FEED_MAX; seq += 1) items.push(item(seq));
    const merged = mergeLogTail(items, [item(LOG_FEED_MAX + 1)]);
    expect(merged.length).toBe(LOG_FEED_MAX);
    expect(merged[0].seq).toBe(2);
  });

  it("nextLogCursor 取最大 seq，空列表为 0", () => {
    expect(nextLogCursor([])).toBe(0);
    expect(nextLogCursor([item(2), item(9), item(4)])).toBe(9);
  });
});

describe("filterLogItems / collectConnectionIds", () => {
  const items = [
    item(1, { level: "info", connectionId: "c1", method: "ldap/search", target: "ou=a" }),
    item(2, { level: "error", connectionId: "c2", method: "connect", detail: "refused" }),
    item(3, { level: "warn", connectionId: "c1", method: "reconnect" }),
  ];

  it("级别过滤", () => {
    expect(filterLogItems(items, { level: "error", connectionId: "all", query: "" }).map((entry) => entry.seq)).toEqual([2]);
  });

  it("连接过滤", () => {
    expect(filterLogItems(items, { level: "all", connectionId: "c1", query: "" }).map((entry) => entry.seq)).toEqual([1, 3]);
  });

  it("子串查询匹配 method/target/detail/connectionId", () => {
    expect(filterLogItems(items, { level: "all", connectionId: "all", query: "RECONNECT" }).map((entry) => entry.seq)).toEqual([3]);
    expect(filterLogItems(items, { level: "all", connectionId: "all", query: "refused" }).map((entry) => entry.seq)).toEqual([2]);
    expect(filterLogItems(items, { level: "all", connectionId: "all", query: "c2" }).map((entry) => entry.seq)).toEqual([2]);
  });

  it("连接选项保持首次出现顺序", () => {
    expect(collectConnectionIds(items)).toEqual(["c1", "c2"]);
    expect(collectConnectionIds([item(1)])).toEqual([]);
  });
});

describe("formatLogLine / formatLogTime", () => {
  it("单行拼接跳过空片段", () => {
    const line = formatLogLine(item(1, { target: "dc=x", durationMs: 88, detail: "scope=sub" }), "10:30:05");
    expect(line).toBe("10:30:05 [info] ldap/search dc=x scope=sub 88ms");
  });

  it("同一天只显示 HH:MM:SS", () => {
    const now = new Date(2026, 8, 2, 10, 30, 5).getTime();
    expect(formatLogTime(now, now)).toBe("10:30:05");
  });

  it("跨天条目加 MM-DD 前缀", () => {
    const now = new Date(2026, 8, 2, 0, 5, 0).getTime();
    const yesterday = new Date(2026, 8, 1, 23, 59, 59).getTime();
    expect(formatLogTime(yesterday, now)).toBe("09-01 23:59:59");
  });
});
