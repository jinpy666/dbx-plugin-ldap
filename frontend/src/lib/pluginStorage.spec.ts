// 薄 spec：验证 shared/frontend/pluginStorage 适配器行为与本插件工具链下
// import 解析成立（实现与文档只在 shared 维护）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginKvStore, type DbxPluginStorageBridge, type KvBacking } from "../../../shared/frontend/pluginStorage";
import {
  BOOKMARKS_KEY,
  GRID_COLUMN_STATE_KEY,
  GRID_PAGE_SIZE_KEY,
  PLUGIN_STORE_KEYS,
  SEARCH_COLLAPSED_KEY,
  SEARCH_HISTORY_KEY,
  TREE_WIDTH_KEY,
  pluginStore,
} from "./pluginStore";

function memoryBacking(initial: Record<string, string> = {}): KvBacking {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function bridgeBacking(initial: Record<string, unknown> = {}): DbxPluginStorageBridge & { map: Map<string, unknown> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : null),
    set: async (key, value) => {
      map.set(key, value);
      return null;
    },
    delete: async (key) => {
      map.delete(key);
      return null;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pluginStorage host channel", () => {
  it("hydrates existing host values and serves sync reads", async () => {
    const bridge = bridgeBacking({ [TREE_WIDTH_KEY]: "320", legacy: { embedded: true } });
    const store = createPluginKvStore([TREE_WIDTH_KEY, "legacy"], { bridge, localStorage: null });
    await store.ready;
    expect(store.getItem(TREE_WIDTH_KEY)).toBe("320");
    // 非字符串 JSON 值（宿主端为任意 JSON 文档）序列化进字符串缓存。
    expect(store.getItem("legacy")).toBe('{"embedded":true}');
  });

  it("writes through set/remove to the bridge", async () => {
    const bridge = bridgeBacking();
    const store = createPluginKvStore(["k"], { bridge, localStorage: null });
    await store.ready;
    store.setItem("k", "v1");
    expect(store.getItem("k")).toBe("v1");
    await Promise.resolve();
    expect(bridge.map.get("k")).toBe("v1");
    store.removeItem("k");
    expect(store.getItem("k")).toBeNull();
    await Promise.resolve();
    expect(bridge.map.has("k")).toBe(false);
  });

  it("adopts legacy localStorage values once when the host key is missing", async () => {
    const bridge = bridgeBacking();
    const ls = memoryBacking({ [BOOKMARKS_KEY]: '["cn=alice"]' });
    const store = createPluginKvStore([BOOKMARKS_KEY], { bridge, localStorage: ls });
    await store.ready;
    expect(store.getItem(BOOKMARKS_KEY)).toBe('["cn=alice"]');
    await Promise.resolve();
    // 搬家 = 读旧值写穿宿主；旧档保留不删（老宿主回退仍可读）。
    expect(bridge.map.get(BOOKMARKS_KEY)).toBe('["cn=alice"]');
    expect(ls.getItem(BOOKMARKS_KEY)).toBe('["cn=alice"]');
  });

  it("keeps cache writes made before hydration (hydration never overwrites)", async () => {
    const bridge = bridgeBacking({ k: "from-host" });
    const store = createPluginKvStore(["k"], { bridge, localStorage: null });
    store.setItem("k", "from-ui");
    await store.ready;
    expect(store.getItem("k")).toBe("from-ui");
  });

  it("survives bridge get/set failures with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createPluginKvStore(["boom"], {
      bridge: {
        get: async () => {
          throw new Error("quota");
        },
        set: async () => {
          throw new Error("quota");
        },
        delete: async () => {
          throw new Error("quota");
        },
      },
      localStorage: null,
    });
    await store.ready;
    expect(() => store.setItem("boom", "x")).not.toThrow();
    expect(store.getItem("boom")).toBe("x");
    expect(warn).toHaveBeenCalled();
  });
});

describe("pluginStorage degraded channels", () => {
  it("uses localStorage synchronously when no bridge exists", async () => {
    const ls = memoryBacking({ a: "1" });
    const store = createPluginKvStore(["a", "b"], { bridge: null, localStorage: ls });
    await store.ready;
    expect(store.channel).toBe("localStorage");
    expect(store.getItem("a")).toBe("1");
    store.setItem("b", "2");
    expect(ls.getItem("b")).toBe("2");
    store.removeItem("a");
    expect(ls.getItem("a")).toBeNull();
  });

  it("falls back to memory when neither channel exists", async () => {
    const store = createPluginKvStore(["k"], { bridge: null, localStorage: null });
    await store.ready;
    expect(store.channel).toBe("memory");
    store.setItem("k", "session");
    expect(store.getItem("k")).toBe("session");
  });
});

describe("ldap pluginStore wiring", () => {
  it("declares every persisted UI key and resolves to memory in node tests", async () => {
    expect(new Set(PLUGIN_STORE_KEYS)).toEqual(
      new Set([SEARCH_COLLAPSED_KEY, SEARCH_HISTORY_KEY, TREE_WIDTH_KEY, GRID_PAGE_SIZE_KEY, GRID_COLUMN_STATE_KEY, BOOKMARKS_KEY]),
    );
    // 显式字面量再锁一遍：键名是跨版本持久化契约，改名 = 用户状态丢失。
    expect(new Set(PLUGIN_STORE_KEYS)).toEqual(
      new Set([
        "dbx.ldap.ui.searchCollapsed",
        "dbx.ldap.ui.searchHistory",
        "dbx.ldap.ui.treeWidth",
        "dbx-ldap-grid-pagesizes",
        "dbx-ldap-grid-colstates",
        "dbx-ldap-bookmarks-v1",
      ]),
    );
    // node 环境无 window：默认解析应落到内存档而不是抛错。
    expect(pluginStore.channel).toBe("memory");
    await pluginStore.ready;
  });

  it("round-trips through the adapter on the localStorage channel", async () => {
    const ls = memoryBacking();
    const store = createPluginKvStore(["k"], { bridge: null, localStorage: ls });
    await store.ready;
    expect(store.channel).toBe("localStorage");
    store.setItem("k", "v");
    expect(store.getItem("k")).toBe("v");
    expect(ls.getItem("k")).toBe("v");
    store.removeItem("k");
    expect(ls.getItem("k")).toBeNull();
  });
});
