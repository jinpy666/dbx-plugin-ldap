<script setup lang="ts">
// ag-grid-community 封装（对标 dbx-plugin-kafka 同名组件）：vanilla `createGrid`
// + 定向 API 更新，避免再引 ag-grid-vue3 依赖。DBX 视觉经 style.css 的
// `.dbx-grid` 用 --ag-* CSS 变量对齐主题令牌（light/dark 随宿主 data-theme 切换）。
// 内建：排序/列内文本筛选/分页 + 页大小 localStorage 持久化（ldapGrid 存取）、
// 多行复选框选择（表头全选，批量操作用）、行双击 / 单元格 Enter 激活、
// 列宽列序持久化（columnStateKey）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  AllCommunityModule,
  ModuleRegistry,
  createGrid,
  type ColDef,
  type ColumnState,
  type CellContextMenuEvent,
  type GridApi,
  type GridOptions,
  type RowSelectionOptions,
} from "ag-grid-community";
import { writeClipboardText } from "../lib/clipboard";
import { copyRowText } from "../lib/ldapGrid";
import { t } from "../lib/i18n";
import {
  PAGE_SIZE_OPTIONS,
  agGridLocaleText,
  loadColumnState,
  loadPreferredPageSize,
  saveColumnState,
  savePreferredPageSize,
} from "../lib/ldapGrid";

ModuleRegistry.registerModules([AllCommunityModule]);

const props = withDefaults(
  defineProps<{
    rowData: unknown[];
    columnDefs: ColDef[];
    /** localStorage 持久化键（每表唯一）。 */
    tableKey: string;
    /** 多行复选框选择（含表头全选）；false 关闭选择。 */
    rowSelection?: "multi" | false;
    /** 列宽/列序持久化键（columnState）；缺省不持久化。 */
    columnStateKey?: string;
    /** false 时数据只是服务器搜索会话的前缀，不能声称本地操作覆盖全部结果。 */
    clientSideComplete?: boolean;
  }>(),
  { rowSelection: "multi", columnStateKey: undefined, clientSideComplete: true },
);

const emit = defineEmits<{
  (e: "rowActivate", data: unknown): void;
  (e: "selectionChanged", rows: unknown[]): void;
  (e: "pageSizeChanged", size: number): void;
  /** User navigated to the last locally loaded page of an incomplete cursor. */
  (e: "pageNearEnd"): void;
  (e: "notify", message: string): void;
}>();

const host = ref<HTMLElement>();
const pageSize = ref(loadPreferredPageSize(props.tableKey));
let gridApi: GridApi | null = null;
const contextMenuEl = ref<HTMLElement>();
const contextMenu = ref<{ x: number; y: number; value: string; row: unknown; fields: string[] }>();
const effectiveColumnDefs = computed(() =>
  props.clientSideComplete
    ? props.columnDefs
    : props.columnDefs.map((definition) => ({ ...definition, sortable: false, filter: false })),
);

// 行 id：行 VM 带 id 字段直接用（ResultRow.id = DN）；兜底按对象身份分配稳定自增
// id（重复空串 id 会让 ag-grid 行覆盖合并——kafka 侧走查发现的同类 bug）。
const autoRowIds = new WeakMap<object, number>();
let autoRowIdSeq = 0;

function resolveRowId(data: unknown): string {
  if (data && typeof data === "object") {
    const explicit = (data as { id?: unknown }).id;
    if (typeof explicit === "string" && explicit) return explicit;
    let id = autoRowIds.get(data);
    if (id === undefined) {
      id = autoRowIdSeq;
      autoRowIdSeq += 1;
      autoRowIds.set(data, id);
    }
    return `auto-${id}`;
  }
  return "row";
}

function fieldValue(row: unknown, field: string): string {
  if (!row || typeof row !== "object") return "";
  const value = (row as Record<string, unknown>)[field];
  return value == null ? "" : String(value);
}

function closeContextMenu() {
  contextMenu.value = undefined;
}

function onCellContextMenu(event: CellContextMenuEvent) {
  const pointer = event.event;
  // AG Grid's callback can arrive after the native event has already bubbled
  // through the grid. Cancel it before validating the cell payload so a
  // browser/webview context menu can never win the race with our menu.
  if (pointer instanceof MouseEvent) pointer.preventDefault();
  if (!(pointer instanceof MouseEvent) || !event.data || !event.column) return;
  const field = event.column.getColDef().field;
  if (typeof field !== "string" || !field) return;
  const fields = event.api
    .getAllDisplayedColumns()
    .map((column) => column.getColDef().field)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const menuWidth = 166;
  const menuHeight = 72;
  contextMenu.value = {
    x: Math.min(pointer.clientX, Math.max(8, window.innerWidth - menuWidth - 8)),
    y: Math.min(pointer.clientY, Math.max(8, window.innerHeight - menuHeight - 8)),
    value: fieldValue(event.data, field) || (event.value == null ? "" : String(event.value)),
    row: event.data,
    fields,
  };
}

async function copyContext(kind: "value" | "row") {
  const menu = contextMenu.value;
  if (!menu) return;
  closeContextMenu();
  const text = kind === "value" ? menu.value : copyRowText(menu.row, menu.fields);
  emit("notify", (await writeClipboardText(text)) ? t("copied") : t("copyFailed"));
}

function onDocumentClick(event: MouseEvent) {
  if (contextMenu.value && !contextMenuEl.value?.contains(event.target as Node)) closeContextMenu();
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") closeContextMenu();
}

function buildOptions(): GridOptions {
  return {
    columnDefs: effectiveColumnDefs.value,
    rowData: props.rowData,
    defaultColDef: {
      sortable: props.clientSideComplete,
      resizable: true,
      filter: props.clientSideComplete ? "agTextColumnFilter" : false,
      minWidth: 64,
      suppressHeaderMenuButton: false,
    },
    pagination: true,
    paginationPageSize: pageSize.value,
    paginationPageSizeSelector: PAGE_SIZE_OPTIONS,
    alwaysShowVerticalScroll: true,
    alwaysShowHorizontalScroll: true,
    scrollbarWidth: 12,
    suppressContextMenu: true,
    rowHeight: 26,
    headerHeight: 26,
    animateRows: false,
    suppressDragLeaveHidesColumns: true,
    rowSelection: (props.rowSelection && props.clientSideComplete
      ? { mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false }
      : undefined) as RowSelectionOptions | undefined,
    getRowId: (params) => resolveRowId(params.data),
    localeText: agGridLocaleText() as GridOptions["localeText"],
    onRowDoubleClicked: (event) => {
      if (event.data) emit("rowActivate", event.data);
    },
    onCellKeyDown: (event) => {
      const keyboard = event.event;
      if (keyboard instanceof KeyboardEvent && keyboard.key === "Enter" && event.data) {
        keyboard.preventDefault();
        emit("rowActivate", event.data);
      }
    },
    onCellContextMenu,
    onSelectionChanged: (event) => {
      emit("selectionChanged", event.api.getSelectedRows());
    },
    onPaginationChanged: (event) => {
      const size = event.api.paginationGetPageSize();
      if (Number.isFinite(size) && size > 0 && size !== pageSize.value) {
        pageSize.value = size;
        savePreferredPageSize(props.tableKey, size);
        emit("pageSizeChanged", size);
      }
      // AG Grid also raises this event while it initializes or receives rows.
      // `newPage` confines continuation to an explicit user page navigation.
      if (event.newPage && event.api.paginationGetCurrentPage() >= event.api.paginationGetTotalPages() - 1) emit("pageNearEnd");
    },
    onColumnResized: (event) => {
      if (event.finished) persistColumnState();
    },
    onColumnMoved: (event) => {
      if (event.finished) persistColumnState();
    },
  };
}

// 列布局持久化：宽度/顺序/隐藏态整份 columnState 存取（resize/move 完成时落盘）。
function persistColumnState() {
  if (!props.columnStateKey || !gridApi) return;
  saveColumnState(props.columnStateKey, gridApi.getColumnState() as ColumnState[]);
}

onMounted(() => {
  if (!host.value) return;
  gridApi = createGrid(host.value, buildOptions());
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);
  const state = props.columnStateKey ? loadColumnState(props.columnStateKey) : null;
  if (state) gridApi.applyColumnState({ state, applyOrder: true });
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onDocumentKeydown);
  closeContextMenu();
  gridApi?.destroy();
  gridApi = null;
});

watch(
  () => props.rowData,
  (rows) => gridApi?.setGridOption("rowData", rows),
);
watch(
  effectiveColumnDefs,
  (defs) => gridApi?.setGridOption("columnDefs", defs),
);
watch(
  () => props.tableKey,
  () => {
    pageSize.value = loadPreferredPageSize(props.tableKey);
    gridApi?.setGridOption("paginationPageSize", pageSize.value);
  },
);

/** 清空多选（对外契约：结果集整体变化时批量选择随之失效）。 */
function deselectAll() {
  gridApi?.deselectAll();
}
defineExpose({ deselectAll });
</script>

<template>
  <div ref="host" class="dbx-grid ag-theme-quartz" @contextmenu.prevent />
  <div v-if="contextMenu" ref="contextMenuEl" class="context-menu grid-context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @click.stop>
    <button type="button" @click="copyContext('value')">{{ t("result.copyValue") }}</button>
    <button type="button" @click="copyContext('row')">{{ t("result.copyRow") }}</button>
  </div>
</template>

<style scoped>
/* 键盘导航可见焦点（ag-grid 默认 outline: none，Tab 进入网格后无法定位）。
   颜色走 --primary/--border 令牌，dark/light 两套随宿主主题成立；仅键盘聚焦
   （.ag-cell-focus）时描边，不干扰鼠标点选高亮。:deep 穿透 ag-grid 内部 DOM。 */
.dbx-grid :deep(.ag-cell.ag-cell-focus),
.dbx-grid :deep(.ag-cell:focus) {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
.dbx-grid :deep(.ag-row.ag-row-focus) {
  outline: 1px solid color-mix(in srgb, var(--primary) 55%, var(--border));
  outline-offset: -1px;
}
.grid-context-menu {
  width: 166px;
}
</style>
