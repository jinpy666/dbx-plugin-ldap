// @vitest-environment happy-dom
// DbxAgGrid 组件测试（连线行为锁定）：真实 ag-grid 在 happy-dom 下无法可靠
// 布局，故 mock ag-grid-community 的 createGrid 捕获 GridOptions + 假 GridApi：
// - 初始 options：分页开启、默认页大小 50、多行复选框选择（enableClickSelection off）
// - 分页页大小变更按 tableKey 持久化 localStorage + emit pageSizeChanged；
//   未变化/非法值不写；tableKey 切换重载持久化页大小
// - 行激活：双击 / 单元格 Enter（preventDefault）→ rowActivate，其他按键不触发
// - selectionChanged 转发 api.getSelectedRows；deselectAll 透传
// - columnStateKey：挂载时回放持久化列布局；resize 完成才落盘
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import DbxAgGrid from "./DbxAgGrid.vue";
import type { ColDef, GridOptions, RowSelectionOptions } from "ag-grid-community";

// -- ag-grid-community mock（捕获 options 与假 GridApi） ------------------------------
const gridMock = vi.hoisted(() => ({
  created: [] as Array<{ el: unknown; options: GridOptions }>,
  apis: Array<Record<string, ReturnType<typeof vi.fn>>>(),
  pendingSize: 50,
  storedColumnState: [{ colId: "dn", width: 220, hide: false }] as unknown,
}));

vi.mock("ag-grid-community", () => ({
  AllCommunityModule: {},
  ModuleRegistry: { registerModules: vi.fn() },
  createGrid: vi.fn((el: unknown, options: GridOptions) => {
    const api = {
      setGridOption: vi.fn(),
      paginationGetPageSize: vi.fn(() => gridMock.pendingSize),
      paginationGetCurrentPage: vi.fn(() => 0),
      paginationGetTotalPages: vi.fn(() => 1),
      applyColumnState: vi.fn(),
      getColumnState: vi.fn(() => gridMock.storedColumnState),
      getAllDisplayedColumns: vi.fn(() => [
        { getColDef: () => ({ field: "dn" }) },
        { getColDef: () => ({ field: "cn" }) },
      ]),
      deselectAll: vi.fn(),
      destroy: vi.fn(),
    };
    gridMock.created.push({ el, options });
    gridMock.apis.push(api);
    return api;
  }),
}));

const columnDefs: ColDef[] = [
  { field: "dn", headerName: "dn" },
  { field: "cn", headerName: "cn" },
];

const row = { id: "cn=alice,dc=demo,dc=dbx", dn: "cn=alice,dc=demo,dc=dbx", cn: "alice" };

function mountGrid(props: Record<string, unknown> = {}) {
  return mount(DbxAgGrid, {
    props: { rowData: [row], columnDefs, tableKey: "spec-table", ...props },
  });
}

function lastApi(wrapper: VueWrapper<InstanceType<typeof DbxAgGrid>>) {
  void wrapper;
  return gridMock.apis[gridMock.apis.length - 1] as unknown as {
    setGridOption: ReturnType<typeof vi.fn>;
    applyColumnState: ReturnType<typeof vi.fn>;
    deselectAll: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  localStorage.clear();
  gridMock.created.length = 0;
  gridMock.apis.length = 0;
  gridMock.pendingSize = 50;
  gridMock.storedColumnState = [{ colId: "dn", width: 220, hide: false }];
});

describe("DbxAgGrid", () => {
  it("creates the grid with pagination, locale text and multi-row checkbox selection", () => {
    const wrapper = mountGrid();
    const options = gridMock.created[0].options;
    expect(options.pagination).toBe(true);
    expect(options.paginationPageSize).toBe(50);
    expect(options.paginationPageSizeSelector).toEqual([20, 50, 100, 200]);
    expect(options.alwaysShowVerticalScroll).toBe(true);
    expect(options.alwaysShowHorizontalScroll).toBe(true);
    expect(options.suppressContextMenu).toBe(true);
    expect(options.localeText).toHaveProperty("filterOoo");
    expect(options.rowSelection).toEqual({ mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false });
    // 默认列行为：可排序/可拖宽/表头文本筛选
    expect(options.defaultColDef?.filter).toBe("agTextColumnFilter");
    expect(options.defaultColDef?.sortable).toBe(true);
    wrapper.unmount();
  });

  it("drops row selection entirely when rowSelection is false", () => {
    const wrapper = mountGrid({ rowSelection: false });
    expect(gridMock.created[0].options.rowSelection).toBeUndefined();
    wrapper.unmount();
  });

  it("disables local sort, filters and checkbox selection while a server cursor is incomplete", () => {
    const wrapper = mountGrid({ clientSideComplete: false });
    const options = gridMock.created[0].options;
    expect(options.rowSelection).toBeUndefined();
    expect(options.defaultColDef?.sortable).toBe(false);
    expect(options.defaultColDef?.filter).toBe(false);
    expect(options.columnDefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "dn", sortable: false, filter: false }),
      expect.objectContaining({ field: "cn", sortable: false, filter: false }),
    ]));
    wrapper.unmount();
  });

  it("persists a pagination page size change per table key and emits it", () => {
    const wrapper = mountGrid();
    expect(gridMock.created[0].options.paginationPageSize).toBe(50);
    gridMock.pendingSize = 123;
    gridMock.created[0].options.onPaginationChanged?.({ api: lastApi(wrapper) } as never);
    expect(localStorage.getItem("dbx-ldap-grid-pagesize-spec-table")).toBe("123");
    expect(wrapper.emitted("pageSizeChanged")).toEqual([[123]]);
  });

  it("requests more only when the user reaches the final locally loaded page", () => {
    const wrapper = mountGrid();
    gridMock.created[0].options.onPaginationChanged?.({ api: lastApi(wrapper), newPage: false } as never);
    expect(wrapper.emitted("pageNearEnd")).toBeUndefined();
    gridMock.created[0].options.onPaginationChanged?.({ api: lastApi(wrapper), newPage: true } as never);
    expect(wrapper.emitted("pageNearEnd")).toHaveLength(1);
    wrapper.unmount();
  });

  it("skips persistence when the reported size is unchanged or invalid", () => {
    const wrapper = mountGrid();
    // 未变化（50 == 当前 pageSize）
    gridMock.created[0].options.onPaginationChanged?.({ api: lastApi(wrapper) } as never);
    // 非法值（NaN/0）
    gridMock.pendingSize = Number.NaN;
    gridMock.created[0].options.onPaginationChanged?.({ api: lastApi(wrapper) } as never);
    gridMock.pendingSize = 0;
    gridMock.created[0].options.onPaginationChanged?.({ api: lastApi(wrapper) } as never);
    expect(localStorage.getItem("dbx-ldap-grid-pagesize-spec-table")).toBeNull();
    expect(wrapper.emitted("pageSizeChanged")).toBeUndefined();
  });

  it("reloads the persisted page size when the table key changes", async () => {
    localStorage.setItem("dbx-ldap-grid-pagesize-other-table", "25");
    const wrapper = mountGrid();
    lastApi(wrapper).setGridOption.mockClear();
    await wrapper.setProps({ tableKey: "other-table" });
    expect(lastApi(wrapper).setGridOption).toHaveBeenCalledWith("paginationPageSize", 25);
  });

  it("activates rows on double click and on Enter keydown, not on other keys", () => {
    const wrapper = mountGrid();
    gridMock.created[0].options.onRowDoubleClicked?.({ data: row } as never);
    expect(wrapper.emitted("rowActivate")).toEqual([[row]]);

    gridMock.created[0].options.onCellKeyDown?.({ event: new KeyboardEvent("keydown", { key: "Enter" }), data: row } as never);
    expect(wrapper.emitted("rowActivate")).toHaveLength(2);

    gridMock.created[0].options.onCellKeyDown?.({ event: new KeyboardEvent("keydown", { key: "ArrowDown" }), data: row } as never);
    expect(wrapper.emitted("rowActivate")).toHaveLength(2);
    // 无行数据的按键（如表头）不触发
    gridMock.created[0].options.onCellKeyDown?.({ event: new KeyboardEvent("keydown", { key: "Enter" }), data: undefined } as never);
    expect(wrapper.emitted("rowActivate")).toHaveLength(2);
  });

  it("forwards selection changes and exposes deselectAll", () => {
    const wrapper = mountGrid();
    gridMock.created[0].options.onSelectionChanged?.({ api: { getSelectedRows: () => [row] } } as never);
    expect(wrapper.emitted("selectionChanged")).toEqual([[[row]]]);
    (wrapper.vm as unknown as { deselectAll: () => void }).deselectAll();
    expect(lastApi(wrapper).deselectAll).toHaveBeenCalledTimes(1);
  });

  it("opens a cell context menu with copy value and copy row actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { dbxPlugin?: unknown }).dbxPlugin = { clipboard: { writeText } };
    const wrapper = mountGrid();
    gridMock.created[0].options.onCellContextMenu?.({
      event: new MouseEvent("contextmenu", { clientX: 30, clientY: 40 }),
      data: row,
      value: row.cn,
      column: { getColDef: () => ({ field: "cn" }) },
      api: lastApi(wrapper),
    } as never);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll(".grid-context-menu button").map((button) => button.text())).toEqual(["复制值", "复制行"]);
    await wrapper.findAll(".grid-context-menu button")[0].trigger("click");
    expect(writeText).toHaveBeenCalledWith("alice");
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".grid-context-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  it("replays a persisted column layout on mount and saves it when a resize finishes", () => {
    localStorage.setItem("dbx-ldap-grid-colstate-result", JSON.stringify(gridMock.storedColumnState));
    const wrapper = mountGrid({ columnStateKey: "result" });
    expect(lastApi(wrapper).applyColumnState).toHaveBeenCalledWith({ state: gridMock.storedColumnState, applyOrder: true });
    // resize 完成 → columnState 落盘；未完成（拖拽进行中）不写
    gridMock.created[0].options.onColumnResized?.({ finished: true } as never);
    expect(JSON.parse(localStorage.getItem("dbx-ldap-grid-colstate-result") ?? "null")).toEqual(gridMock.storedColumnState);
    gridMock.storedColumnState = [{ colId: "cn", width: 90, hide: false }];
    gridMock.created[0].options.onColumnResized?.({ finished: false } as never);
    expect(JSON.parse(localStorage.getItem("dbx-ldap-grid-colstate-result") ?? "null")).toEqual([{ colId: "dn", width: 220, hide: false }]);
    wrapper.unmount();
  });

  it("ignores column state when no columnStateKey is configured", () => {
    const wrapper = mountGrid();
    expect(lastApi(wrapper).applyColumnState).not.toHaveBeenCalled();
    gridMock.created[0].options.onColumnResized?.({ finished: true } as never);
    expect(localStorage.getItem("dbx-ldap-grid-colstate-result")).toBeNull();
    wrapper.unmount();
  });
});
