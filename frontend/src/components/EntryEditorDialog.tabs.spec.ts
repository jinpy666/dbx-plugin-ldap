// @vitest-environment happy-dom
// F9 多开页签（条目编辑器工作集，最小形态）专项测试：
// - 页签条渲染门槛（openTabs ≤1 不渲染 / ≥2 渲染 + active 标记 + RDN 标签）
// - 脏态否决：dirty 时点其他页签不发 switchTab、改发 notify("有未保存的修改")
// - ✕ 只上报 closeTab（含 active 页签；click.stop 不连带 switchTab）
// - dirtyChange 随值编辑翻转（false→true→false）
// - add 态（新建条目）不渲染页签条
// - 键盘导航（WAI-ARIA tabs，manual activation）：roving tabindex、方向键
//   循环移动焦点、Home/End 跳首尾；焦点移动不触发 switchTab（Enter 才切换）
// ldapApi mock 方式照抄既有 EntryEditorDialog 专项 spec；工作集状态由测试
// 用例以 props 扮演控制方（App 未接线时组件零变化）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { ldapApi, type LdapEntry } from "../lib/api";

vi.mock("../lib/api", () => ({
  ldapApi: {
    entryAdd: vi.fn(),
    entryModify: vi.fn(),
  },
}));

import EntryEditorDialog from "./EntryEditorDialog.vue";

const entryAddMock = vi.mocked(ldapApi.entryAdd);
const entryModifyMock = vi.mocked(ldapApi.entryModify);

beforeEach(() => {
  entryAddMock.mockReset();
  entryModifyMock.mockReset();
});

const entryA: LdapEntry = {
  dn: "cn=alice,dc=demo,dc=dbx",
  attributes: { cn: ["alice"], description: ["line1\nline2"], objectClass: ["top", "person"] },
};
const entryB: LdapEntry = { dn: "cn=bob,dc=demo,dc=dbx", attributes: { cn: ["bob"], objectClass: ["top", "person"] } };

const tracked: Awaited<ReturnType<typeof mountEditor>>[] = [];

type EditorProps = {
  canWrite?: boolean;
  open?: boolean;
  entry?: LdapEntry;
  parentDn?: string;
  openTabs?: string[];
  activeTabDn?: string;
};

function mountEditor(props: EditorProps = {}) {
  return mount(EntryEditorDialog, { props: { canWrite: true, open: true, ...props } });
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = (props?: EditorProps) => {
  const wrapper = mountEditor(props);
  tracked.push(wrapper);
  return wrapper;
};

// 键盘导航断言依赖 document.activeElement：组件必须 attach 到真实文档树
// （happy-dom 对 detached 元素 focus() 无效），用法同主 spec 的焦点断言。
const trackAttached = (props?: EditorProps) => {
  const wrapper = mount(EntryEditorDialog, { props: { canWrite: true, open: true, ...props }, attachTo: document.body });
  tracked.push(wrapper);
  return wrapper;
};

const tabBar = (wrapper: Awaited<ReturnType<typeof mountEditor>>) => wrapper.find(".entry-tabs");
const tabs = (wrapper: Awaited<ReturnType<typeof mountEditor>>) => wrapper.findAll(".entry-tab");
const shells = (wrapper: Awaited<ReturnType<typeof mountEditor>>) => wrapper.findAll(".entry-tab-shell");
const closeButtons = (wrapper: Awaited<ReturnType<typeof mountEditor>>) => wrapper.findAll(".entry-tab-close");
// rows 按属性名字典序：cn / description / objectClass；description 的 textarea
// 是常规文本编辑器，用它驱动 dirty 翻转。
const descriptionTextarea = (wrapper: Awaited<ReturnType<typeof mountEditor>>) =>
  wrapper.findAll(".attr-editor .attr-row")[1].find("textarea");

describe("EntryEditorDialog open-entry tabs (F9)", () => {
  it("hides the tab bar with 0/1 open tabs and renders RDN labels + active marks with 2", () => {
    const single = track({ entry: entryA, openTabs: [entryA.dn], activeTabDn: entryA.dn });
    expect(tabBar(single).exists()).toBe(false);

    const pair = track({ entry: entryA, openTabs: [entryA.dn, entryB.dn], activeTabDn: entryB.dn });
    expect(tabBar(pair).exists()).toBe(true);
    expect(tabs(pair)).toHaveLength(2);
    // 标签 = splitFirstDnRdn 的 RDN；title = 完整 DN（原始大小写）。
    expect(tabs(pair)[0].text()).toBe("cn=alice");
    expect(tabs(pair)[1].text()).toBe("cn=bob");
    expect(tabs(pair)[0].attributes("title")).toBe(entryA.dn);
    expect(tabs(pair)[1].attributes("title")).toBe(entryB.dn);
    // active 标记：is-active 类 + aria-selected 只落在激活页签上。
    expect(shells(pair)[0].classes()).not.toContain("is-active");
    expect(shells(pair)[1].classes()).toContain("is-active");
    expect(tabs(pair)[0].attributes("aria-selected")).toBe("false");
    expect(tabs(pair)[1].attributes("aria-selected")).toBe("true");
    // 不传 openTabs 时同样零渲染（向后兼容）。
    const legacy = track({ entry: entryA });
    expect(tabBar(legacy).exists()).toBe(false);
  });

  it("vetoes a tab switch while dirty (notify only) and allows it while clean", async () => {
    const wrapper = track({ entry: entryA, openTabs: [entryA.dn, entryB.dn], activeTabDn: entryA.dn });
    // 干净态：点击其他页签发 switchTab(payload DN)。
    await tabs(wrapper)[1].trigger("click");
    expect(wrapper.emitted("switchTab")).toEqual([[entryB.dn]]);
    // 脏态否决：改值后点击其他页签不发 switchTab，只提示「有未保存的修改」。
    await descriptionTextarea(wrapper).setValue("dirty value");
    await tabs(wrapper)[1].trigger("click");
    expect(wrapper.emitted("switchTab")).toHaveLength(1);
    expect(wrapper.emitted("notify")?.at(-1)).toEqual(["有未保存的修改"]);
    // 撤回修改后守卫解除。
    await descriptionTextarea(wrapper).setValue("line1\nline2");
    await tabs(wrapper)[1].trigger("click");
    expect(wrapper.emitted("switchTab")).toEqual([[entryB.dn], [entryB.dn]]);
  });

  it("emits closeTab from the ✕ button (active tab included) without switching", async () => {
    const wrapper = track({ entry: entryB, openTabs: [entryA.dn, entryB.dn], activeTabDn: entryB.dn });
    // 非 active 页签的 ✕：只发 closeTab(payload DN)，不触发 switchTab。
    await closeButtons(wrapper)[0].trigger("click");
    expect(wrapper.emitted("closeTab")).toEqual([[entryA.dn]]);
    expect(wrapper.emitted("switchTab")).toBeUndefined();
    // active 页签的 ✕ 同样只上报（是否连带关弹窗由控制方决定）。
    await closeButtons(wrapper)[1].trigger("click");
    expect(wrapper.emitted("closeTab")).toEqual([[entryA.dn], [entryB.dn]]);
  });

  it("emits dirtyChange on the dirty flip driven by value edits", async () => {
    const wrapper = track({ entry: entryA, openTabs: [entryA.dn, entryB.dn], activeTabDn: entryA.dn });
    // watch 非 immediate：初始不发声；编辑后 false→true，active 页签出现脏点。
    expect(wrapper.emitted("dirtyChange")).toBeUndefined();
    expect(wrapper.find(".entry-tab-dirty").exists()).toBe(false);
    await descriptionTextarea(wrapper).setValue("dirty value");
    expect(wrapper.emitted("dirtyChange")?.map((call) => call[0])).toEqual([true]);
    expect(wrapper.find(".entry-tab-dirty").exists()).toBe(true);
    // 撤回后 true→false，脏点消失。
    await descriptionTextarea(wrapper).setValue("line1\nline2");
    expect(wrapper.emitted("dirtyChange")?.map((call) => call[0])).toEqual([true, false]);
    expect(wrapper.find(".entry-tab-dirty").exists()).toBe(false);
  });

  it("hides the tab bar in add mode (a new entry is not part of the workset)", () => {
    const wrapper = track({
      parentDn: "ou=people,dc=demo,dc=dbx",
      openTabs: [entryA.dn, entryB.dn],
      activeTabDn: entryA.dn,
    });
    expect(wrapper.find("h2").text()).toBe("新增子条目");
    expect(tabBar(wrapper).exists()).toBe(false);
  });

  it("moves focus with arrow keys across tabs, wraps at both ends, and uses roving tabindex", async () => {
    const wrapper = trackAttached({ entry: entryA, openTabs: [entryA.dn, entryB.dn], activeTabDn: entryA.dn });
    // roving tabindex：激活页签是唯一 Tab 进入点（0），其余 -1。
    expect(tabs(wrapper)[0].attributes("tabindex")).toBe("0");
    expect(tabs(wrapper)[1].attributes("tabindex")).toBe("-1");
    // → 焦点右移；末尾循环回首。
    await tabs(wrapper)[0].trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs(wrapper)[1].element);
    await tabs(wrapper)[1].trigger("keydown", { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs(wrapper)[0].element);
    // ← 焦点左移；首部循环回末。
    await tabs(wrapper)[0].trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs(wrapper)[1].element);
    await tabs(wrapper)[1].trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs(wrapper)[0].element);
  });

  it("jumps to the first/last tab with Home/End and also navigates with vertical arrows", async () => {
    const wrapper = trackAttached({ entry: entryA, openTabs: [entryA.dn, entryB.dn], activeTabDn: entryA.dn });
    // End 跳尾、Home 跳首（顺序无关，任意页签上按都成立）。
    await tabs(wrapper)[0].trigger("keydown", { key: "End" });
    expect(document.activeElement).toBe(tabs(wrapper)[1].element);
    await tabs(wrapper)[1].trigger("keydown", { key: "Home" });
    expect(document.activeElement).toBe(tabs(wrapper)[0].element);
    // 竖向方向键同惯例（tablist 双向布局均支持）。
    await tabs(wrapper)[0].trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(tabs(wrapper)[1].element);
    await tabs(wrapper)[1].trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(tabs(wrapper)[0].element);
  });

  it("keeps manual activation: arrow/Home focus movement never switches, Enter still does", async () => {
    const wrapper = trackAttached({ entry: entryA, openTabs: [entryA.dn, entryB.dn], activeTabDn: entryA.dn });
    // 键盘只动焦点：不发 switchTab、不弹脏态提示（manual activation 语义）。
    await tabs(wrapper)[0].trigger("keydown", { key: "ArrowRight" });
    await tabs(wrapper)[1].trigger("keydown", { key: "Home" });
    await tabs(wrapper)[0].trigger("keydown", { key: "End" });
    expect(wrapper.emitted("switchTab")).toBeUndefined();
    expect(wrapper.emitted("notify")).toBeUndefined();
    // Enter 仍走既有切换路径（switchEntryTab，含脏态否决）。
    await tabs(wrapper)[1].trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("switchTab")).toEqual([[entryB.dn]]);
  });
});
