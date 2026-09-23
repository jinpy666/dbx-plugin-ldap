// @vitest-environment happy-dom
// 书签（F7）lib 层测试：增删查、大小写不敏感去重、每连接上限 20、连接隔离、
// 坏数据防御，以及 F8 revealDn 复用的 dnPathChain 纯函数。
// 存储通道降级（宿主 host.storage → guarded localStorage → 内存）已收敛进
// shared/frontend/pluginStorage.ts 适配器，由 pluginStorage.spec.ts 覆盖；
// 持久化后端是 pluginStore 单例（模块导入时已水合进缓存），播种/清理须走
// 同一实例，直接改 localStorage 读不到。
import { beforeEach, describe, expect, it } from "vitest";
import { addBookmark, dnPathChain, loadBookmarks, removeBookmark } from "./bookmarks";
import { BOOKMARKS_KEY, pluginStore } from "./pluginStore";

const CONN = "conn-a";
const OTHER = "conn-b";

beforeEach(() => {
  pluginStore.removeItem(BOOKMARKS_KEY);
});

describe("书签增删查", () => {
  it("空存储 loadBookmarks 返回空数组", () => {
    expect(loadBookmarks(CONN)).toEqual([]);
  });

  it("add 后 load 最新在前，落盘条目带 connectionId 字段", () => {
    expect(addBookmark(CONN, "cn=alice,dc=demo")).toBe(true);
    expect(addBookmark(CONN, "ou=people,dc=demo")).toBe(true);
    expect(loadBookmarks(CONN)).toEqual(["ou=people,dc=demo", "cn=alice,dc=demo"]);
    const stored = JSON.parse(pluginStore.getItem(BOOKMARKS_KEY) ?? "[]");
    expect(stored[0]).toEqual({ connectionId: CONN, dn: "ou=people,dc=demo" });
  });

  it("remove 命中（大小写不敏感）返回 true 并移除；未命中返回 false", () => {
    addBookmark(CONN, "cn=alice,dc=demo");
    expect(removeBookmark(CONN, "CN=ALICE,DC=DEMO")).toBe(true);
    expect(loadBookmarks(CONN)).toEqual([]);
    expect(removeBookmark(CONN, "cn=alice,dc=demo")).toBe(false);
  });

  it("损坏的存储内容回落为空列表，add 照常可用", () => {
    pluginStore.setItem(BOOKMARKS_KEY, "{not json");
    expect(loadBookmarks(CONN)).toEqual([]);
    expect(addBookmark(CONN, "cn=alice,dc=demo")).toBe(true);
    expect(loadBookmarks(CONN)).toEqual(["cn=alice,dc=demo"]);
  });
});

describe("书签去重与上限", () => {
  it("大小写不敏感去重：重复 add 返回 false 且保留首次大小写", () => {
    expect(addBookmark(CONN, "cn=alice,dc=demo")).toBe(true);
    expect(addBookmark(CONN, "CN=ALICE,DC=DEMO")).toBe(false);
    expect(loadBookmarks(CONN)).toEqual(["cn=alice,dc=demo"]);
  });

  it("同一连接上限 20：第 21 条挤掉最旧一条，长度保持 20", () => {
    for (let index = 0; index < 20; index++) addBookmark(CONN, `cn=user${index},dc=demo`);
    expect(loadBookmarks(CONN)).toHaveLength(20);
    expect(addBookmark(CONN, "cn=newest,dc=demo")).toBe(true);
    const list = loadBookmarks(CONN);
    expect(list).toHaveLength(20);
    expect(list[0]).toBe("cn=newest,dc=demo");
    expect(list).not.toContain("cn=user0,dc=demo");
    expect(list.at(-1)).toBe("cn=user1,dc=demo");
  });

  it("空 DN / 空 connectionId 拒绝且不改列表", () => {
    addBookmark(CONN, "cn=alice,dc=demo");
    expect(addBookmark(CONN, "   ")).toBe(false);
    expect(addBookmark("", "cn=other,dc=demo")).toBe(false);
    expect(loadBookmarks(CONN)).toEqual(["cn=alice,dc=demo"]);
  });
});

describe("连接隔离", () => {
  it("不同连接互不可见、移除互不影响", () => {
    addBookmark(CONN, "cn=alice,dc=demo");
    expect(loadBookmarks(OTHER)).toEqual([]);
    addBookmark(OTHER, "cn=bob,dc=demo");
    expect(loadBookmarks(CONN)).toEqual(["cn=alice,dc=demo"]);
    expect(removeBookmark(OTHER, "cn=bob,dc=demo")).toBe(true);
    expect(loadBookmarks(CONN)).toEqual(["cn=alice,dc=demo"]);
    expect(loadBookmarks(OTHER)).toEqual([]);
  });
});

// -- 存储通道降级用例（原「无 localStorage 降级（内存 Map）」「localStorage
// 访问即抛（宿主禁存储 SecurityError）降级」两个 describe）已随实现上移：
// bookmarks.ts 不再自带 typeof/try 降级，通道选择与内存兜底由
// shared/frontend/pluginStorage.ts 适配器提供，覆盖见 pluginStorage.spec.ts
// （node 环境下 pluginStore.channel === "memory"、宿主桥失败仅告警不抛）。

describe("dnPathChain（F8 路径切分纯函数）", () => {
  const base = "dc=demo,dc=dbx";

  it("目标等于根 → 单元素链", () => {
    expect(dnPathChain(base, base)).toEqual([base]);
  });

  it("多级目标 → 根到目标的祖先链（含两端）", () => {
    expect(dnPathChain(`cn=alice,ou=people,${base}`, base)).toEqual([base, `ou=people,${base}`, `cn=alice,ou=people,${base}`]);
  });

  it("目标/base 大小写不同仍可对齐（保留目标原始大小写）", () => {
    const upper = base.toUpperCase();
    expect(dnPathChain(`cn=alice,${upper}`, base)).toEqual([base, `cn=alice,${upper}`]);
  });

  it("目标不在 base 之下 / 空串 → 空链（调用方判失败）", () => {
    expect(dnPathChain("cn=x,dc=other", base)).toEqual([]);
    expect(dnPathChain("", base)).toEqual([]);
    expect(dnPathChain("cn=x", "")).toEqual([]);
  });
});
