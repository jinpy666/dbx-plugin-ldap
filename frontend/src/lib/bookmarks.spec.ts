// @vitest-environment happy-dom
// 书签（F7）lib 层测试：增删查、大小写不敏感去重、每连接上限 20、连接隔离、
// 无 localStorage 降级（内存 Map），以及 F8 revealDn 复用的 dnPathChain 纯函数。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addBookmark, dnPathChain, loadBookmarks, removeBookmark } from "./bookmarks";

const KEY = "dbx-ldap-bookmarks-v1";
const CONN = "conn-a";
const OTHER = "conn-b";

beforeEach(() => {
  localStorage.removeItem(KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("书签增删查", () => {
  it("空存储 loadBookmarks 返回空数组", () => {
    expect(loadBookmarks(CONN)).toEqual([]);
  });

  it("add 后 load 最新在前，落盘条目带 connectionId 字段", () => {
    expect(addBookmark(CONN, "cn=alice,dc=demo")).toBe(true);
    expect(addBookmark(CONN, "ou=people,dc=demo")).toBe(true);
    expect(loadBookmarks(CONN)).toEqual(["ou=people,dc=demo", "cn=alice,dc=demo"]);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    expect(stored[0]).toEqual({ connectionId: CONN, dn: "ou=people,dc=demo" });
  });

  it("remove 命中（大小写不敏感）返回 true 并移除；未命中返回 false", () => {
    addBookmark(CONN, "cn=alice,dc=demo");
    expect(removeBookmark(CONN, "CN=ALICE,DC=DEMO")).toBe(true);
    expect(loadBookmarks(CONN)).toEqual([]);
    expect(removeBookmark(CONN, "cn=alice,dc=demo")).toBe(false);
  });

  it("损坏的存储内容回落为空列表，add 照常可用", () => {
    localStorage.setItem(KEY, "{not json");
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

describe("无 localStorage 降级（内存 Map）", () => {
  it("localStorage 不可用时增删查可用且互不落盘", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const degraded = await import("./bookmarks");
    expect(degraded.addBookmark(CONN, "cn=alice,dc=demo")).toBe(true);
    expect(degraded.loadBookmarks(CONN)).toEqual(["cn=alice,dc=demo"]);
    expect(degraded.addBookmark(CONN, "CN=ALICE,DC=DEMO")).toBe(false);
    expect(degraded.removeBookmark(CONN, "cn=alice,dc=demo")).toBe(true);
    expect(degraded.loadBookmarks(CONN)).toEqual([]);
  });

  it("降级内存存储与持久化存储互不相通", async () => {
    addBookmark(CONN, "cn=normal,dc=demo");
    // 同一模块实例的显式引用（resetModules 后静态导入仍指向旧实例）。
    const persisted = await import("./bookmarks");
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const degraded = await import("./bookmarks");
    expect(degraded.loadBookmarks(CONN)).toEqual([]);
    // 还原存储后，持久化实例仍读得到原数据（降级实例的内存态不回流）。
    vi.unstubAllGlobals();
    expect(persisted.loadBookmarks(CONN)).toEqual(["cn=normal,dc=demo"]);
  });
});

// DBX 宿主 webview（WebKit 存储被禁 / 非安全上下文）下，localStorage 绑定
// 本身访问即抛 SecurityError("The operation is insecure.")——typeof 拦不住
// 抛异常的 getter，必须整体降级为内存存储。这正是「打开工作台即报 insecure」
// 启动崩溃（App initialize → reloadBookmarks）的根因。
describe("localStorage 访问即抛（宿主禁存储 SecurityError）降级", () => {
  const stubThrowingStorage = (): (() => void) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    return () => {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as unknown as Record<string, unknown>).localStorage;
    };
  };

  it("loadBookmarks 返回空列表而非抛 SecurityError", async () => {
    const restore = stubThrowingStorage();
    try {
      vi.resetModules();
      const degraded = await import("./bookmarks");
      expect(() => degraded.loadBookmarks(CONN)).not.toThrow();
      expect(degraded.loadBookmarks(CONN)).toEqual([]);
    } finally {
      restore();
    }
  });

  it("add/remove 降级为内存存储且本会话内可读回", async () => {
    const restore = stubThrowingStorage();
    try {
      vi.resetModules();
      const degraded = await import("./bookmarks");
      expect(degraded.addBookmark(CONN, "cn=alice,dc=demo")).toBe(true);
      expect(degraded.loadBookmarks(CONN)).toEqual(["cn=alice,dc=demo"]);
      expect(degraded.removeBookmark(CONN, "cn=alice,dc=demo")).toBe(true);
      expect(degraded.loadBookmarks(CONN)).toEqual([]);
    } finally {
      restore();
    }
  });
});

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
