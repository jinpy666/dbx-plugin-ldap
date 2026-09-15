// @vitest-environment happy-dom
// SearchForm 折叠快捷条（对标 Apache Directory Studio 快捷搜索形态）：
// 默认单行快捷条 + 高级区 hidden 收起（DOM 保留，构建器/源码状态不丢），
// localStorage 记忆折叠偏好，expandSearch() 供宿主（MCP focus intent）展开。
// Network calls (presets/schema) reject harmlessly without a dbxPlugin host bridge.
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SearchForm from "./SearchForm.vue";

const COLLAPSED_KEY = "dbx.ldap.ui.searchCollapsed";

type Exposed = {
  expandSearch: () => void;
  runSubtreeAt: (dn: string) => void;
};

async function mountForm() {
  const wrapper = mount(SearchForm, { props: { baseDn: "dc=demo,dc=dbx" } });
  await wrapper.vm.$nextTick();
  return wrapper;
}

const compactBar = (wrapper: Awaited<ReturnType<typeof mountForm>>) => wrapper.find(".search-form-compact");
const compactFilter = (wrapper: Awaited<ReturnType<typeof mountForm>>) => wrapper.find(".search-form-compact .compact-filter");

beforeEach(() => {
  // 各用例对折叠偏好的写入互不干扰；happy-dom 每文件独立环境，这里兜底清场。
  window.localStorage.clear();
});

describe("SearchForm collapsed quick bar", () => {
  it("defaults to the compact bar with the advanced area hidden, not unmounted", async () => {
    const wrapper = await mountForm();
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBeNull();
    expect(compactBar(wrapper).exists()).toBe(true);
    expect(compactBar(wrapper).isVisible()).toBe(true);
    // 默认值即快捷条形态：Base DN / scope / 过滤器框 / Run / 展开按钮同处一行。
    expect((compactBar(wrapper).find("input.mono").element as HTMLInputElement).value).toBe("dc=demo,dc=dbx");
    expect((compactBar(wrapper).find("select").element as HTMLSelectElement).value).toBe("sub");
    // 构建器模式的空条件生成空串（同 qb-preview 的匹配全部兜底语义）。
    expect((compactFilter(wrapper).element as HTMLInputElement).value).toBe("");
    expect(compactBar(wrapper).find("button[type='submit']").exists()).toBe(true);
    expect(compactBar(wrapper).find(".compact-toggle").attributes("aria-expanded")).toBe("false");
    // 高级区只是收起（hidden），DOM 仍在，展开后状态原样回来。
    expect(wrapper.find(".filter-block").isVisible()).toBe(false);
    expect(wrapper.find(".search-extra").isVisible()).toBe(false);
    expect(wrapper.find(".command-import").isVisible()).toBe(false);
    expect(wrapper.find(".search-presets").isVisible()).toBe(false);
    expect(wrapper.find(".filter-block").exists()).toBe(true);
  });

  it("expands to the full form via expandSearch() and keeps state; collapses back via the toggle", async () => {
    const wrapper = await mountForm();
    // 收起态改的范围在展开后必须原样保留（切换不重置任何表单状态）。
    await compactBar(wrapper).find("select").setValue("one");
    (wrapper.vm as unknown as Exposed).expandSearch();
    await wrapper.vm.$nextTick();
    expect(compactBar(wrapper).exists()).toBe(false);
    expect(wrapper.find(".qb-preview").isVisible()).toBe(true);
    expect(wrapper.find(".search-extra").isVisible()).toBe(true);
    expect(wrapper.find(".search-presets").isVisible()).toBe(true);
    expect((wrapper.find(".field select").element as HTMLSelectElement).value).toBe("one");
    // 展开态定位行的收起按钮可再次折叠（title/aria 状态同步翻转）。
    const toggle = wrapper.find(".field .compact-toggle");
    expect(toggle.attributes("title")).toBe("收起搜索高级选项");
    await toggle.trigger("click");
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".filter-block").isVisible()).toBe(false);
    expect(wrapper.find(".search-form-compact .compact-filter").exists()).toBe(true);
  });

  it("expands via the toggle button on the compact bar", async () => {
    const wrapper = await mountForm();
    const toggle = compactBar(wrapper).find(".compact-toggle");
    expect(toggle.attributes("aria-label")).toBe("高级");
    await toggle.trigger("click");
    await wrapper.vm.$nextTick();
    expect(compactBar(wrapper).exists()).toBe(false);
    expect(wrapper.find(".qb-preview").isVisible()).toBe(true);
    expect(wrapper.find(".search-presets").isVisible()).toBe(true);
  });

  it("runs the typed filter from the compact bar in source mode, flagging invalid input inline", async () => {
    const wrapper = await mountForm();
    // 构建器生成的初始串一旦被改动即落源码模式（源码是唯一权威表示）。
    await compactFilter(wrapper).setValue("(uid");
    expect(compactFilter(wrapper).attributes("aria-invalid")).toBe("true");
    expect(wrapper.find(".search-form-compact .form-error").exists()).toBe(true);
    expect(wrapper.find("button[type='submit']").attributes("disabled")).toBeDefined();
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("run")).toBeUndefined();
    await compactFilter(wrapper).setValue("(uid=jin)");
    expect(compactFilter(wrapper).attributes("aria-invalid")).toBe("false");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("run")?.[0][0]).toMatchObject({ baseDn: "dc=demo,dc=dbx", filter: "(uid=jin)" });
  });

  it("restores the persisted collapsed preference across remounts", async () => {
    window.localStorage.setItem(COLLAPSED_KEY, "0");
    const expanded = await mountForm();
    expect(expanded.find(".search-form-compact").exists()).toBe(false);
    expect(expanded.find(".filter-block").isVisible()).toBe(true);
    expanded.unmount();
    window.localStorage.setItem(COLLAPSED_KEY, "1");
    const collapsed = await mountForm();
    expect(collapsed.find(".search-form-compact").isVisible()).toBe(true);
    expect(collapsed.find(".filter-block").isVisible()).toBe(false);
  });

  it("keeps runSubtreeAt working from the collapsed state", async () => {
    const wrapper = await mountForm();
    (wrapper.vm as unknown as Exposed).runSubtreeAt("dc=example,dc=com");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("run")?.[0][0]).toMatchObject({
      baseDn: "dc=example,dc=com",
      scope: "sub",
      filter: "(objectClass=*)",
    });
  });
});
