// @vitest-environment happy-dom
// Exercise current host callbacks, not the legacy callbacks exposed by the visual fixture.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import App from "./App.vue";
import { getLdapConnectionId, ldapApi, setLdapConnectionId } from "./lib/api";
import { emitEntryDeleted } from "./lib/entryEvents";
import { setWorkbenchLocale, workbenchLocale } from "./lib/i18n";
import { resetSchemaCacheForTests } from "./lib/schemaCache";

const context = (id: string, connectionPatch: Record<string, unknown> = {}) => ({
  connectionId: id,
  connection: { host: id, baseDn: "dc=" + id, ...connectionPatch },
});
let wrapper: ReturnType<typeof mount<typeof App>> | undefined;
const treeStub = defineComponent({
  setup(_, { expose }) {
    expose({ refresh: vi.fn(), invalidate: vi.fn() });
    return () => h("div");
  },
});
const searchStub = defineComponent({
  name: "SearchForm",
  props: ["baseDn", "disabled", "running"],
  emits: ["run"],
  setup(_, { expose }) {
    expose({ applyBaseDn: vi.fn() });
    return () => h("div");
  },
});

async function mountWithHost(legacy = false, both = false, connectionPatch: Record<string, unknown> = {}) {
  let receiveContext: ((next: Record<string, unknown>) => void) | undefined;
  let receiveEvent: ((event: DbxPluginEvent) => void) | undefined;
  const offContext = vi.fn();
  const offEvent = vi.fn();
  const subscribe = vi.fn((listener) => { receiveContext = listener; return offContext; });
  const legacySubscribe = legacy ? subscribe : vi.fn(() => () => undefined);
  const invoke = vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({ statuses: [], entries: [], count: 0, truncated: false }));
  window.dbxPlugin = {
    ready: Promise.resolve(context("first", connectionPatch)),
    request: vi.fn(async () => context("first")),
    locale: "en",
    invoke,
    ...(legacy ? { onContextChange: subscribe } : { onContext: subscribe }),
    ...(both ? { onContextChange: legacySubscribe } : {}),
    onEvent: (listener: (event: DbxPluginEvent) => void) => { receiveEvent = listener; return offEvent; },
  } as unknown as DbxPluginApi;
  wrapper = mount(App, { global: { stubs: {
    DnTree: treeStub, SearchForm: searchStub, ResultTable: true, EntryEditorDialog: true,
    DeleteEntryDialog: true, ModifyDnDialog: true, NewEntryWizard: true,
    SchemaPanel: true, ConnectionsPanel: true, AuditFeedPanel: true,
  } }, attachTo: document.body });
  await flushPromises();
  return { subscribe, legacySubscribe, offContext, offEvent, invoke,
    updateContext: () => {
      expect(receiveContext).toBeTypeOf("function");
      receiveContext?.(context("second"));
    },
    sendEvent: (event: DbxPluginEvent) => receiveEvent?.(event),
  };
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  delete (window as unknown as { dbxPlugin?: unknown }).dbxPlugin;
  setLdapConnectionId("");
  // J-8：schema 缓存提升为模块级共享单例，清空以免用例间命中彼此的 TTL 条目。
  resetSchemaCacheForTests();
  setWorkbenchLocale("zh-CN");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const searchModel = { baseDn: "dc=first", filter: "(uid=alice)", scope: "sub", attributes: "", sizeLimit: "500", pageSize: "500", typesOnly: false, derefAliases: "never" };
const resultsPane = () => wrapper!.findComponent({ name: "ResultTable" });
const editor = () => wrapper!.findComponent({ name: "EntryEditorDialog" });
const recentButton = () => wrapper!.findAll("button[aria-label]").find((button) => button.attributes("aria-label")?.toLowerCase().includes("recent"))!;

describe("App request feedback and recovery", () => {
  it("applies colors inline but leaves fonts to the host theme bridge", async () => {
    await mountWithHost();
    document.dispatchEvent(new CustomEvent("dbx-plugin-env", { detail: { theme: { appearance: "dark", tokens: { "--color-background": "rgb(1 2 3)" } } } }));
    await flushPromises();
    // 颜色仍由 applyAppearance 内联回写。
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("rgb(1 2 3)");
    // 字体交给主题桥（--ui-font-family:var(--font-sans,…)）跟随宿主字体设置，
    // 内联回写会压过桥接样式，把字体钉死在插件默认栈。
    expect(document.documentElement.style.getPropertyValue("--ui-font-family")).toBe("");
  });

  it("keeps the protocol badge beside the connection name", async () => {
    await mountWithHost(false, false, { port: 636, external_config: { tls_mode: "ldaps", auth_type: "simple" } });
    expect(wrapper!.find(".identity .identity-protocol").text()).toBe("LDAPS · Simple");
    expect(wrapper!.find(".toolbar-actions .identity-protocol").exists()).toBe(false);
  });

  it("automatically drains every cursor page after rendering the first page", async () => {
    const host = await mountWithHost();
    host.invoke.mockImplementation(async (method) => {
      if (method === "ldap/search/start") return { searchId: "search-1", entries: [{ dn: "cn=first,dc=demo", attributes: {} }], hasMore: true };
      if (method === "ldap/search/next") {
        const nextCalls = host.invoke.mock.calls.filter(([name]) => name === "ldap/search/next").length;
        return nextCalls === 1
          ? { entries: [{ dn: "cn=second,dc=demo", attributes: {} }], hasMore: true }
          : { entries: [{ dn: "cn=third,dc=demo", attributes: {} }], hasMore: false };
      }
      return { statuses: [], success: true, attributeTypes: [], objectClasses: [] };
    });
    wrapper!.findComponent(searchStub).vm.$emit("run", searchModel);
    await flushPromises();
    await flushPromises();
    expect(host.invoke.mock.calls.filter(([method]) => method === "ldap/search/next")).toHaveLength(2);
    expect(resultsPane().props()).toMatchObject({
      entries: [{ dn: "cn=first,dc=demo" }, { dn: "cn=second,dc=demo" }, { dn: "cn=third,dc=demo" }],
      count: 3,
      complete: true,
    });
  });

  it("cancels a prior search session when a new query replaces it", async () => {
    const host = await mountWithHost();
    const nextPage = deferred<unknown>();
    host.invoke.mockImplementation(async (method) => {
      if (method === "ldap/search/start") return { searchId: "search-1", entries: [{ dn: "cn=first,dc=demo", attributes: {} }], hasMore: true };
      if (method === "ldap/search/next") return nextPage.promise;
      return { statuses: [], success: true, attributeTypes: [], objectClasses: [] };
    });
    wrapper!.findComponent(searchStub).vm.$emit("run", searchModel);
    await flushPromises();
    wrapper!.findComponent(searchStub).vm.$emit("run", { ...searchModel, filter: "(uid=bob)" });
    await flushPromises();
    expect(host.invoke).toHaveBeenCalledWith("ldap/search/cancel", { connectionId: "first", searchId: "search-1" }, undefined);
  });

  it("passes the requested transport page size instead of the grid display page size", async () => {
    const host = await mountWithHost();
    host.invoke.mockImplementation(async (method) => {
      if (method === "ldap/search/start") return { searchId: "search-1", entries: [{ dn: "cn=first,dc=demo", attributes: {} }], hasMore: false };
      return { statuses: [], success: true, attributeTypes: [], objectClasses: [] };
    });
    wrapper!.findComponent(searchStub).vm.$emit("run", searchModel);
    await flushPromises();
    expect(host.invoke).toHaveBeenCalledWith(
      "ldap/search/start",
      expect.objectContaining({ connectionId: "first", pageSize: 500 }),
      undefined,
    );
  });

  it("connects the pending state to form and results, then marks only a successful search as searched", async () => {
    const host = await mountWithHost();
    const pending = deferred<unknown>();
    host.invoke.mockImplementation(() => pending.promise);
    wrapper!.findComponent(searchStub).vm.$emit("run", searchModel);
    await flushPromises();
    expect(wrapper!.findComponent(searchStub).props("running")).toBe(true);
    expect(resultsPane().props()).toMatchObject({ loading: true, searched: false });
    pending.resolve({ entries: [], count: 0, truncated: false });
    await flushPromises();
    expect(resultsPane().props()).toMatchObject({ loading: false, searched: true, error: "" });
  });

  it("retries the same failed search after an actionable error", async () => {
    const host = await mountWithHost();
    host.invoke.mockRejectedValueOnce(new Error("connection refused"));
    wrapper!.findComponent(searchStub).vm.$emit("run", searchModel);
    await flushPromises();
    expect(resultsPane().props("error")).toContain("Cannot reach");
    expect(resultsPane().props("errorDetail")).toBe("connection refused");
    expect(resultsPane().props("searched")).toBe(false);
    resultsPane().vm.$emit("retry");
    await flushPromises();
    // 搜索成功后 App 会追加一条 ldap/ui/state/report 快照（M1 intent 通道），
    // 这里按方法过滤取最近一次 search session start。
    const searchCalls = host.invoke.mock.calls.filter(([method]) => method === "ldap/search/start");
    expect(searchCalls.at(-1)?.[1]).toMatchObject({ connectionId: "first", filter: searchModel.filter, baseDn: searchModel.baseDn });
    expect(resultsPane().props()).toMatchObject({ error: "", searched: true, loading: false });
  });

  it("ignores a search response from the previous connection and releases its loading state", async () => {
    const host = await mountWithHost();
    const pending = deferred<unknown>();
    host.invoke.mockImplementation(() => pending.promise);
    wrapper!.findComponent(searchStub).vm.$emit("run", searchModel);
    await flushPromises();
    host.updateContext();
    await flushPromises();
    expect(resultsPane().props()).toMatchObject({ entries: [], loading: false, searched: false });
    pending.resolve({ entries: [{ dn: "uid=old,dc=first", attributes: {} }], count: 1, truncated: false });
    await flushPromises();
    expect(resultsPane().props()).toMatchObject({ entries: [], count: 0, searched: false });
  });

  it("opens detail loading/error states immediately and retries the same DN and tab", async () => {
    const host = await mountWithHost();
    const pending = deferred<unknown>();
    host.invoke.mockImplementation(async () => pending.promise);
    editor().vm.$emit("openEntry", "cn=alice,dc=first");
    await flushPromises();
    expect(editor().props()).toMatchObject({ open: true, loading: true, requestedDn: "cn=alice,dc=first", initialTab: "assoc" });
    // Metadata is deliberately not allowed to get ahead of the first visible
    // entry response.
    expect(editor().props("schema")).toBeUndefined();
    pending.reject(new Error("connection refused"));
    await flushPromises();
    expect(editor().props("loadError")).toContain("Cannot reach");
    expect(editor().props("loadErrorDetail")).toBe("connection refused");
    expect(editor().props("loading")).toBe(false);
    host.invoke.mockResolvedValue({ entry: { dn: "cn=alice,dc=first", attributes: {} } });
    editor().vm.$emit("retry");
    await flushPromises();
    // 条目打开成功后 App 会上报 entry 快照（M1 intent 通道），按方法过滤。
    const entryCalls = host.invoke.mock.calls.filter(([method]) => method === "ldap/entry/get");
    expect(entryCalls.at(-1)?.[1]).toMatchObject({ dn: "cn=alice,dc=first" });
    expect(editor().props()).toMatchObject({ open: true, loading: false, loadError: "", initialTab: "assoc", entry: { dn: "cn=alice,dc=first" } });
  });

  it.each([false, true])("does not reopen a pending detail after close or connection switch (switch=%s)", async (switchConnection) => {
    const host = await mountWithHost();
    const pending = deferred<unknown>();
    host.invoke.mockImplementation(async (method) => method === "ldap/schema" ? { attributeTypes: [], objectClasses: [] } : pending.promise);
    resultsPane().vm.$emit("open", "cn=alice,dc=first");
    await flushPromises();
    if (switchConnection) host.updateContext();
    else editor().vm.$emit("close");
    await flushPromises();
    pending.resolve({ entry: { dn: "cn=alice,dc=first", attributes: {} } });
    await flushPromises();
    expect(editor().props()).toMatchObject({ open: false, loading: false });
    expect(editor().props("entry")).toBeUndefined();
  });

  it("renders core attributes before bounded batches and loads deferred fields only on demand", async () => {
    const host = await mountWithHost();
    const core = deferred<unknown>();
    const described = deferred<unknown>();
    const regular = deferred<unknown>();
    const deferredFields = deferred<unknown>();
    let entryCall = 0;
    host.invoke.mockImplementation((method) => {
      if (method === "ldap/schema") return Promise.resolve({ attributeTypes: [], objectClasses: [] });
      if (method !== "ldap/entry/get") return Promise.resolve({ success: true });
      entryCall += 1;
      return [core.promise, described.promise, regular.promise, deferredFields.promise][entryCall - 1] ?? Promise.resolve({ entry: { dn: "cn=alice,dc=first", attributes: {} } });
    });

    resultsPane().vm.$emit("open", "cn=alice,dc=first");
    await flushPromises();
    const first = host.invoke.mock.calls.find(([method]) => method === "ldap/entry/get");
    expect(first?.[1]).toMatchObject({ attributes: expect.arrayContaining(["objectClass", "cn", "modifyTimestamp"]) });

    core.resolve({ entry: { dn: "cn=alice,dc=first", attributes: { cn: ["Alice"], objectClass: ["person"] } } });
    await flushPromises();
    expect(editor().props()).toMatchObject({ loading: false, entry: { dn: "cn=alice,dc=first", attributes: { cn: ["Alice"] } } });
    const describeCall = host.invoke.mock.calls.filter(([method]) => method === "ldap/entry/get")[1];
    expect(describeCall?.[1]).toMatchObject({ attributes: ["*"], typesOnly: true });

    described.resolve({ entry: { dn: "cn=alice,dc=first", attributes: { cn: [], postalAddress: [], telephoneNumber: [], member: [], jpegPhoto: [] } } });
    await flushPromises();
    const regularCall = host.invoke.mock.calls.filter(([method]) => method === "ldap/entry/get")[2];
    expect(regularCall?.[1]).toMatchObject({ attributes: ["postalAddress", "telephoneNumber"] });
    regular.resolve({ entry: { dn: "cn=alice,dc=first", attributes: { postalAddress: ["Example Street"], telephoneNumber: ["1"] } } });
    await flushPromises();
    expect(editor().props()).toMatchObject({ loadingMore: false, deferredAttributeCount: 2 });

    editor().vm.$emit("loadDeferred");
    await flushPromises();
    const demandCall = host.invoke.mock.calls.filter(([method]) => method === "ldap/entry/get")[3];
    expect(demandCall?.[1]).toMatchObject({ attributes: ["member", "jpegPhoto"] });
    deferredFields.resolve({ entry: { dn: "cn=alice,dc=first", attributes: { member: ["cn=team,dc=first"], jpegPhoto: ["AA=="] } } });
    await flushPromises();
    expect(editor().props()).toMatchObject({ loadingDeferred: false, deferredAttributeCount: 0 });
  });

  it("opens a referenced entry in the relation workspace and keeps its field context", async () => {
    const host = await mountWithHost();
    host.invoke.mockImplementation(async (method, params) => {
      if (method === "ldap/entry/get") {
        const dn = String(params?.dn ?? "");
        return { entry: { dn, attributes: { cn: ["Bob"] } } };
      }
      if (method === "ldap/schema") return { attributeTypes: [], objectClasses: [] };
      return { statuses: [], success: true };
    });

    editor().vm.$emit("openRelatedEntry", "cn=bob,dc=first", "manager");
    await flushPromises();
    await flushPromises();

    expect(wrapper!.find(".entry-relation-layout").exists()).toBe(true);
    expect(wrapper!.find(".entry-relation-field-label").text()).toBe("manager");
    const editors = wrapper!.findAllComponents({ name: "EntryEditorDialog" });
    expect(editors).toHaveLength(2);
    expect(editors[1].props()).toMatchObject({
      loading: false,
      requestedDn: "cn=bob,dc=first",
      entry: { dn: "cn=bob,dc=first", attributes: { cn: ["Bob"] } },
    });
  });
});

describe("App recent entries menu", () => {
  it("focuses recent entries and cycles with arrow keys", async () => {
    const host = await mountWithHost();
    host.invoke.mockResolvedValue({ entry: { dn: "cn=alice,dc=first", attributes: {} } });
    editor().vm.$emit("openEntry", "cn=alice,dc=first");
    await flushPromises();
    await recentButton().trigger("click");
    await flushPromises();

    const menu = document.querySelector<HTMLElement>(".context-menu");
    expect(menu?.getAttribute("role")).toBe("menu");
    const item = menu?.querySelector<HTMLElement>("[role='menuitem']");
    expect(item).toBeTruthy();
    expect(item?.querySelector(".context-menu-item-icon")).toBeTruthy();
    expect(document.activeElement).toBe(item);
    await menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(item);
    await menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(document.activeElement).toBe(recentButton().element);
  });
});

describe("App current host bridge contract", () => {
  it.each([false, true])("follows context changes and sends the updated connectionId (legacy=%s)", async (legacy) => {
    const host = await mountWithHost(legacy);
    expect(getLdapConnectionId()).toBe("first");
    host.updateContext();
    await flushPromises();
    expect(getLdapConnectionId()).toBe("second");
    await ldapApi.searchStart({ filter: "(objectClass=*)", scope: "sub" });
    expect(host.invoke).toHaveBeenLastCalledWith("ldap/search/start", { connectionId: "second", filter: "(objectClass=*)", scope: "sub" }, undefined);
  });

  it("prefers onContext when both callbacks exist and disposes subscriptions", async () => {
    const host = await mountWithHost(false, true);
    expect(host.subscribe).toHaveBeenCalledOnce();
    expect(host.legacySubscribe).not.toHaveBeenCalled();
    wrapper?.unmount();
    wrapper = undefined;
    expect(host.offContext).toHaveBeenCalledOnce();
    // M1：App 挂两个 onEvent 订阅（audit 流 + useUiIntent），卸载各退订一次。
    expect(host.offEvent).toHaveBeenCalledTimes(2);
  });

  it("accepts the native env locale envelope alongside backend audit events", async () => {
    const host = await mountWithHost();
    host.sendEvent({ type: "env", locale: "ja" });
    await flushPromises();
    expect(workbenchLocale.value).toBe("ja");
    // ok 结果只进最近操作面板（数据已入 AuditFeedPanel），不再弹通知覆盖领域反馈。
    host.sendEvent({ method: "ldap/audit", params: { connectionId: "first", action: "modify", target: "cn=a,dc=first", result: "ok" } });
    await flushPromises();
    expect(wrapper?.findComponent({ name: "AuditFeedPanel" }).props("items")).toHaveLength(1);
    expect(wrapper?.find(".notice").exists()).toBe(false);
    // denied/error 保留错误横幅。
    host.sendEvent({ method: "ldap/audit", params: { connectionId: "first", action: "modify", target: "cn=a,dc=first", result: "denied" } });
    await flushPromises();
    expect(wrapper?.findComponent({ name: "AuditFeedPanel" }).props("items")).toHaveLength(2);
    expect(wrapper?.find(".error-banner").exists()).toBe(true);
  });
});

describe("App batch write guards and replay coalescing", () => {
  it("aborts a running batch delete when the connection switches mid-loop", async () => {
    const host = await mountWithHost();
    const firstDelete = deferred<unknown>();
    let deleteCalls = 0;
    host.invoke.mockImplementation(async (method) => {
      if (method === "ldap/entry/delete") {
        deleteCalls += 1;
        if (deleteCalls === 1) return firstDelete.promise;
        return { success: true };
      }
      return { statuses: [], success: true };
    });
    resultsPane().vm.$emit("batchDelete", ["cn=a,dc=first", "cn=b,dc=first", "cn=c,dc=first"]);
    await flushPromises();
    // 循环挂在第一条删除的响应上，后续 DN 尚未发出。
    expect(deleteCalls).toBe(1);
    host.updateContext();
    await flushPromises();
    firstDelete.resolve({ success: true });
    await flushPromises();
    // 连接守卫中止循环：剩余 DN 不发往新连接（审计 L-1）。
    expect(deleteCalls).toBe(1);
    // 汇总通知只统计已执行条目（1 成功 0 失败），用户可感知中途停止。
    expect(wrapper!.find(".notice").text()).toContain("1");
  });

  it("merges a burst of deleted events into a single search replay (150ms trailing debounce)", async () => {
    vi.useFakeTimers();
    try {
      const host = await mountWithHost();
      let startCalls = 0;
      host.invoke.mockImplementation(async (method) => {
        if (method === "ldap/search/start") {
          startCalls += 1;
          return { searchId: `search-${startCalls}`, entries: [{ dn: "cn=hit,dc=first", attributes: {} }], hasMore: false };
        }
        return { statuses: [], success: true };
      });
      wrapper!.findComponent(searchStub).vm.$emit("run", searchModel);
      await flushPromises();
      expect(startCalls).toBe(1);
      // 批量写连发多条事件：防抖窗口内不重放（旧实现每条各重放一次，会撞后端会话上限）。
      emitEntryDeleted("first", "cn=hit,dc=first", true);
      emitEntryDeleted("first", "cn=hit,dc=first", true);
      emitEntryDeleted("first", "cn=hit,dc=first", true);
      await flushPromises();
      expect(startCalls).toBe(1);
      vi.advanceTimersByTime(150);
      await flushPromises();
      // 窗口收沿合并为一次重放。
      expect(startCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending replay when the connection switches inside the debounce window", async () => {
    vi.useFakeTimers();
    try {
      const host = await mountWithHost();
      let startCalls = 0;
      host.invoke.mockImplementation(async (method) => {
        if (method === "ldap/search/start") {
          startCalls += 1;
          return { searchId: `search-${startCalls}`, entries: [{ dn: "cn=hit,dc=first", attributes: {} }], hasMore: false };
        }
        return { statuses: [], success: true };
      });
      wrapper!.findComponent(searchStub).vm.$emit("run", searchModel);
      await flushPromises();
      emitEntryDeleted("first", "cn=hit,dc=first", true);
      await flushPromises();
      host.updateContext();
      await flushPromises();
      vi.advanceTimersByTime(150);
      await flushPromises();
      // 旧连接的挂起重放不落到新连接的搜索会话上。
      expect(startCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// -- 宿主禁存储（WebKit 非安全上下文）下的工作台启动 ---------------------------
// DBX webview 里访问 localStorage 绑定本身即抛 SecurityError（"The operation
// is insecure."）。初始化链 initialize → syncConnectionContext → reloadBookmarks
// 曾因 bookmarks 的裸 typeof 访问抛错，被 initialize().catch 显示成 init 错误横幅。
describe("App startup with a storage-blocked host webview", () => {
  it("mounts without surfacing an init error when localStorage access throws", async () => {
    const previous = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    try {
      await mountWithHost();
      // initError 走 .tree-state 展示：存在即代表启动被存储异常打断。
      expect(wrapper!.find(".tree-state").exists()).toBe(false);
    } finally {
      if (previous) Object.defineProperty(window, "localStorage", previous);
      else delete (window as unknown as Record<string, unknown>).localStorage;
    }
  });
});
