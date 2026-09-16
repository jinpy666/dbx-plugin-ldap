// @vitest-environment happy-dom
// ResultTable workbench UI tests（AG Grid 版）：
// - 空态两态文案（未搜索 vs 无匹配，UI 扫描 P2-3）、loading/error 覆盖
// - "at limit" 徽章（P2-15）
// - 网格接线：列数 = dn + 属性并集、行激活（双击/Enter 的 stub 等价物）→ open
// - 导出按钮与 disabled、键盘提示
// （ag-grid 本体的排序/筛选/分页由 DbxAgGrid.spec + ldapGrid.spec 锁定。）
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, type PropType } from "vue";
import ResultTable from "./ResultTable.vue";
import type { LdapEntry } from "../lib/api";

const entry: LdapEntry = { dn: "cn=alice,dc=demo,dc=dbx", attributes: { cn: ["alice"] } };

// -- DbxAgGrid 轻量 stub（镜像真实桥形状，见 DbxAgGrid.spec / batch spec 同款） --------
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
        { class: "grid-stub", "data-column-count": String(props.columnDefs.length) },
        (props.rowData ?? []).map((row, index) =>
          h("div", { class: "grid-stub-line", key: index }, [
            h("button", { class: "grid-stub-row", "data-dn": String((row as { dn?: unknown }).dn ?? ""), onClick: () => emit("rowActivate", row) }, String((row as { dn?: unknown }).dn ?? "")),
            h("button", { class: "grid-stub-check", "data-dn": String((row as { dn?: unknown }).dn ?? ""), onClick: () => toggleRow(row) }, "☑"),
          ]),
        ),
      );
  },
});

function mountTable(props: { entries: LdapEntry[]; count: number; truncated?: boolean; searched?: boolean; atLimit?: boolean; sizeLimit?: number; loading?: boolean; error?: string; disabled?: boolean }) {
  return mount(ResultTable, {
    props: { truncated: false, ...props },
    global: { stubs: { DbxAgGrid: DbxAgGridStub } },
  });
}

beforeEach(() => {
  gridStubState.selected = [];
  gridStubState.deselectCalls = 0;
});

describe("ResultTable empty states (P2-3)", () => {
  it.each([{ entries: [] }, { entries: [entry] }])("shows loading instead of stale or empty results", ({ entries }) => {
    const wrapper = mountTable({ entries, count: entries.length, loading: true, searched: true });
    expect(wrapper.find("[role='status']").text()).toBe("搜索中…");
    expect(wrapper.find(".grid-stub").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("没有匹配");
    wrapper.unmount();
  });

  it("offers retry on failure and distinguishes it from a successful empty result", async () => {
    const wrapper = mountTable({ entries: [entry], count: 1, searched: true, error: "unreachable" });
    expect(wrapper.find(".grid-stub").exists()).toBe(false);
    await wrapper.find("[role='alert'] button").trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
    await wrapper.setProps({ error: "", entries: [], count: 0 });
    expect(wrapper.find("[role='status']").text()).toBe("当前搜索没有匹配的条目");
    wrapper.unmount();
  });
  it("says 'run a search first' before any search has run", () => {
    const wrapper = mountTable({ entries: [], count: 0 });
    expect(wrapper.find(".empty").text()).toBe("暂无结果，请先执行搜索");
  });

  it("says 'no matches' after a search returned zero entries", () => {
    const wrapper = mountTable({ entries: [], count: 0, searched: true });
    expect(wrapper.find(".empty").text()).toBe("当前搜索没有匹配的条目");
  });

  it("keeps the no-match copy after a later empty search (state is sticky until next run)", () => {
    const wrapper = mountTable({ entries: [entry], count: 1, searched: true });
    expect(wrapper.find(".empty").exists()).toBe(false);
    expect(wrapper.findAll(".grid-stub-row")).toHaveLength(1);
  });

  it("shows an 'at limit' badge when count equals sizeLimit without a backend truncation flag (P2-15)", () => {
    const wrapper = mountTable({ entries: [entry], count: 500, atLimit: true, sizeLimit: 500 });
    const badge = wrapper.find(".truncated-badge");
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe("已到上限");
    expect(badge.attributes("title")).toContain("500");
  });

  it("does not show the at-limit badge when results are below the limit", () => {
    const wrapper = mountTable({ entries: [entry], count: 12 });
    expect(wrapper.find(".truncated-badge").exists()).toBe(false);
  });
});

describe("ResultTable grid wiring (AG Grid)", () => {
  it("feeds the grid dn + attribute-union columns and one row per entry", () => {
    const wrapper = mountTable({
      entries: [
        entry,
        { dn: "cn=bob,dc=demo,dc=dbx", attributes: { cn: ["bob"], mail: ["b@x"] } },
      ],
      count: 2,
    });
    const grid = wrapper.find(".grid-stub");
    expect(grid.exists()).toBe(true);
    // dn + cn/mail 并集
    expect(grid.attributes("data-column-count")).toBe("3");
    expect(wrapper.findAll(".grid-stub-row").map((row) => row.text())).toEqual([entry.dn, "cn=bob,dc=demo,dc=dbx"]);
    wrapper.unmount();
  });

  it("opens the entry when a row is activated (double click / Enter path)", async () => {
    const wrapper = mountTable({ entries: [entry], count: 1 });
    await wrapper.find(".grid-stub-row").trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
    expect(wrapper.emitted("open")![0][0]).toBe("cn=alice,dc=demo,dc=dbx");
    wrapper.unmount();
  });

  it("surfaces the keyboard hint on the grid container", () => {
    const wrapper = mountTable({ entries: [entry], count: 1 });
    expect(wrapper.find(".result-table").attributes("title")).toContain("Enter");
    wrapper.unmount();
  });

  it("keeps the export buttons wired and honors the disabled flag", async () => {
    const wrapper = mountTable({ entries: [entry], count: 1 });
    const exports = wrapper.findAll(".pager button");
    expect(exports).toHaveLength(3);
    await exports[0].trigger("click");
    await exports[1].trigger("click");
    await exports[2].trigger("click");
    expect(wrapper.emitted("export")).toEqual([["ldif"], ["csv"], ["json"]]);
    wrapper.unmount();

    const disabledWrapper = mountTable({ entries: [entry], count: 1, disabled: true });
    for (const button of disabledWrapper.findAll(".pager button")) expect(button.attributes("disabled")).toBeDefined();
    disabledWrapper.unmount();
  });
});
