// @vitest-environment happy-dom
// useEntryDetail 详情缓存 LRU 测试（审计 K-4）：lruSet/lruTouch 纯函数锁定
// 淘汰算法，再用组合式集成验证 openEntry 的缓存命中/超限淘汰真实接线。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { useEntryDetail, lruSet, lruTouch, ENTRY_DETAIL_CACHE_LIMIT } from "./useEntryDetail";
import { ldapApi, type LdapEntry } from "./api";

type EntryGetResult = { entry: LdapEntry };

const dnOf = (n: number) => `cn=e${n},dc=demo`;

function createSession() {
  return useEntryDetail({
    getConnectionId: () => "conn-1",
    dialogToken: { value: 0 },
    clearBanner: () => {},
    onBannerError: () => {},
    onSnapshot: () => {},
    onRecent: () => {},
    onNotice: () => {},
    getEditorSchema: () => undefined,
    ensureDnAttributes: () => {},
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lruSet / lruTouch helpers", () => {
  it("caps the cache at the limit and evicts the oldest entry first", () => {
    const cache = new Map<string, number>();
    for (let i = 0; i < ENTRY_DETAIL_CACHE_LIMIT; i++) lruSet(cache, `k${i}`, i, ENTRY_DETAIL_CACHE_LIMIT);
    expect(cache.size).toBe(ENTRY_DETAIL_CACHE_LIMIT);
    lruSet(cache, "new", 99, ENTRY_DETAIL_CACHE_LIMIT);
    expect(cache.size).toBe(ENTRY_DETAIL_CACHE_LIMIT);
    expect(cache.has("k0")).toBe(false);
    expect(cache.get("new")).toBe(99);
    expect(cache.get(`k${ENTRY_DETAIL_CACHE_LIMIT - 1}`)).toBe(ENTRY_DETAIL_CACHE_LIMIT - 1);
  });

  it("re-inserting an existing key refreshes its recency without growing the cache", () => {
    const cache = new Map<string, number>();
    for (let i = 0; i < ENTRY_DETAIL_CACHE_LIMIT; i++) lruSet(cache, `k${i}`, i, ENTRY_DETAIL_CACHE_LIMIT);
    // 触碰最旧的 k0 → 移到最新位，下一次写入淘汰变成最旧的 k1。
    lruSet(cache, "k0", 0, ENTRY_DETAIL_CACHE_LIMIT);
    lruSet(cache, "new", 99, ENTRY_DETAIL_CACHE_LIMIT);
    expect(cache.size).toBe(ENTRY_DETAIL_CACHE_LIMIT);
    expect(cache.has("k0")).toBe(true);
    expect(cache.has("k1")).toBe(false);
  });

  it("lruTouch moves a key to the newest position and keeps its value", () => {
    const cache = new Map<string, string>();
    cache.set("a", "1");
    cache.set("b", "2");
    lruTouch(cache, "a");
    expect([...cache.keys()]).toEqual(["b", "a"]);
    expect(cache.get("a")).toBe("1");
    lruTouch(cache, "missing");
    expect([...cache.keys()]).toEqual(["b", "a"]);
  });
});

describe("entry detail cache integration", () => {
  it("serves a repeat open synchronously from cache and evicts beyond the LRU limit", async () => {
    vi.spyOn(ldapApi, "entryGet").mockImplementation(async (dn, attributes): Promise<EntryGetResult> => {
      // typesOnly 描述调用返回空属性 → 不触发后台分批/合并，便于计数与隔离。
      if (attributes?.[0] === "*") return { entry: { dn, attributes: {} } };
      return { entry: { dn, attributes: { cn: [dn] } } };
    });
    const session = createSession();
    for (let i = 0; i < ENTRY_DETAIL_CACHE_LIMIT; i++) {
      await session.openEntry(dnOf(i));
      await flushPromises();
    }
    // 重开 dn0：命中缓存并触碰 → dn0 变最新，dn1 变最旧。
    await session.openEntry(dnOf(0));
    await flushPromises();
    const dn0Cached = session.editorEntry.value;
    expect(dn0Cached?.dn).toBe(dnOf(0));
    // 第 51 条写入 → 淘汰最旧的 dn1。
    await session.openEntry(dnOf(ENTRY_DETAIL_CACHE_LIMIT));
    await flushPromises();

    const gate = deferred<{ entry: { dn: string; attributes: Record<string, string[]> } }>();
    vi.spyOn(ldapApi, "entryGet").mockImplementation(async (dn, attributes) => {
      if (attributes?.[0] === "*") return { entry: { dn, attributes: {} } };
      return gate.promise;
    });
    // dn1 已被挤出：同步阶段不出现缓存旧值（未命中）。
    void session.openEntry(dnOf(1));
    expect(session.editorEntry.value).toBeUndefined();
    gate.resolve({ entry: { dn: dnOf(1), attributes: { cn: ["late"] } } });
    await flushPromises();
    expect(session.editorEntry.value?.attributes.cn).toEqual(["late"]);

    // dn0 仍在缓存（上一步被触碰过）：同步阶段立即给出缓存对象。
    const gate2 = deferred<{ entry: { dn: string; attributes: Record<string, string[]> } }>();
    vi.spyOn(ldapApi, "entryGet").mockImplementation(async (dn, attributes) => {
      if (attributes?.[0] === "*") return { entry: { dn, attributes: {} } };
      return gate2.promise;
    });
    void session.openEntry(dnOf(0));
    expect(session.editorEntry.value).toBe(dn0Cached);
    gate2.resolve({ entry: { dn: dnOf(0), attributes: { cn: ["refreshed"] } } });
    await flushPromises();
    expect(session.editorEntry.value?.attributes.cn).toEqual(["refreshed"]);
  });
});
