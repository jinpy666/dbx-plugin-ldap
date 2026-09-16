// @vitest-environment happy-dom
// ResultTable 批量选择/批量删除入口测试（AG Grid 版）：复选框（stub 等价物）多选、
// 复选框点击不触发行 open、删除确认事件 payload（原始大小写、条目顺序）、
// entries 变化清空选择。真实复选框/表头全选行为由 ag-grid 内建（DbxAgGrid.spec）。
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

describe("ResultTable batch selection", () => {
  it("shows the batch bar with a correct count after checking rows, and unchecking updates it", async () => {
    const wrapper = mountTable();
    // 未选中时批量操作条不渲染。
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    await checks(wrapper)[0].trigger("click");
    await checks(wrapper)[1].trigger("click");
    expect(wrapper.find(".batch-bar").text()).toContain("已选 2 项");
    // 取消一条 → 计数回落。
    await checks(wrapper)[0].trigger("click");
    expect(wrapper.find(".batch-bar").text()).toContain("已选 1 项");
    wrapper.unmount();
  });

  it("does not trigger the row open event when a row checkbox is clicked", async () => {
    const wrapper = mountTable();
    await checks(wrapper)[0].trigger("click");
    expect(wrapper.emitted("open")).toBeUndefined();
    // 行的既有交互不受影响：行激活（双击/Enter 路径）仍打开条目。
    await wrapper.findAll(".grid-stub-row")[0].trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
    expect(wrapper.emitted("open")![0][0]).toBe("cn=alice,dc=demo,dc=dbx");
    wrapper.unmount();
  });

  it("emits batchDelete with original-case DNs in entry order when confirmed, and nothing when cancelled", async () => {
    const wrapper = mountTable();
    // happy-dom 未内置 confirm，按仓库先例（SearchForm.presets.spec）stub 全局。
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    await checks(wrapper)[0].trigger("click");
    await checks(wrapper)[1].trigger("click");
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

  it("clears the batch bar via the clear button", async () => {
    const wrapper = mountTable();
    await checks(wrapper)[0].trigger("click");
    await wrapper.find(".batch-clear").trigger("click");
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    expect(gridStubState.selected).toHaveLength(0);
    wrapper.unmount();
  });

  it("clears the selection when entries change (grid deselectAll is invoked)", async () => {
    const wrapper = mountTable();
    await checks(wrapper)[0].trigger("click");
    expect(wrapper.find(".batch-bar").exists()).toBe(true);
    await wrapper.setProps({
      entries: [{ dn: "cn=dave,dc=demo,dc=dbx", attributes: { cn: ["dave"] } }],
      count: 1,
    });
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    expect(gridStubState.deselectCalls).toBeGreaterThanOrEqual(1);
    wrapper.unmount();
  });

  it("disables the batch actions when the table is disabled", async () => {
    const wrapper = mountTable({ disabled: true });
    await checks(wrapper)[0].trigger("click");
    expect(wrapper.find(".batch-bar").exists()).toBe(true);
    expect(wrapper.find(".batch-delete").attributes("disabled")).toBeDefined();
    await wrapper.find(".batch-delete").trigger("click");
    expect(wrapper.emitted("batchDelete")).toBeUndefined();
    wrapper.unmount();
  });
});
