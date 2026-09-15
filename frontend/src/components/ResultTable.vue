<script setup lang="ts">
// 结果表：列 = attributes 并集（dn 首列）；排序/分页在前端完成。
// 替代 tiny-rdm 的 AgGrid（无新依赖的轻量表格）。交互：
// - 列头点击排序（dn 列默认升序）
// - 列头右缘拖拽调宽，持久化 localStorage（按列名记录）
// - 行双击 / Enter 打开条目编辑器（ldap/entry/get），↑/↓ 键盘导航
// - 行首复选框多选 + 批量删除入口（对标 Apache Directory Studio 的 Batch Operations）
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, FileDown, FileJson, FileSpreadsheet } from "@lucide/vue";
import type { LdapEntry } from "../lib/api";
import { extractEntryAttributeNames } from "../lib/ldapExporter";
import { t } from "../lib/i18n";

const props = defineProps<{
  entries: LdapEntry[];
  count: number;
  truncated: boolean;
  /** count 恰好等于 sizeLimit 的"可能截断"信号（UI 扫描 P2-15）。 */
  atLimit?: boolean;
  /** 最近一次搜索的 sizeLimit（提示文案展示上限值）。 */
  sizeLimit?: number;
  /** 已执行过至少一次搜索：0 条时区分"无匹配"与"未搜索"（UI 扫描 P2-3）。 */
  searched?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  errorDetail?: string;
}>();

const emit = defineEmits<{
  (e: "open", dn: string): void;
  (e: "export", format: "ldif" | "csv" | "json"): void;
  (e: "retry"): void;
  (e: "batchDelete", dns: string[]): void;
  (e: "batchMove", dns: string[]): void;
}>();

const PAGE_SIZE = 50;
const COLUMN_WIDTHS_KEY = "ldap.result.columnWidths.v1";
const MIN_COLUMN_WIDTH = 60;
const DEFAULT_DN_WIDTH = "minmax(200px, 2fr)";
const DEFAULT_COLUMN_WIDTH = "minmax(90px, 1fr)";
// 行首复选框固定列宽（不参与列宽拖拽持久化）。
const BATCH_CHECK_WIDTH = "26px";

const sortColumn = ref<string>("dn");
const sortDirection = ref<"asc" | "desc">("asc");
const page = ref(0);
const selectedDn = ref("");

const columns = computed(() => extractEntryAttributeNames(props.entries).slice(0, 12));

// -- column widths（拖拽 + localStorage 持久化） -------------------------------

const columnWidths = ref<Record<string, number>>({});

function loadColumnWidths() {
  try {
    const raw = window.localStorage.getItem(COLUMN_WIDTHS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const widths: Record<string, number> = {};
      for (const [name, width] of Object.entries(parsed as Record<string, unknown>)) {
        const numeric = Number(width);
        if (Number.isFinite(numeric) && numeric >= MIN_COLUMN_WIDTH) widths[name] = numeric;
      }
      columnWidths.value = widths;
    }
  } catch {
    columnWidths.value = {};
  }
}

function persistColumnWidths() {
  try {
    window.localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(columnWidths.value));
  } catch {
    // storage may be unavailable (private mode); drag still works for the session
  }
}

function startColumnResize(event: PointerEvent, column: string) {
  event.preventDefault();
  event.stopPropagation();
  const headerButton = (event.currentTarget as HTMLElement).parentElement;
  const startX = event.clientX;
  const startWidth = headerButton?.getBoundingClientRect().width ?? 120;
  const onMove = (move: PointerEvent) => {
    const width = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + move.clientX - startX));
    columnWidths.value = { ...columnWidths.value, [column]: width };
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    persistColumnWidths();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

onMounted(loadColumnWidths);

const gridStyle = computed(() => ({
  gridTemplateColumns: [
    BATCH_CHECK_WIDTH,
    columnWidths.value.dn ? `${columnWidths.value.dn}px` : DEFAULT_DN_WIDTH,
    ...columns.value.map((column) => (columnWidths.value[column] ? `${columnWidths.value[column]}px` : DEFAULT_COLUMN_WIDTH)),
  ].join(" "),
}));

const sortedEntries = computed(() => {
  const direction = sortDirection.value === "asc" ? 1 : -1;
  return [...props.entries].sort((left, right) => {
    const leftValue = sortColumn.value === "dn" ? left.dn : (left.attributes[sortColumn.value]?.[0] ?? "");
    const rightValue = sortColumn.value === "dn" ? right.dn : (right.attributes[sortColumn.value]?.[0] ?? "");
    return leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" }) * direction;
  });
});

const pageCount = computed(() => Math.max(1, Math.ceil(sortedEntries.value.length / PAGE_SIZE)));
const pageEntries = computed(() => sortedEntries.value.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE));

function toggleSort(column: string) {
  if (sortColumn.value === column) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
  } else {
    sortColumn.value = column;
    sortDirection.value = "asc";
  }
}

// 表头 aria-sort（UI 扫描 P2-18）：排序列映射 ascending/descending，其余 none。
function ariaSortFor(column: string): "ascending" | "descending" | "none" {
  if (sortColumn.value !== column) return "none";
  return sortDirection.value === "asc" ? "ascending" : "descending";
}

function cellText(entry: LdapEntry, column: string): string {
  const values = entry.attributes[column];
  if (!Array.isArray(values) || values.length === 0) return "";
  const text = values.join(" | ");
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

// 单元格完整值 tooltip（原生 title，与行级 DN title 同机制）：cellText 的
// 120 字符截断让大值（base64 图片等）无法在行内读全。title 预算截到 2000
// 字符——原生 tooltip 超长会被浏览器截断且拖慢悬浮渲染，截断尾巴以 … 标记。
const CELL_TITLE_LIMIT = 2000;

function cellTitle(entry: LdapEntry, column: string): string | undefined {
  const values = entry.attributes[column];
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const text = values.join(" | ");
  return text.length > CELL_TITLE_LIMIT ? `${text.slice(0, CELL_TITLE_LIMIT)}…` : text;
}

function rowClick(entry: LdapEntry) {
  selectedDn.value = entry.dn;
}

function rowActivate(entry: LdapEntry) {
  selectedDn.value = entry.dn;
  emit("open", entry.dn);
}

// -- keyboard navigation（↑/↓ 移动、Enter 打开；跨页自动翻页） ----------------

function showSelected(entry: LdapEntry) {
  const index = sortedEntries.value.indexOf(entry);
  if (index >= 0 && (index < page.value * PAGE_SIZE || index >= (page.value + 1) * PAGE_SIZE)) {
    page.value = Math.floor(index / PAGE_SIZE);
  }
  void nextTick(() => {
    document.querySelector(".result-row.selected")?.scrollIntoView({ block: "nearest" });
  });
}

function moveSelection(delta: number) {
  if (sortedEntries.value.length === 0) return;
  const currentIndex = sortedEntries.value.findIndex((entry) => entry.dn === selectedDn.value);
  const nextIndex = currentIndex < 0 ? 0 : Math.min(Math.max(currentIndex + delta, 0), sortedEntries.value.length - 1);
  const entry = sortedEntries.value[nextIndex];
  selectedDn.value = entry.dn;
  showSelected(entry);
}

function onRowsKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === "Enter") {
    const entry = sortedEntries.value.find((candidate) => candidate.dn === selectedDn.value);
    if (entry) {
      event.preventDefault();
      rowActivate(entry);
    }
  }
}

// -- batch selection（行首复选框多选 + 批量删除入口） -------------------------
// 键统一用小写 DN（LDAP DN 大小写不敏感），原始 DN 存 Map 以便事件 payload
// 按原样取回。选择状态独立于行选中（selectedDn）与排序/键盘导航。

const selectedDns = ref<Set<string>>(new Set());
const originalDns = ref<Map<string, string>>(new Map());

const selectedCount = computed(() => selectedDns.value.size);

const allSelected = computed(
  () => props.entries.length > 0 && props.entries.every((entry) => selectedDns.value.has(entry.dn.toLowerCase())),
);

// 行复选框选中态：小写 DN 键命中即可（与存储键同规则）。
function isRowChecked(entry: LdapEntry): boolean {
  return selectedDns.value.has(entry.dn.toLowerCase());
}

function toggleRowSelection(entry: LdapEntry) {
  const key = entry.dn.toLowerCase();
  const next = new Set(selectedDns.value);
  const nextOriginals = new Map(originalDns.value);
  if (next.has(key)) {
    next.delete(key);
    nextOriginals.delete(key);
  } else {
    next.add(key);
    nextOriginals.set(key, entry.dn);
  }
  selectedDns.value = next;
  originalDns.value = nextOriginals;
}

function clearSelection() {
  selectedDns.value = new Set();
  originalDns.value = new Map();
}

function toggleAllSelection() {
  if (allSelected.value) {
    clearSelection();
    return;
  }
  const next = new Set<string>();
  const nextOriginals = new Map<string, string>();
  for (const entry of props.entries) {
    const key = entry.dn.toLowerCase();
    next.add(key);
    nextOriginals.set(key, entry.dn);
  }
  selectedDns.value = next;
  originalDns.value = nextOriginals;
}

// 收集所选 DN：按当前条目顺序输出原始大小写 DN（batchDelete/batchMove 共用，
// 保证两个事件的 payload 同序同大小写）。
function collectSelectedDns(): string[] {
  const dns: string[] = [];
  for (const entry of props.entries) {
    const key = entry.dn.toLowerCase();
    if (selectedDns.value.has(key)) dns.push(originalDns.value.get(key) ?? entry.dn);
  }
  return dns;
}

// 确认删除：原生 confirm（与 SearchForm.removePreset 同机制）；确认后清空选择。
function confirmBatchDelete() {
  const count = selectedDns.value.size;
  if (count === 0) return;
  if (!window.confirm(t("result.batchConfirm", { count }))) return;
  emit("batchDelete", collectSelectedDns());
  clearSelection();
}

// 批量移动：目标父 DN 的选择与确认在 App 侧对话框完成，这里直接 emit，
// payload 与 batchDelete 同序同大小写；随后与 batchDelete 一致地清空选择。
function batchMoveSelection() {
  if (selectedDns.value.size === 0) return;
  emit("batchMove", collectSelectedDns());
  clearSelection();
}

watch(
  () => props.entries,
  (next) => {
    page.value = 0;
    selectedDn.value = "";
    clearSelection();
    // round-4：新结果不含旧排序列时排序已失去意义（该列所有行取值都是空、
    // 等价于不排序），残留的列头排序指示会误导"正按某列排序"；此时重置回
    // dn 升序。列集 = 全部条目属性并集（与渲染列同源）。
    if (sortColumn.value !== "dn" && !extractEntryAttributeNames(next).includes(sortColumn.value)) {
      sortColumn.value = "dn";
      sortDirection.value = "asc";
    }
  },
);

const hasEntries = computed(() => props.entries.length > 0);
</script>

<template>
  <section class="result-pane" :aria-busy="loading || undefined">
    <div v-if="!loading && !error" class="result-meta">
      <span>{{ t("result.count", { count }) }}<span v-if="truncated" class="truncated-badge" style="margin-left: 8px">{{ t("result.truncated") }}</span><span v-else-if="atLimit" class="truncated-badge" style="margin-left: 8px" :title="t('result.atLimit', { limit: sizeLimit ?? 0 })">{{ t("result.atLimitBadge") }}</span></span>
      <span class="pager">
        <button v-if="hasEntries" :disabled="disabled || page <= 0" :title="t('result.prevPage')" :aria-label="t('result.prevPage')" @click="page -= 1">
          <ChevronLeft aria-hidden="true" />
        </button>
        <span v-if="hasEntries" class="muted">{{ t("result.page", { page: page + 1, pages: pageCount }) }}</span>
        <button v-if="hasEntries" :disabled="disabled || page >= pageCount - 1" :title="t('result.nextPage')" :aria-label="t('result.nextPage')" @click="page += 1">
          <ChevronRight aria-hidden="true" />
        </button>
        <button v-if="hasEntries" :disabled="disabled" :title="t('result.exportLdif')" @click="emit('export', 'ldif')"><FileDown aria-hidden="true" /></button>
        <button v-if="hasEntries" :disabled="disabled" :title="t('result.exportCsv')" @click="emit('export', 'csv')"><FileSpreadsheet aria-hidden="true" /></button>
        <button v-if="hasEntries" :disabled="disabled" :title="t('result.exportJson')" @click="emit('export', 'json')"><FileJson aria-hidden="true" /></button>
      </span>
    </div>
    <div v-if="loading" class="empty" role="status">{{ t("search.running") }}</div>
    <div v-else-if="error" class="empty request-error" role="alert">
      <p :title="errorDetail || error">{{ error }}</p>
      <button type="button" :disabled="disabled" @click="emit('retry')">{{ t("retry") }}</button>
    </div>
    <div v-else-if="!hasEntries" class="empty" role="status">{{ props.searched ? t("result.emptyNoMatch") : t("result.empty") }}</div>
    <div
      v-else
      class="result-table"
      tabindex="0"
      :title="t('result.keyboardHint')"
      @keydown="onRowsKeydown"
    >
      <!-- 批量操作条：选中数 > 0 时出现在表头之上 -->
      <div v-if="selectedCount > 0" class="batch-bar">
        <span class="batch-count">{{ t("result.batchSelected", { count: selectedCount }) }}</span>
        <button type="button" class="toolbar-button batch-delete" :disabled="disabled" @click="confirmBatchDelete">{{ t("result.batchDelete") }}</button>
        <!-- 移动所选：不弹确认，目标父 DN 由 App 侧对话框选择 -->
        <button type="button" class="toolbar-button batch-move" :disabled="disabled" @click="batchMoveSelection">{{ t("result.batchMove") }}</button>
        <button type="button" class="toolbar-button batch-clear" @click="clearSelection">{{ t("result.batchClear") }}</button>
      </div>
      <div class="result-header" :style="gridStyle">
        <span class="col-check">
          <input
            type="checkbox"
            :checked="allSelected"
            :indeterminate="selectedCount > 0 && !allSelected"
            :disabled="disabled"
            @click="toggleAllSelection"
          />
        </span>
        <button type="button" :aria-sort="ariaSortFor('dn')" @click="toggleSort('dn')">
          dn<span v-if="sortColumn === 'dn'"> {{ sortDirection === "asc" ? "▲" : "▼" }}</span>
          <span class="col-resize" @pointerdown="startColumnResize($event, 'dn')" />
        </button>
        <button v-for="column in columns" :key="column" type="button" :title="column" :aria-sort="ariaSortFor(column)" @click="toggleSort(column)">
          {{ column }}<span v-if="sortColumn === column"> {{ sortDirection === "asc" ? "▲" : "▼" }}</span>
          <span class="col-resize" @pointerdown="startColumnResize($event, column)" />
        </button>
      </div>
      <div class="result-rows">
        <button
          v-for="entry in pageEntries"
          :key="entry.dn"
          class="result-row"
          :class="{ selected: selectedDn === entry.dn }"
          :style="gridStyle"
          :title="entry.dn"
          @click="rowClick(entry)"
          @dblclick="rowActivate(entry)"
        >
          <!-- @click.stop：复选框点击绝不触发行点击（选中/打开条目） -->
          <span class="cell-check">
            <input
              type="checkbox"
              :checked="isRowChecked(entry)"
              :disabled="disabled"
              :aria-label="entry.dn"
              :title="entry.dn"
              @click.stop="toggleRowSelection(entry)"
              @dblclick.stop
            />
          </span>
          <span class="cell-dn">{{ entry.dn }}</span>
          <span v-for="column in columns" :key="column" class="cell-value" :title="cellTitle(entry, column)">{{ cellText(entry, column) }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 批量操作条：位于表头之上，仅在有选中项时渲染 */
.batch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent) 45%, transparent);
  font-size: 11px;
  color: var(--muted-foreground);
}
.batch-count {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.batch-bar .batch-delete {
  color: var(--destructive);
  border-color: color-mix(in srgb, var(--destructive) 45%, transparent);
}
.batch-bar .batch-delete:hover:not(:disabled) {
  background: color-mix(in srgb, var(--destructive) 12%, transparent);
}
/* 复选框固定列（表头全选 + 行首多选），居中于 BATCH_CHECK_WIDTH 列内 */
.col-check,
.cell-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
