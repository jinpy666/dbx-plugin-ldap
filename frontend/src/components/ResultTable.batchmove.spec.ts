// @vitest-environment happy-dom
// ResultTable 批量移动入口测试：批量条「移动所选」按钮 emit batchMove，
// payload 与 batchDelete 同序同原始大小写；disabled 时不发；emit 后清空选择；
// 并简单复验既有批量删除主断言（详细断言归 ResultTable.batch.spec.ts）。
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ResultTable batch move", () => {
  it("emits batchMove with original-case DNs in entry order, then clears the selection", async () => {
    const wrapper = mountTable();
    await rowChecks(wrapper)[0].trigger("click");
    await rowChecks(wrapper)[1].trigger("click");
    // 与 batchDelete 相同的选中集（前两条，含混合大小写 DN）。
    await wrapper.find(".batch-move").trigger("click");
    expect(wrapper.emitted("batchMove")).toHaveLength(1);
    expect(wrapper.emitted("batchMove")![0][0]).toEqual([
      "cn=alice,dc=demo,dc=dbx",
      "cn=Bob,dc=demo,dc=dbx",
    ]);
    // emit 后选择清空：批量条消失、行复选框复位。
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    expect(rowChecks(wrapper).every((check) => !check.element.checked)).toBe(true);
    wrapper.unmount();
  });

  it("does not emit batchMove when the table is disabled", async () => {
    const wrapper = mount(ResultTable, { props: { entries, count: entries.length, truncated: false, disabled: true } });
    // disabled 下行复选框均禁用、点不动 → 无法进入选中态，批量条/按钮不渲染。
    expect(rowChecks(wrapper).every((check) => check.element.disabled)).toBe(true);
    await rowChecks(wrapper)[0].trigger("click");
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    expect(wrapper.find(".batch-move").exists()).toBe(false);
    expect(wrapper.emitted("batchMove")).toBeUndefined();
    wrapper.unmount();
  });

  it("keeps existing batchDelete behavior intact (no regression)", async () => {
    const wrapper = mountTable();
    // happy-dom 未内置 confirm，按仓库先例 stub 全局（见 ResultTable.batch.spec.ts）。
    vi.stubGlobal("confirm", () => true);
    await rowChecks(wrapper)[0].trigger("click");
    await rowChecks(wrapper)[1].trigger("click");
    await wrapper.find(".batch-delete").trigger("click");
    expect(wrapper.emitted("batchDelete")).toHaveLength(1);
    expect(wrapper.emitted("batchDelete")![0][0]).toEqual([
      "cn=alice,dc=demo,dc=dbx",
      "cn=Bob,dc=demo,dc=dbx",
    ]);
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    wrapper.unmount();
  });
});
