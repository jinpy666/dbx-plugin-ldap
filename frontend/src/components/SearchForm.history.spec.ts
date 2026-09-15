// @vitest-environment happy-dom
// SearchForm 历史过滤器（对账表 P1，对标 ADS 搜索历史）：recordSearch 本地入队
// （队首去重 / 10 条上限 / localStorage 持久化与重挂载恢复），下拉应用只回填表单
// 不自动运行，confirm 清空，快捷条与展开态双入口。
// Network calls (presets/schema) reject harmlessly without a dbxPlugin host bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import SearchForm from "./SearchForm.vue";
import type { SearchFormModel } from "./SearchForm.vue";

const HISTORY_KEY = "dbx.ldap.ui.searchHistory";

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
    ...overrides,
  };
}

async function mountForm() {
  const mounted = mount(SearchForm, { props: { baseDn: "dc=demo,dc=dbx" } });
  await mounted.vm.$nextTick();
  return mounted;
}

const record = (wrapper: Wrapper, model: SearchFormModel) => (wrapper.vm as unknown as Exposed).recordSearch(model);

const storedHistory = () => JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "[]") as Array<Record<string, string>>;

const historyToggle = (wrapper: Wrapper) => wrapper.find(".search-form-compact .history-toggle");

let wrapper: Wrapper | undefined;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.unstubAllGlobals();
});

describe("SearchForm search history", () => {
  it("records searches locally, persists them and restores after remount", async () => {
    wrapper = await mountForm();
    record(wrapper, baseModel());
    record(wrapper, baseModel({ filter: "(cn=admin)", scope: "one", baseDn: "ou=people,dc=demo,dc=dbx", attributes: "mail" }));
    expect(storedHistory()).toHaveLength(2);
    expect(storedHistory()[0]).toEqual({ filter: "(cn=admin)", baseDn: "ou=people,dc=demo,dc=dbx", scope: "one", attributes: "mail" });
    wrapper.unmount();
    // 重挂载后从 localStorage 恢复，新条目在前。
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

  it("clears the history after window.confirm and keeps it on dismiss", async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    wrapper = await mountForm();
    record(wrapper, baseModel());
    await historyToggle(wrapper).trigger("click");
    await wrapper.find(".history-clear").trigger("click");
    expect(confirmSpy).toHaveBeenCalledWith("确认清空过滤器历史?");
    expect(wrapper.find(".history-empty").exists()).toBe(true);
    expect(wrapper.findAll(".history-item")).toHaveLength(0);
    expect(window.localStorage.getItem(HISTORY_KEY)).toBe("[]");
    // 取消确认则保留历史。
    record(wrapper, baseModel({ filter: "(cn=keep)" }));
    vi.stubGlobal("confirm", vi.fn(() => false));
    await wrapper.find(".history-clear").trigger("click");
    expect(storedHistory().map((entry) => entry.filter)).toEqual(["(cn=keep)"]);
    expect(wrapper.find(".history-item").text()).toContain("(cn=keep)");
  });

  it("keeps the history trigger reachable in both compact and expanded forms", async () => {
    wrapper = await mountForm();
    expect(historyToggle(wrapper).exists()).toBe(true);
    await wrapper.find(".search-form-compact .compact-toggle").trigger("click");
    expect(wrapper.find(".search-form-compact").exists()).toBe(false);
    const expandedToggle = wrapper.find(".filter-head .history-toggle");
    expect(expandedToggle.exists()).toBe(true);
    // 展开态触发按钮切换的是同一个面板状态。
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
