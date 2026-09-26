<script setup lang="ts">
// 结果表：AG Grid 版（对标 dbx-plugin-kafka 的 DbxAgGrid）。列 = dn 首列 +
// attributes 并集；排序/列内文本筛选/列宽拖拽/分页/键盘导航全部由 ag-grid 内建，
// 交互保留旧行为：
// - 行双击 / Enter 打开条目编辑器（ldap/entry/get）
// - 行首复选框多选 + 表头全选 + 批量删除/批量移动/批量修改入口（选择键 = 小写 DN，
//   payload 按条目顺序取回原始大小写）
// - 结果集变化时清空批量选择
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { CircleAlert, FileDown, FileJson, FileSpreadsheet, FolderSearch, Loader2, SearchX } from "@lucide/vue";
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
  /** 连接可写门禁（表单 read_only ∥ 宿主 read_only）：false 时禁用批量
   * 删除/移动/修改三个写入口（App 侧守卫兜底，后端 policy 最终拒绝）。 */
  canWrite?: boolean;
  /** 延续引用 URI（referral report 语义，referral 不追随）：非空时结果表
   * 顶部提示条展示（ADS manage 行为的轻量对位）。 */
  referrals?: string[];
}>(), {
  complete: true,
  canWrite: true,
});

const emit = defineEmits<{
  (e: "open", dn: string): void;
  (e: "export", format: "ldif" | "csv" | "json"): void;
  (e: "notify", message: string): void;
  (e: "retry"): void;
  (e: "batchDelete", dns: string[]): void;
  (e: "batchMove", dns: string[]): void;
  (e: "batchModify", dns: string[]): void;
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
  // 任何选择变化都解除批量删除确认态（审计 J-5：确认与所选项必须同步）。
  disarmBatchDelete();
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
  disarmBatchDelete();
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

// 批量删除行内两步确认（审计 J-5）：宿主 webview 可能拦截 window.confirm
// 原生确认框导致按钮"静默无响应"（同 SearchForm.requestRemovePreset 模式）。
// 首次点击进入确认态（文案切到既有 t("confirm")，class 加 is-armed），3 秒
// 无操作自动回落；确认态再次点击才真正触发批量删除。选择变化即解除确认态。
const batchDeleteArmed = ref(false);
let batchDeleteArmTimer = 0;

function disarmBatchDelete() {
  window.clearTimeout(batchDeleteArmTimer);
  batchDeleteArmTimer = 0;
  batchDeleteArmed.value = false;
}

// 确认删除：行内两步确认；确认后清空选择。只读连接（canWrite=false）直接
// 拦截：按钮虽已禁用，键盘/自动化仍可能触达（与 App 侧守卫同语义）。
function confirmBatchDelete() {
  if (!props.canWrite) return;
  const count = selectedDns.value.size;
  if (count === 0) return;
  if (!batchDeleteArmed.value) {
    batchDeleteArmed.value = true;
    window.clearTimeout(batchDeleteArmTimer);
    batchDeleteArmTimer = window.setTimeout(disarmBatchDelete, 3000);
    return;
  }
  disarmBatchDelete();
  emit("batchDelete", collectSelectedDns());
  clearSelection();
}

// 批量移动：目标父 DN 的选择与确认在 App 侧对话框完成，这里直接 emit，
// payload 与 batchDelete 同序同大小写；随后与 batchDelete 一致地清空选择。
function batchMoveSelection() {
  if (!props.canWrite || selectedDns.value.size === 0) return;
  emit("batchMove", collectSelectedDns());
  clearSelection();
}

// 批量修改：操作类型/属性名/值的选择与确认在 App 侧 BatchModifyDialog 完成，
// 这里直接 emit，payload 与 batchDelete/batchMove 同序同大小写；随后同样清空选择。
function batchModifySelection() {
  if (!props.canWrite || selectedDns.value.size === 0) return;
  emit("batchModify", collectSelectedDns());
  clearSelection();
}

watch(
  () => props.entries,
  () => clearSelection(),
);

// 卸载时清确认态定时器：挂载同 tick 卸载时回调不会随定时器"复活"。
onBeforeUnmount(disarmBatchDelete);

const hasEntries = computed(() => props.entries.length > 0);
const complete = computed(() => props.complete);
/** referral 提示：标题列出前 5 条 URI（与后端错误前缀封顶一致），溢出省略。 */
const referralHint = computed(() => (props.referrals ?? []).slice(0, 5).join("\n"));
const referralCount = computed(() => props.referrals?.length ?? 0);
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
    <p v-if="!loading && !error && referralCount > 0" class="referral-hint" :title="referralHint" data-qa="result-referrals">
      {{ t("result.referrals", { count: referralCount }) }}
    </p>
    <div v-if="loading" class="empty" role="status">
      <Loader2 class="empty-spinner spinning" aria-hidden="true" />
      <span>{{ t("search.running") }}</span>
    </div>
    <div v-else-if="error" class="empty request-error" role="alert">
      <CircleAlert class="empty-error-icon" aria-hidden="true" />
      <p :title="errorDetail || error">{{ error }}</p>
      <button type="button" :disabled="disabled" @click="emit('retry')">{{ t("retry") }}</button>
    </div>
    <!-- 空态双形态（未搜索 vs 无匹配）升级为图标 + 主副文案的居中引导：
         主文案保持原 key 不变（走查 P2-3 的两态区分语义不动），副文案给出
         下一步动作建议，降低首次使用与空结果的困惑。 -->
    <div v-else-if="!hasEntries" class="empty empty--hero" role="status">
      <span class="empty-icon" aria-hidden="true">
        <SearchX v-if="searched" />
        <FolderSearch v-else />
      </span>
      <p class="empty-title">{{ props.searched ? t("result.emptyNoMatch") : t("result.empty") }}</p>
      <p class="empty-hint">{{ props.searched ? t("result.emptyNoMatchHint") : t("result.emptyHint") }}</p>
    </div>
    <div v-else class="result-table" :title="complete ? t('result.keyboardHint') : t('result.partialHint')">
      <div v-if="!complete" class="partial-results" role="status">
        <span>{{ t("result.partialHint") }}</span>
        <button v-if="loadMoreError" type="button" class="toolbar-button" :title="loadMoreErrorDetail || loadMoreError" :disabled="loadingMore || disabled" @click="emit('retryMore')">{{ t("retry") }}</button>
        <span v-else class="auto-load-status">{{ loadingMore ? t("search.running") : t("result.loadingMore") }}</span>
      </div>
      <!-- 批量操作条：选中数 > 0 时出现在表格之上 -->
      <div v-if="selectedCount > 0" class="batch-bar">
        <span class="batch-count">{{ t("result.batchSelected", { count: selectedCount }) }}</span>
        <!-- 删除走行内两步确认（宿主 webview 可能拦截原生 confirm）：确认态文案
             用既有 confirm 键，title 同步说明；再点一次才触发。 -->
        <!-- 只读连接（canWrite=false）：三个写入口全部禁用并提示（编辑器
             readonlyHint 同一文案）；清除选择不受影响。 -->
        <button
          type="button"
          class="toolbar-button batch-delete"
          :class="{ 'is-armed': batchDeleteArmed }"
          :disabled="disabled || !canWrite"
          :title="!canWrite ? t('editor.readonlyHint') : (batchDeleteArmed ? t('confirm') : t('result.batchDelete'))"
          @click="confirmBatchDelete"
        >{{ batchDeleteArmed ? t("confirm") : t("result.batchDelete") }}</button>
        <!-- 移动所选：不弹确认，目标父 DN 由 App 侧对话框选择 -->
        <button type="button" class="toolbar-button batch-move" :disabled="disabled || !canWrite" :title="!canWrite ? t('editor.readonlyHint') : t('result.batchMove')" @click="batchMoveSelection">{{ t("result.batchMove") }}</button>
        <!-- 修改所选：不弹确认，操作类型/属性名/值由 App 侧 BatchModifyDialog 选择 -->
        <button type="button" class="toolbar-button batch-modify" :disabled="disabled || !canWrite" :title="!canWrite ? t('editor.readonlyHint') : t('result.batchModify')" @click="batchModifySelection">{{ t("result.batchModify") }}</button>
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
/* 确认态（is-armed）：微弱底色提示"再点一次才执行"。 */
.batch-bar .batch-delete.is-armed {
  background: color-mix(in srgb, var(--destructive) 12%, transparent);
}
</style>
