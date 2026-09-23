// @vitest-environment happy-dom
// SearchForm 历史过滤器（对账表 P1，对标 ADS 搜索历史）：recordSearch 本地入队
// （队首去重 / 10 条上限 / pluginStore 持久化与重挂载恢复），下拉应用只回填表单
// 不自动运行，confirm 清空，快捷条与展开态双入口；历史按连接隔离存于固定键下
// 的 connectionId → 条目 map（审计 J-3），测试未注入 connectionId 时统一落
// "default" 段。
// Network calls (presets/schema) reject harmlessly without a dbxPlugin host bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setLdapConnectionId } from "../lib/api";
import SearchForm from "./SearchForm.vue";
import type { SearchFormModel } from "./SearchForm.vue";
import { SEARCH_HISTORY_KEY, pluginStore } from "../lib/pluginStore";

// 未调用 setLdapConnectionId 时组件历史段落到 default（连接未知语义）。
const DEFAULT_SEGMENT = "default";

type Exposed = {
  recordSearch: (model: SearchFormModel) => void;
  expandSearch: () => void;
};

type Wrapper = Awaited<ReturnType<typeof mountForm>>;

function baseModel(overrides: Partial<SearchFormModel> = {}): SearchFormModel {
  return {
    baseDn: "dc=demo,dc=dbx",
    filter: "(uid=jin)",
    scope: "sub",
    attributes: "cn, mail",
    sizeLimit: "500",
    pageSize: "500",
    typesOnly: false,
    derefAliases: "never",
    sortBy: "",
    sortOrder: "asc",
    ...overrides,
  };
}

async function mountForm() {
  const mounted = mount(SearchForm, { props: { baseDn: "dc=demo,dc=dbx" } });
  await mounted.vm.$nextTick();
  return mounted;
}

const record = (wrapper: Wrapper, model: SearchFormModel) => (wrapper.vm as unknown as Exposed).recordSearch(model);

// 持久化后端是 pluginStore（宿主 storage 适配，模块导入时已水合进缓存），
// 播种/断言都走同一实例；固定键下的值是 connectionId → 条目数组 map。
const storedMap = () => JSON.parse(pluginStore.getItem(SEARCH_HISTORY_KEY) ?? "{}") as Record<string, Array<Record<string, string | number>>>;
const storedHistory = () => storedMap()[DEFAULT_SEGMENT] ?? [];

const historyToggle = (wrapper: Wrapper) => wrapper.find(".search-form-compact .history-toggle");

let wrapper: Wrapper | undefined;

beforeEach(() => {
  pluginStore.removeItem(SEARCH_HISTORY_KEY);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  // 归零连接注入，避免串染后续用例的派生键。
  setLdapConnectionId("");
  vi.unstubAllGlobals();
});

describe("SearchForm search history", () => {
  it("records searches locally, persists them and restores after remount", async () => {
    wrapper = await mountForm();
    record(wrapper, baseModel());
    record(wrapper, baseModel({ filter: "(cn=admin)", scope: "one", baseDn: "ou=people,dc=demo,dc=dbx", attributes: "mail" }));
    expect(storedHistory()).toHaveLength(2);
    expect(storedHistory()[0]).toMatchObject({ filter: "(cn=admin)", baseDn: "ou=people,dc=demo,dc=dbx", scope: "one", attributes: "mail" });
    expect(storedHistory()[0].timestamp).toEqual(expect.any(Number));
    wrapper.unmount();
    // 重挂载后从 pluginStore 恢复，新条目在前。
    wrapper = await mountForm();
    await historyToggle(wrapper).trigger("click");
    const items = wrapper.findAll(".history-item");
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain("(cn=admin)");
    expect(items[0].text()).toContain("ou=people,dc=demo,dc=dbx");
    expect(items[1].text()).toContain("(uid=jin)");
  });

  it("skips an entry identical to the head and moves older duplicates to the front", async () => {
    wrapper = await mountForm();
    record(wrapper, baseModel());
    record(wrapper, baseModel());
    expect(storedHistory()).toHaveLength(1);
    record(wrapper, baseModel({ filter: "(cn=x)" }));
    record(wrapper, baseModel());
    expect(storedHistory().map((entry) => entry.filter)).toEqual(["(uid=jin)", "(cn=x)"]);
  });

  it("keeps at most 10 entries with the newest first", async () => {
    wrapper = await mountForm();
    for (let index = 0; index <= 10; index += 1) record(wrapper, baseModel({ filter: `(uid=user${index})` }));
    const stored = storedHistory();
    expect(stored).toHaveLength(10);
    expect(stored[0].filter).toBe("(uid=user10)");
    expect(stored[9].filter).toBe("(uid=user1)");
  });

  it("opens the dropdown from the compact bar and shows the empty state", async () => {
    wrapper = await mountForm();
    expect(wrapper.find(".history-panel").exists()).toBe(false);
    await historyToggle(wrapper).trigger("click");
    expect(historyToggle(wrapper).attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".history-panel").exists()).toBe(true);
    expect(wrapper.find(".history-empty").text()).toBe("暂无历史");
  });

  it("applies a history entry to the form (builder) without running the search", async () => {
    wrapper = await mountForm();
    record(wrapper, baseModel({ filter: "(uid=jin)", scope: "one", baseDn: "ou=people,dc=demo,dc=dbx", attributes: "mail" }));
    await historyToggle(wrapper).trigger("click");
    await wrapper.find(".history-item").trigger("click");
    expect((wrapper.find(".search-form-compact input.mono").element as HTMLInputElement).value).toBe("ou=people,dc=demo,dc=dbx");
    expect((wrapper.find(".search-form-compact select").element as HTMLSelectElement).value).toBe("one");
    expect((wrapper.findAll(".search-extra input")[0].element as HTMLInputElement).value).toBe("mail");
    // 可解析过滤器进构建器（预览即权威值）；应用只回填表单，不自动运行。
    expect(wrapper.find(".qb-preview").text()).toBe("(uid=jin)");
    expect(wrapper.emitted("notify")?.[0]).toEqual(["已应用历史过滤器"]);
    expect(wrapper.emitted("run")).toBeUndefined();
    expect(wrapper.find(".history-panel").exists()).toBe(false);
  });

  it("applies an unparseable history filter in source mode", async () => {
    wrapper = await mountForm();
    record(wrapper, baseModel({ filter: "(uid=bad" }));
    await historyToggle(wrapper).trigger("click");
    await wrapper.find(".history-item").trigger("click");
    // 构建器解析不了的过滤器落源码模式（源码是唯一权威表示），同样不自动运行。
    expect(wrapper.find(".filter-source").exists()).toBe(true);
    expect((wrapper.find(".filter-source input").element as HTMLInputElement).value).toBe("(uid=bad");
    expect(wrapper.emitted("run")).toBeUndefined();
  });

  it("clears the history immediately and persists the empty state", async () => {
    wrapper = await mountForm();
    record(wrapper, baseModel());
    await historyToggle(wrapper).trigger("click");
    await wrapper.find(".history-clear").trigger("click");
    expect(wrapper.find(".history-empty").exists()).toBe(true);
    expect(wrapper.findAll(".history-item")).toHaveLength(0);
    // 空历史照常落盘（当前连接段写入空数组）。
    expect(storedHistory()).toEqual([]);
  });

  it("isolates history per connection and restores it when switching back (J-3)", async () => {
    setLdapConnectionId("conn-a");
    wrapper = await mountForm();
    record(wrapper, baseModel({ filter: "(uid=conn-a)" }));
    expect(JSON.stringify(storedMap()["conn-a"])).toContain("(uid=conn-a)");
    // 存储值是 map 形状（按连接分段），不再是旧的全局数组形状。
    expect(Array.isArray(storedMap())).toBe(false);
    wrapper.unmount();
    // 换连接：读不到上一台目录的历史（组件不随连接重建，打开面板时现读派生段）。
    setLdapConnectionId("conn-b");
    wrapper = await mountForm();
    record(wrapper, baseModel({ filter: "(uid=conn-b)" }));
    expect(JSON.stringify(storedMap()["conn-b"])).toContain("(uid=conn-b)");
    await historyToggle(wrapper).trigger("click");
    const items = wrapper.findAll(".history-item");
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain("(uid=conn-b)");
    wrapper.unmount();
    // 切回原连接：该连接自己的历史仍在。
    setLdapConnectionId("conn-a");
    wrapper = await mountForm();
    await historyToggle(wrapper).trigger("click");
    const restored = wrapper.findAll(".history-item");
    expect(restored).toHaveLength(1);
    expect(restored[0].text()).toContain("(uid=conn-a)");
  });

  it("ignores the legacy global-array value without migrating it (J-3)", async () => {
    // 旧全局键与新固定键同名但形状不同（数组 vs map；适配器搬家可能把旧值
    // 带进固定键）：读取时非 map 形状一律按空表忽略，不迁移也不删除。
    pluginStore.setItem(
      SEARCH_HISTORY_KEY,
      JSON.stringify([{ filter: "(legacy=1)", baseDn: "dc=old", scope: "sub", attributes: "" }]),
    );
    setLdapConnectionId("conn-c");
    wrapper = await mountForm();
    await historyToggle(wrapper).trigger("click");
    // 旧形状不读取：切换连接后不会把旧数组内容灌进当前表单。
    expect(wrapper.findAll(".history-item")).toHaveLength(0);
    // 也不迁移不删除：旧值原样留存（一次性忽略语义）。
    expect(pluginStore.getItem(SEARCH_HISTORY_KEY)).toContain("(legacy=1)");
    expect(Array.isArray(JSON.parse(pluginStore.getItem(SEARCH_HISTORY_KEY)!))).toBe(true);
  });

  it("keeps the history trigger reachable in both compact and expanded forms", async () => {
    wrapper = await mountForm();
    expect(historyToggle(wrapper).exists()).toBe(true);
    await wrapper.find(".search-form-compact .compact-toggle").trigger("click");
    expect(wrapper.find(".search-form-compact").exists()).toBe(true);
    expect(wrapper.find(".search-advanced").classes()).not.toContain("is-collapsed");
    const expandedToggle = wrapper.find(".search-form-compact .history-toggle");
    expect(expandedToggle.exists()).toBe(true);
    // 展开态仍使用固定顶部触发按钮，切换的是同一个面板状态。
    await expandedToggle.trigger("click");
    expect(wrapper.find(".history-panel").exists()).toBe(true);
    await expandedToggle.trigger("click");
    expect(wrapper.find(".history-panel").exists()).toBe(false);
  });

  it("closes the dropdown on outside click and Escape", async () => {
    wrapper = await mountForm();
    await historyToggle(wrapper).trigger("click");
    // 面板内点击不算外点。
    await wrapper.find(".history-head").trigger("click");
    expect(wrapper.find(".history-panel").exists()).toBe(true);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".history-panel").exists()).toBe(false);
    await historyToggle(wrapper).trigger("click");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".history-panel").exists()).toBe(false);
  });
});
