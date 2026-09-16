<script setup lang="ts">
// 结果表：AG Grid 版（对标 dbx-plugin-kafka 的 DbxAgGrid）。列 = dn 首列 +
// attributes 并集；排序/列内文本筛选/列宽拖拽/分页/键盘导航全部由 ag-grid 内建，
// 交互保留旧行为：
// - 行双击 / Enter 打开条目编辑器（ldap/entry/get）
// - 行首复选框多选 + 表头全选 + 批量删除/批量移动入口（选择键 = 小写 DN，
//   payload 按条目顺序取回原始大小写）
// - 结果集变化时清空批量选择
import { computed, ref, watch } from "vue";
import { FileDown, FileJson, FileSpreadsheet } from "@lucide/vue";
import DbxAgGrid from "./DbxAgGrid.vue";
import type { LdapEntry } from "../lib/api";
import { extractEntryAttributeNames } from "../lib/ldapExporter";
import { resultColumns, toResultRows } from "../lib/ldapGrid";
import { t } from "../lib/i18n";

const props = withDefaults(defineProps<{
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
  /** Results are complete only after the server-side search cursor is exhausted. */
  complete?: boolean;
  loadingMore?: boolean;
  loadMoreError?: string;
  loadMoreErrorDetail?: string;
}>(), {
  complete: true,
});

const emit = defineEmits<{
  (e: "open", dn: string): void;
  (e: "export", format: "ldif" | "csv" | "json"): void;
  (e: "notify", message: string): void;
  (e: "retry"): void;
  (e: "batchDelete", dns: string[]): void;
  (e: "batchMove", dns: string[]): void;
  (e: "loadMore"): void;
  (e: "retryMore"): void;
}>();

const grid = ref<InstanceType<typeof DbxAgGrid> | null>(null);

const rows = computed(() => toResultRows(props.entries));
const columnDefs = computed(() => resultColumns(extractEntryAttributeNames(props.entries)));

function activateRow(data: unknown) {
  const dn = (data as { dn?: unknown }).dn;
  if (typeof dn === "string" && dn) emit("open", dn);
}

// -- batch selection（复选框多选 + 批量删除/移动入口） ---------------------------
// 键统一用小写 DN（LDAP DN 大小写不敏感），原始 DN 存 Map 以便事件 payload
// 按原样取回。选择状态来自 DbxAgGrid 的 selectionChanged（复选框/表头全选）。

const selectedDns = ref<Set<string>>(new Set());
const originalDns = ref<Map<string, string>>(new Map());

const selectedCount = computed(() => selectedDns.value.size);

function onSelectionChanged(rows: unknown[]) {
  const keys = new Set<string>();
  const originals = new Map<string, string>();
  for (const row of rows) {
    const dn = (row as { dn?: unknown }).dn;
    if (typeof dn !== "string" || !dn) continue;
    const key = dn.toLowerCase();
    keys.add(key);
    originals.set(key, dn);
  }
  selectedDns.value = keys;
  originalDns.value = originals;
}

// 清空选择：先清本地态，再同步网格（deselectAll 会触发 selectionChanged([])，
// 与本地清空幂等；网格未挂载时本地清空兜底）。
function clearSelection() {
  selectedDns.value = new Set();
  originalDns.value = new Map();
  grid.value?.deselectAll();
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
  () => clearSelection(),
);

const hasEntries = computed(() => props.entries.length > 0);
const complete = computed(() => props.complete);
</script>

<template>
  <section class="result-pane" :aria-busy="loading || undefined">
    <div v-if="!loading && !error" class="result-meta">
      <span>
        <template v-if="complete">{{ t("result.count", { count }) }}</template>
        <template v-else>{{ t("result.loaded", { count: entries.length }) }}</template>
        <span v-if="truncated" class="truncated-badge" style="margin-left: 8px">{{ t("result.truncated") }}</span>
        <span v-else-if="atLimit" class="truncated-badge" style="margin-left: 8px" :title="t('result.atLimit', { limit: sizeLimit ?? 0 })">{{ t("result.atLimitBadge") }}</span>
        <span v-if="!complete" class="progress-badge" style="margin-left: 8px">{{ loadingMore ? t("search.running") : t("result.loadingMore") }}</span>
      </span>
      <span class="pager">
        <button v-if="hasEntries" :disabled="disabled || !complete" :title="complete ? t('result.exportLdif') : t('result.exportIncomplete')" @click="emit('export', 'ldif')"><FileDown aria-hidden="true" /></button>
        <button v-if="hasEntries" :disabled="disabled || !complete" :title="complete ? t('result.exportCsv') : t('result.exportIncomplete')" @click="emit('export', 'csv')"><FileSpreadsheet aria-hidden="true" /></button>
        <button v-if="hasEntries" :disabled="disabled || !complete" :title="complete ? t('result.exportJson') : t('result.exportIncomplete')" @click="emit('export', 'json')"><FileJson aria-hidden="true" /></button>
      </span>
    </div>
    <div v-if="loading" class="empty" role="status">{{ t("search.running") }}</div>
    <div v-else-if="error" class="empty request-error" role="alert">
      <p :title="errorDetail || error">{{ error }}</p>
      <button type="button" :disabled="disabled" @click="emit('retry')">{{ t("retry") }}</button>
    </div>
    <div v-else-if="!hasEntries" class="empty" role="status">{{ props.searched ? t("result.emptyNoMatch") : t("result.empty") }}</div>
    <div v-else class="result-table" :title="complete ? t('result.keyboardHint') : t('result.partialHint')">
      <div v-if="!complete" class="partial-results" role="status">
        <span>{{ t("result.partialHint") }}</span>
        <button v-if="loadMoreError" type="button" class="toolbar-button" :title="loadMoreErrorDetail || loadMoreError" :disabled="loadingMore || disabled" @click="emit('retryMore')">{{ t("retry") }}</button>
        <button v-else type="button" class="toolbar-button load-more" :disabled="loadingMore || disabled" @click="emit('loadMore')">{{ loadingMore ? t("search.running") : t("result.loadMore") }}</button>
      </div>
      <!-- 批量操作条：选中数 > 0 时出现在表格之上 -->
      <div v-if="selectedCount > 0" class="batch-bar">
        <span class="batch-count">{{ t("result.batchSelected", { count: selectedCount }) }}</span>
        <button type="button" class="toolbar-button batch-delete" :disabled="disabled" @click="confirmBatchDelete">{{ t("result.batchDelete") }}</button>
        <!-- 移动所选：不弹确认，目标父 DN 由 App 侧对话框选择 -->
        <button type="button" class="toolbar-button batch-move" :disabled="disabled" @click="batchMoveSelection">{{ t("result.batchMove") }}</button>
        <button type="button" class="toolbar-button batch-clear" @click="clearSelection">{{ t("result.batchClear") }}</button>
      </div>
      <DbxAgGrid
        ref="grid"
        class="result-grid"
        :row-data="rows"
        :column-defs="columnDefs"
        table-key="result"
        column-state-key="result"
        :row-selection="complete ? 'multi' : false"
        :client-side-complete="complete"
        @row-activate="activateRow"
        @selection-changed="onSelectionChanged"
        @page-near-end="emit('loadMore')"
        @notify="emit('notify', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
/* 批量操作条：位于表格之上，仅在有选中项时渲染 */
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
.partial-results {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: 11px;
}
.progress-badge {
  color: var(--muted-foreground);
}
.batch-bar .batch-delete {
  color: var(--destructive);
  border-color: color-mix(in srgb, var(--destructive) 45%, transparent);
}
.batch-bar .batch-delete:hover:not(:disabled) {
  background: color-mix(in srgb, var(--destructive) 12%, transparent);
}
</style>
