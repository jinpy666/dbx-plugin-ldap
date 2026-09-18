// @vitest-environment happy-dom
// ResultTable 批量选择/批量删除入口测试（AG Grid 版）：复选框（stub 等价物）多选、
// 复选框点击不触发行 open、删除行内两步确认（armed → 再点执行 / 超时回落 /
// 选择变化解除，payload 原始大小写、条目顺序）、entries 变化清空选择。
// 真实复选框/表头全选行为由 ag-grid 内建（DbxAgGrid.spec）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, type PropType } from "vue";
import ResultTable from "./ResultTable.vue";
import type { LdapEntry } from "../lib/api";
import { t } from "../lib/i18n";

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

  it("arms on first click and only emits batchDelete on the armed second click, then clears the selection", async () => {
    const wrapper = mountTable();
    await checks(wrapper)[0].trigger("click");
    await checks(wrapper)[1].trigger("click");
    // 首次点击：进入确认态（文案切既有 confirm 键），不触发删除。
    await wrapper.find(".batch-delete").trigger("click");
    expect(wrapper.emitted("batchDelete")).toBeUndefined();
    expect(wrapper.find(".batch-delete").classes()).toContain("is-armed");
    expect(wrapper.find(".batch-delete").text()).toBe(t("confirm"));
    // 确认态再点：按条目顺序 emit 原始大小写 DN，随后清空选择并解除确认态。
    await wrapper.find(".batch-delete").trigger("click");
    expect(wrapper.emitted("batchDelete")).toHaveLength(1);
    expect(wrapper.emitted("batchDelete")![0][0]).toEqual([
      "cn=alice,dc=demo,dc=dbx",
      "cn=Bob,dc=demo,dc=dbx",
    ]);
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("falls back to unarmed after 3 seconds without confirmation", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountTable();
      await checks(wrapper)[0].trigger("click");
      await wrapper.find(".batch-delete").trigger("click");
      expect(wrapper.find(".batch-delete").classes()).toContain("is-armed");
      vi.advanceTimersByTime(3000);
      await flushPromises();
      // 超时回落：确认态解除，此时点击只重新进入确认态、不触发删除。
      expect(wrapper.find(".batch-delete").classes()).not.toContain("is-armed");
      await wrapper.find(".batch-delete").trigger("click");
      expect(wrapper.emitted("batchDelete")).toBeUndefined();
      expect(wrapper.find(".batch-delete").classes()).toContain("is-armed");
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarms the pending delete confirmation when the selection changes", async () => {
    const wrapper = mountTable();
    await checks(wrapper)[0].trigger("click");
    await checks(wrapper)[1].trigger("click");
    await wrapper.find(".batch-delete").trigger("click");
    expect(wrapper.find(".batch-delete").classes()).toContain("is-armed");
    // 取消一条选中 → 确认态解除；再点一次只重新进入确认态，不触发删除。
    await checks(wrapper)[0].trigger("click");
    expect(wrapper.find(".batch-delete").classes()).not.toContain("is-armed");
    expect(wrapper.find(".batch-bar").exists()).toBe(true);
    await wrapper.find(".batch-delete").trigger("click");
    expect(wrapper.emitted("batchDelete")).toBeUndefined();
    expect(wrapper.find(".batch-delete").classes()).toContain("is-armed");
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

// 批量修改入口（对标 ADS 批量操作）：交互与批量移动同款——按钮随批量条出现、
// disabled 时禁用，emit batchModify 的 payload 与 batchMove/batchDelete 同序同
// 原始大小写，随后清空选择。操作类型/属性名/值由 App 侧 BatchModifyDialog 选择。
describe("ResultTable batch modify", () => {
  it("emits batchModify with the same payload shape as batchMove, then clears the selection", async () => {
    const wrapper = mountTable();
    await checks(wrapper)[0].trigger("click");
    await checks(wrapper)[1].trigger("click");
    const button = wrapper.find(".batch-modify");
    // 按钮与批量删除/移动并列出现在批量条中，文案走 i18n（动态断言，不硬编码语言）。
    expect(button.exists()).toBe(true);
    expect(button.attributes("disabled")).toBeUndefined();
    expect(button.text()).toBe(t("result.batchModify"));
    await button.trigger("click");
    expect(wrapper.emitted("batchModify")).toHaveLength(1);
    // 与 batchMove 同一选中集（前两条，含混合大小写 DN）同序同大小写。
    expect(wrapper.emitted("batchModify")![0][0]).toEqual([
      "cn=alice,dc=demo,dc=dbx",
      "cn=Bob,dc=demo,dc=dbx",
    ]);
    // emit 后选择清空：批量条消失、stub 选择集复位。
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    expect(gridStubState.selected).toHaveLength(0);
    wrapper.unmount();
  });

  it("does not emit batchModify when the table is disabled", async () => {
    const wrapper = mountTable({ disabled: true });
    await checks(wrapper)[0].trigger("click");
    expect(wrapper.find(".batch-bar").exists()).toBe(true);
    expect(wrapper.find(".batch-modify").attributes("disabled")).toBeDefined();
    await wrapper.find(".batch-modify").trigger("click");
    expect(wrapper.emitted("batchModify")).toBeUndefined();
    wrapper.unmount();
  });
});

// 只读连接（canWrite=false）：批量删除/移动/修改三个写入口全部禁用且 title
// 走只读提示（与编辑器/导入对话框同一 i18n 键）；组件函数层同步拦截，键盘/
// 自动化触达也不 emit（App 侧 guardWrite 同语义兜底，后端 policy 最终拒绝）。
// 清除选择是本地行为，不受只读影响。
describe("ResultTable read-only gating", () => {
  it("disables batch delete/move/modify with the read-only hint and never emits write events when canWrite is false", async () => {
    const wrapper = mountTable({ canWrite: false });
    await checks(wrapper)[0].trigger("click");
    await checks(wrapper)[1].trigger("click");
    expect(wrapper.find(".batch-bar").exists()).toBe(true);
    for (const selector of [".batch-delete", ".batch-move", ".batch-modify"]) {
      const button = wrapper.find(selector);
      expect(button.attributes("disabled")).toBeDefined();
      expect(button.attributes("title")).toBe(t("editor.readonlyHint"));
      await button.trigger("click");
    }
    expect(wrapper.emitted("batchDelete")).toBeUndefined();
    expect(wrapper.emitted("batchMove")).toBeUndefined();
    expect(wrapper.emitted("batchModify")).toBeUndefined();
    await wrapper.find(".batch-clear").trigger("click");
    expect(wrapper.find(".batch-bar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps the batch write buttons enabled by default (canWrite defaults to true)", async () => {
    const wrapper = mountTable();
    await checks(wrapper)[0].trigger("click");
    expect(wrapper.find(".batch-move").attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".batch-move").attributes("title")).toBe(t("result.batchMove"));
    wrapper.unmount();
  });
});
