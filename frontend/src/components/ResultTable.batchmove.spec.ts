// @vitest-environment happy-dom
// ResultTable 批量移动入口测试（AG Grid 版）：批量条「移动所选」按钮 emit batchMove，
// payload 与 batchDelete 同序同原始大小写；disabled 时不发；emit 后清空选择；
// 并简单复验既有批量删除主断言（详细断言归 ResultTable.batch.spec.ts）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, type PropType } from "vue";
import ResultTable from "./ResultTable.vue";
import type { LdapEntry } from "../lib/api";

// 第二条故意用混合大小写 DN：选择键是小写 DN，事件 payload 必须取回原始大小写。
const entries: LdapEntry[] = [
  { dn: "cn=alice,dc=demo,dc=dbx", attributes: { cn: ["alice"] } },
  { dn: "cn=Bob,dc=demo,dc=dbx", attributes: { cn: ["Bob"] } },
  { dn: "cn=carol,dc=demo,dc=dbx", attributes: { cn: ["carol"] } },
];

// -- DbxAgGrid 轻量 stub（镜像真实桥形状，见 DbxAgGrid.spec 同款） --------------------
const gridStubState = { selected: [] as unknown[], deselectCalls: 0 };

const DbxAgGridStub = defineComponent({
  name: "DbxAgGridStub",
  props: {
    rowData: { type: Array as PropType<unknown[]>, default: () => [] },
    columnDefs: { type: Array as PropType<unknown[]>, default: () => [] },
    tableKey: { type: String, default: "" },
    rowSelection: { type: [String, Boolean] as PropType<"multi" | false>, default: "multi" as const },
    columnStateKey: { type: String, default: undefined },
  },
  emits: ["rowActivate", "selectionChanged"],
  setup(props, { emit, expose }) {
    expose({
      deselectAll: () => {
        gridStubState.deselectCalls += 1;
        gridStubState.selected = [];
        emit("selectionChanged", []);
      },
    });
    const toggleRow = (row: unknown) => {
      const dn = String((row as { dn?: unknown }).dn ?? "");
      const index = gridStubState.selected.findIndex((candidate) => String((candidate as { dn?: unknown }).dn ?? "") === dn);
      if (index >= 0) gridStubState.selected.splice(index, 1);
      else gridStubState.selected.push(row);
      emit("selectionChanged", [...gridStubState.selected]);
    };
    return () =>
      h(
        "div",
        { class: "grid-stub" },
        (props.rowData ?? []).map((row, index) =>
          h("div", { class: "grid-stub-line", key: index }, [
            h("button", { class: "grid-stub-row", "data-dn": String((row as { dn?: unknown }).dn ?? ""), onClick: () => emit("rowActivate", row) }, String((row as { dn?: unknown }).dn ?? "")),
            h("button", { class: "grid-stub-check", "data-dn": String((row as { dn?: unknown }).dn ?? ""), onClick: () => toggleRow(row) }, "☑"),
          ]),
        ),
      );
  },
});

function mountTable(props: Record<string, unknown> = {}) {
  return mount(ResultTable, {
    props: { entries, count: entries.length, truncated: false, ...props },
    global: { stubs: { DbxAgGrid: DbxAgGridStub } },
  });
}

function checks(wrapper: ReturnType<typeof mountTable>) {
  return wrapper.findAll(".grid-stub-check");
}

beforeEach(() => {
  gridStubState.selected = [];
  gridStubState.deselectCalls = 0;
});

describe("ResultTable batch move", () => {
  it("emits batchMove with original-case DNs in entry order, then clears the selection", async () => {
    const wrapper = mountTable();
    await checks(wrapper)[0].trigger("click");
    await checks(wrapper)[1].trigger("click");
    // 与 batchDelete 相同的选中集（前两条，含混合大小写 DN）。
    await wrapper.find(".batch-move").trigger("click");
    expect(wrapper.emitted("batchMove")).toHaveLength(1);
    expect(wrapper.emitted("batchMove")![0][0]).toEqual([
      "cn=alice,dc=demo,dc=dbx",
      "cn=Bob,dc=demo,dc=dbx",
    ]);
    // emit 后选择清空：批量条消失、stub 选择集复位。
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    expect(gridStubState.selected).toHaveLength(0);
    wrapper.unmount();
  });

  it("does not emit batchMove when the table is disabled", async () => {
    const wrapper = mountTable({ disabled: true });
    await checks(wrapper)[0].trigger("click");
    expect(wrapper.find(".batch-bar").exists()).toBe(true);
    expect(wrapper.find(".batch-move").attributes("disabled")).toBeDefined();
    await wrapper.find(".batch-move").trigger("click");
    expect(wrapper.emitted("batchMove")).toBeUndefined();
    wrapper.unmount();
  });

  it("keeps existing batchDelete behavior intact (no regression)", async () => {
    const wrapper = mountTable();
    // happy-dom 未内置 confirm，按仓库先例 stub 全局（见 ResultTable.batch.spec.ts）。
    vi.stubGlobal("confirm", () => true);
    await checks(wrapper)[0].trigger("click");
    await checks(wrapper)[1].trigger("click");
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
