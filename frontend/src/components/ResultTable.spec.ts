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
    clientSideComplete: { type: Boolean, default: true },
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

function mountTable(props: { entries: LdapEntry[]; count: number; truncated?: boolean; searched?: boolean; atLimit?: boolean; sizeLimit?: number; loading?: boolean; error?: string; disabled?: boolean; complete?: boolean; loadingMore?: boolean; loadMoreError?: string; loadMoreErrorDetail?: string; referrals?: string[] }) {
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
    expect(wrapper.find(".empty-title").text()).toBe("当前搜索没有匹配的条目");
    wrapper.unmount();
  });
  it("says 'run a search first' before any search has run", () => {
    const wrapper = mountTable({ entries: [], count: 0 });
    expect(wrapper.find(".empty-title").text()).toBe("暂无结果，请先执行搜索");
    expect(wrapper.find(".empty-hint").text()).toBe("在上方设置 Base DN 与过滤器，点击「搜索」即可浏览目录内容。");
    expect(wrapper.find(".empty-icon svg").exists()).toBe(true);
  });

  it("says 'no matches' after a search returned zero entries", () => {
    const wrapper = mountTable({ entries: [], count: 0, searched: true });
    expect(wrapper.find(".empty-title").text()).toBe("当前搜索没有匹配的条目");
    expect(wrapper.find(".empty-hint").text()).toBe("尝试放宽过滤器、扩大 Base DN 范围或提高数量上限。");
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

describe("ResultTable referral hint (referral report, ADS manage)", () => {
  it("shows a hint bar with the referral count and URI tooltip when referrals are returned", () => {
    const wrapper = mountTable({
      entries: [entry],
      count: 1,
      referrals: ["ldap://a.example/dc=demo,dc=dbx", "ldap://b.example/dc=demo,dc=dbx"],
    });
    const hint = wrapper.find('[data-qa="result-referrals"]');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain("2");
    expect(hint.attributes("title")).toContain("ldap://a.example/dc=demo,dc=dbx");
    expect(hint.attributes("title")).toContain("ldap://b.example/dc=demo,dc=dbx");
  });

  it("caps the tooltip list at five URIs (mirrors the backend error prefix cap)", () => {
    const uris = Array.from({ length: 7 }, (_, index) => `ldap://s${index}.example/dc=x`);
    const wrapper = mountTable({ entries: [entry], count: 1, referrals: uris });
    const hint = wrapper.find('[data-qa="result-referrals"]');
    expect(hint.text()).toContain("7");
    expect(hint.attributes("title")).toContain("ldap://s4.example/dc=x");
    expect(hint.attributes("title")).not.toContain("ldap://s5.example/dc=x");
  });

  it("hides the hint when no referrals are returned", () => {
    const wrapper = mountTable({ entries: [entry], count: 1 });
    expect(wrapper.find('[data-qa="result-referrals"]').exists()).toBe(false);
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

  it("labels a cursor prefix as loaded and blocks global operations until it completes", async () => {
    const wrapper = mountTable({ entries: [entry], count: 1, complete: false });
    expect(wrapper.find(".result-meta").text()).toContain("已加载 1 条");
    expect(wrapper.find(".partial-results").text()).toContain("当前仅显示已加载结果");
    const grid = wrapper.findComponent({ name: "DbxAgGridStub" });
    expect(grid.props("rowSelection")).toBe(false);
    expect(grid.props("clientSideComplete")).toBe(false);
    for (const button of wrapper.findAll(".pager button")) expect(button.attributes("disabled")).toBeDefined();
    expect(wrapper.find(".load-more").exists()).toBe(false);
    expect(wrapper.find(".auto-load-status").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows a retry instead of hiding already loaded results when a later page fails", async () => {
    const wrapper = mountTable({ entries: [entry], count: 1, complete: false, loadMoreError: "connection lost" });
    expect(wrapper.find(".grid-stub").exists()).toBe(true);
    await wrapper.find(".partial-results button").trigger("click");
    expect(wrapper.emitted("retryMore")).toHaveLength(1);
    wrapper.unmount();
  });
});
