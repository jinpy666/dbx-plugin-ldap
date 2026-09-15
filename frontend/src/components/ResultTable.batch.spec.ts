// @vitest-environment happy-dom
// ResultTable 批量选择/批量删除入口测试：行复选框多选、全选切换、复选框点击
// 不触发行 open、删除确认事件 payload、entries 变化清空选择。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type DOMWrapper } from "@vue/test-utils";
import ResultTable from "./ResultTable.vue";
import type { LdapEntry } from "../lib/api";

// 第二条故意用混合大小写 DN：选择键是小写 DN，事件 payload 必须取回原始大小写。
const entries: LdapEntry[] = [
  { dn: "cn=alice,dc=demo,dc=dbx", attributes: { cn: ["alice"] } },
  { dn: "cn=Bob,dc=demo,dc=dbx", attributes: { cn: ["Bob"] } },
  { dn: "cn=carol,dc=demo,dc=dbx", attributes: { cn: ["carol"] } },
];

function mountTable() {
  return mount(ResultTable, { props: { entries, count: entries.length, truncated: false } });
}

function rowChecks(wrapper: ReturnType<typeof mountTable>): DOMWrapper<HTMLInputElement>[] {
  return wrapper.findAll(".result-row input[type='checkbox']") as DOMWrapper<HTMLInputElement>[];
}

function headerCheck(wrapper: ReturnType<typeof mountTable>): DOMWrapper<HTMLInputElement> {
  return wrapper.find(".col-check input[type='checkbox']") as DOMWrapper<HTMLInputElement>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ResultTable batch selection", () => {
  it("shows the batch bar with a correct count after checking a row checkbox", async () => {
    const wrapper = mountTable();
    // 未选中时批量操作条不渲染。
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    await rowChecks(wrapper)[0].trigger("click");
    await rowChecks(wrapper)[1].trigger("click");
    const bar = wrapper.find(".batch-bar");
    expect(bar.exists()).toBe(true);
    expect(bar.text()).toContain("已选 2 项");
    expect(rowChecks(wrapper)[0].element.checked).toBe(true);
    expect(rowChecks(wrapper)[1].element.checked).toBe(true);
    expect(rowChecks(wrapper)[2].element.checked).toBe(false);
    wrapper.unmount();
  });

  it("selects all entries via the header checkbox and clears them on a second click", async () => {
    const wrapper = mountTable();
    await headerCheck(wrapper).trigger("click");
    expect(rowChecks(wrapper).every((check) => check.element.checked)).toBe(true);
    expect(wrapper.find(".batch-bar").text()).toContain("已选 3 项");
    // 再次点击全选 = 清空选择。
    await headerCheck(wrapper).trigger("click");
    expect(rowChecks(wrapper).every((check) => check.element.checked)).toBe(false);
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not trigger the row open event when a row checkbox is clicked", async () => {
    const wrapper = mountTable();
    await rowChecks(wrapper)[0].trigger("click");
    expect(wrapper.emitted("open")).toBeUndefined();
    // 行的既有交互不受影响：双击仍打开条目。
    await wrapper.findAll(".result-row")[0].trigger("dblclick");
    expect(wrapper.emitted("open")).toHaveLength(1);
    expect(wrapper.emitted("open")![0][0]).toBe("cn=alice,dc=demo,dc=dbx");
    wrapper.unmount();
  });

  it("emits batchDelete with original-case DNs when confirmed, and nothing when cancelled", async () => {
    const wrapper = mountTable();
    // happy-dom 未内置 confirm，按仓库先例（SearchForm.presets.spec）stub 全局。
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    await rowChecks(wrapper)[0].trigger("click");
    await rowChecks(wrapper)[1].trigger("click");
    // 取消：不 emit、选择保留。
    await wrapper.find(".batch-delete").trigger("click");
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("batchDelete")).toBeUndefined();
    expect(wrapper.find(".batch-bar").exists()).toBe(true);
    // 确认：emit 原始大小写 DN（按条目顺序），随后清空选择。
    confirmMock.mockReturnValue(true);
    await wrapper.find(".batch-delete").trigger("click");
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted("batchDelete")).toHaveLength(1);
    expect(wrapper.emitted("batchDelete")![0][0]).toEqual([
      "cn=alice,dc=demo,dc=dbx",
      "cn=Bob,dc=demo,dc=dbx",
    ]);
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("clears the selection when entries change", async () => {
    const wrapper = mountTable();
    await rowChecks(wrapper)[0].trigger("click");
    expect(wrapper.find(".batch-bar").exists()).toBe(true);
    await wrapper.setProps({
      entries: [{ dn: "cn=dave,dc=demo,dc=dbx", attributes: { cn: ["dave"] } }],
      count: 1,
    });
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    expect(rowChecks(wrapper)[0].element.checked).toBe(false);
    wrapper.unmount();
  });

  it("disables batch controls when the table is disabled", () => {
    const wrapper = mount(ResultTable, { props: { entries, count: entries.length, truncated: false, disabled: true } });
    expect(rowChecks(wrapper).every((check) => check.element.disabled)).toBe(true);
    expect(headerCheck(wrapper).element.disabled).toBe(true);
    wrapper.unmount();
  });
});
