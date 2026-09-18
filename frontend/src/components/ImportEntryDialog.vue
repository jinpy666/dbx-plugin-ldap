<script setup lang="ts">
// ImportEntryDialog（阶段4）：条目导入——粘贴文本（自动识别 LDIF /
// PowerShell Format-List）或选择 .ldif 文件 → 解析预览（DN/属性数/告警）→
// DN 策略（保持原 DN / 挂到指定父 DN）→ 逐条 ldap/entry/add → 成败汇总。
// canWrite=false 时提交按钮禁用（与编辑器同门禁语义）；解析是纯前端
// entryFormats.ts，写路径复用既有 entryAdd 通道（审计/policy 原样生效）。
// 逐条状态（待导入/已导入/失败）随预览行渲染；changetype 变更记录在发送前
// 拒绝（探测：lib/ldif.ts 的 LDIF 路径会丢弃变更记录并记 notes，但 PS
// Format-List 路径会把 changetype 保留为普通属性键，需在此兜底）；失败条目
// 汇总为失败清单，支持复制（DN\t错误）与只重跑失败项。
import { computed, ref, watch } from "vue";
import { FileUp, ListTree, X } from "@lucide/vue";
import { ldapApi } from "../lib/api";
import { parseEntriesFromText, type ParsedEntryDraft } from "../lib/entryFormats";
import { splitFirstDnRdn, joinRdnAndParent, isLikelyDn } from "../lib/dn";
import { friendlyLdapError } from "../lib/ldapErrors";
import { writeClipboardText } from "../lib/clipboard";
import { decideBackdropClose, useModalA11y } from "../lib/modal";
import DnPickerDialog from "./DnPickerDialog.vue";
import { t } from "../lib/i18n";

type DnStrategy = "keep" | "under";

const props = defineProps<{
  open: boolean;
  canWrite: boolean;
  /** 「挂到指定父 DN」的缺省父（连接 Base DN 或树上下文）。 */
  parentDn?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "imported", imported: number, failed: number): void;
  (e: "error", message: string): void;
  (e: "notify", message: string): void;
}>();

const text = ref("");
const fileName = ref("");
const parseNotes = ref<string[]>([]);
const parseFormat = ref<"ldif" | "ps-format-list" | "unknown">("unknown");
const entries = ref<ParsedEntryDraft[]>([]);
const strategy = ref<DnStrategy>("keep");
const parentDnDraft = ref("");
const pickerOpen = ref(false);
const importing = ref(false);
const resultSummary = ref<{ ok: number; failed: number } | null>(null);

// 逐条导入状态：与 entries 按下标对齐。error 存友好文案；targetDn 记录本次
// 运行实际发往服务器的 DN（策略输入后续可能被改动，失败清单以运行时为准）。
type ImportRowStatus = "pending" | "ok" | "failed";
interface ImportRowState {
  status: ImportRowStatus;
  error: string;
  targetDn: string;
}
const rowStates = ref<ImportRowState[]>([]);

/**
 * 探测：条目属性是否含 changetype 键（大小写不敏感）。
 * LDIF 变更记录（changetype: add/modify/delete/modrdn）不是本入口支持的
 * 写入形态——lib/ldif.ts 的 LDIF 路径会整体丢弃这类记录（记 notes），但
 * PowerShell Format-List 路径会把 changetype 保留为普通属性键；此处兜底，
 * 避免把变更记录当新增条目发出 ldap/entry/add。
 */
function isChangetypeEntry(attributes: Record<string, string[]>): boolean {
  return Object.keys(attributes).some((name) => name.toLowerCase() === "changetype");
}

function statusLabel(status: ImportRowStatus): string {
  if (status === "ok") return t("ldap.importEntry.statusOk");
  if (status === "failed") return t("ldap.importEntry.statusFailed");
  return t("ldap.importEntry.statusPending");
}

const parentInvalid = computed(() => parentDnDraft.value !== "" && !isLikelyDn(parentDnDraft.value));

// 缺 DN 的条目必须走「挂到父 DN」策略（keep 单选禁用）。
const needsParentStrategy = computed(() => entries.value.some((entry) => entry.dn === ""));
const effectiveStrategy = computed<DnStrategy>(() => (needsParentStrategy.value ? "under" : strategy.value));

const canImport = computed(
  () =>
    props.canWrite &&
    !importing.value &&
    entries.value.length > 0 &&
    resultSummary.value === null &&
    (!needsParentStrategy.value || (parentDnDraft.value !== "" && !parentInvalid.value)),
);

function runParse() {
  const result = parseEntriesFromText(text.value);
  parseFormat.value = result.format;
  parseNotes.value = result.notes;
  entries.value = result.entries;
  // 新一轮解析重置逐条状态：全部回到待导入。
  rowStates.value = entries.value.map(() => ({ status: "pending", error: "", targetDn: "" }));
  resultSummary.value = null;
  if (needsParentStrategy.value) strategy.value = "under";
}

function onTextChange() {
  // 输入防抖交由按钮触发（大文本实时解析会卡输入）；清空文本即清预览
  if (text.value.trim() === "") {
    parseFormat.value = "unknown";
    parseNotes.value = [];
    entries.value = [];
    rowStates.value = [];
    resultSummary.value = null;
  }
}

async function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    text.value = await file.text();
    fileName.value = file.name;
    runParse();
  } catch {
    emit("error", t("ldap.importEntry.readFailed", { name: file.name }));
  }
}

interface ImportRow {
  dn: string;
  attributeCount: number;
  warnings: string[];
  status: ImportRowStatus;
  error: string;
}

const previewRows = computed<ImportRow[]>(() =>
  entries.value.map((entry, index) => {
    const state = rowStates.value[index];
    return {
      dn: finalDn(entry),
      attributeCount: Object.keys(entry.attributes).length,
      warnings: entry.warnings,
      status: state?.status ?? "pending",
      error: state?.error ?? "",
    };
  }),
);

function finalDn(entry: ParsedEntryDraft): string {
  if (effectiveStrategy.value === "under" && parentDnDraft.value) {
    const { rdn } = splitFirstDnRdn(entry.dn);
    return joinRdnAndParent(rdn, parentDnDraft.value);
  }
  return entry.dn;
}

// 逐条执行导入（仅跑 indices 指定的行，全量与重试共用）：
// changetype 变更记录与缺 DN 在发送前标记失败，不发请求；ldap 错误经
// friendlyLdapError 转友好文案存入对应行。
async function runEntries(indices: number[]): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const index of indices) {
    const entry = entries.value[index];
    const state = rowStates.value[index];
    if (!entry || !state) continue;
    const dn = finalDn(entry);
    state.targetDn = dn;
    if (isChangetypeEntry(entry.attributes)) {
      state.status = "failed";
      state.error = t("ldap.importEntry.changetypeRejected");
      failed++;
      continue;
    }
    if (!dn) {
      state.status = "failed";
      state.error = t("ldap.importEntry.warningNoDn");
      failed++;
      continue;
    }
    try {
      await ldapApi.entryAdd(dn, entry.attributes);
      state.status = "ok";
      state.error = "";
      ok++;
    } catch (cause) {
      state.status = "failed";
      state.error = friendlyLdapError(cause instanceof Error ? cause.message : String(cause));
      failed++;
    }
  }
  return { ok, failed };
}

// 汇总取自逐条状态（而非单次运行计数）：重试后展示的是全部条目的最新成败。
function summarizeStates(): { ok: number; failed: number } {
  let ok = 0;
  let failed = 0;
  for (const state of rowStates.value) {
    if (state.status === "ok") ok++;
    else if (state.status === "failed") failed++;
  }
  return { ok, failed };
}

async function finishRun(indices: number[]) {
  importing.value = true;
  try {
    const run = await runEntries(indices);
    resultSummary.value = summarizeStates();
    // 复用 imported 事件：App 侧按需刷新树并反馈汇总（重试成功同样要刷新）。
    emit("imported", run.ok, run.failed);
  } finally {
    importing.value = false;
  }
}

async function doImport() {
  if (!canImport.value) return;
  await finishRun(entries.value.map((_, index) => index));
}

// 失败清单：DN 取运行时实际目标 DN，错误取友好文案。
const failedRows = computed(() =>
  rowStates.value
    .map((state, index) => ({ state, entry: entries.value[index] }))
    .filter(({ state }) => state.status === "failed")
    .map(({ state, entry }) => ({ dn: state.targetDn || finalDn(entry), error: state.error })),
);

const canRetry = computed(() => !importing.value && failedRows.value.length > 0);

async function retryFailed() {
  if (!canRetry.value) return;
  await finishRun(rowStates.value.map((state, index) => (state.status === "failed" ? index : -1)).filter((index) => index >= 0));
}

async function copyFailedList() {
  // 每行 `DN\t错误文案`，TSV 便于粘贴进表格/日志排查
  const payload = failedRows.value.map((row) => `${row.dn}\t${row.error}`).join("\n");
  const copiedOk = await writeClipboardText(payload);
  emit("notify", copiedOk ? t("copied") : t("copyFailed"));
}

function reset() {
  text.value = "";
  fileName.value = "";
  parseFormat.value = "unknown";
  parseNotes.value = [];
  entries.value = [];
  rowStates.value = [];
  strategy.value = "keep";
  parentDnDraft.value = props.parentDn || "";
  importing.value = false;
  resultSummary.value = null;
}

watch(
  () => [props.open, props.parentDn] as const,
  ([open]) => {
    if (!open) return;
    reset();
  },
  { immediate: true },
);

// Esc/遮罩关闭守卫（与 BatchModifyDialog 同家族语义）：逐条导入在途时否决，
// 防止上千条循环跑到一半弹窗消失的"视觉遗弃"；显式关闭通道（✕ / 取消）
// 不受守卫影响，用户仍可主动放弃。
useModalA11y(
  () => props.open,
  { close: () => emit("close"), allowClose: () => !importing.value },
);

// 遮罩点击与 Esc 走同一条 decideBackdropClose 守卫（J-4/L-3）：
// 此前 @click.self 直通 close，绕过了 allowClose。
function onBackdropClick() {
  if (decideBackdropClose(!importing.value).kind !== "close") return;
  emit("close");
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="onBackdropClick">
    <div class="modal editor-modal import-entry-modal" role="dialog" aria-modal="true" :aria-label="t('ldap.importEntry.title')">
      <header>
        <h2>{{ t("ldap.importEntry.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>

      <div class="import-source">
        <label class="field">
          <span class="muted">{{ t("ldap.importEntry.pasteLabel") }}</span>
          <textarea v-model="text" class="mono import-textarea" rows="6" spellcheck="false" :placeholder="'dn: cn=new,dc=example,dc=com\ncn: new\n…'" @input="onTextChange"></textarea>
        </label>
        <div class="import-source-actions">
          <label class="toolbar-button">
            <FileUp aria-hidden="true" /><span>{{ t("ldap.importEntry.fileButton") }}</span>
            <input type="file" accept=".ldif,.txt,text/plain" style="display: none" @change="onFileChosen" />
          </label>
          <button type="button" class="primary-button" :disabled="text.trim() === ''" @click="runParse">
            {{ t("ldap.importEntry.parseButton") }}
          </button>
          <span v-if="fileName" class="muted">{{ fileName }}</span>
          <span v-if="parseFormat !== 'unknown'" class="badge">{{ parseFormat }}</span>
        </div>
      </div>

      <p v-for="note in parseNotes" :key="note" class="hint">{{ note }}</p>

      <template v-if="entries.length > 0">
        <div class="import-dn-strategy">
          <label class="import-strategy-option">
            <input v-model="strategy" type="radio" value="keep" :disabled="needsParentStrategy" />
            <span>{{ t("ldap.importEntry.strategyKeep") }}</span>
          </label>
          <label class="import-strategy-option">
            <input v-model="strategy" type="radio" value="under" />
            <span>{{ t("ldap.importEntry.strategyUnder") }}</span>
          </label>
          <template v-if="effectiveStrategy === 'under'">
            <input v-model="parentDnDraft" type="text" class="mono import-parent-input" :placeholder="t('ldap.importEntry.parentDn')" :aria-invalid="parentInvalid" spellcheck="false" />
            <button type="button" class="toolbar-button" :title="t('ldap.valueEditors.pickFromTree')" @click="pickerOpen = true">
              <ListTree aria-hidden="true" />
            </button>
          </template>
        </div>
        <p v-if="parentInvalid" class="form-error">{{ t("editor.dnInvalid") }}</p>

        <div class="import-preview">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>DN</th>
                <th>{{ t("ldap.importEntry.attributesColumn") }}</th>
                <th>{{ t("ldap.importEntry.warningsColumn") }}</th>
                <!-- 状态列表头留空（徽标文本自释；与 "#" 同为非文案表头）。 -->
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in previewRows" :key="index">
                <td>{{ index + 1 }}</td>
                <td class="mono">{{ row.dn || "—" }}</td>
                <td>{{ row.attributeCount }}</td>
                <td>
                  <span v-if="row.warnings.includes('dn')" class="form-error">{{ t("ldap.importEntry.warningNoDn") }}</span>
                  <span v-for="warning in row.warnings.filter((item) => item !== 'dn')" :key="warning" class="muted">{{ warning }}</span>
                  <span v-if="row.status === 'failed' && row.error" class="form-error">{{ row.error }}</span>
                </td>
                <td>
                  <span class="badge" :class="`import-status--${row.status}`">{{ statusLabel(row.status) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else-if="text.trim() !== ''" class="hint">{{ t("ldap.importEntry.parsePrompt") }}</p>
      <p v-if="resultSummary" class="hint" role="status">
        {{ t("ldap.importEntry.summary", { ok: resultSummary.ok, failed: resultSummary.failed }) }}
      </p>

      <div v-if="failedRows.length > 0" class="import-failed">
        <p class="hint import-failed-title">{{ t("ldap.importEntry.failedTitle") }}</p>
        <ul class="import-failed-list">
          <li v-for="(row, index) in failedRows" :key="index">
            <span class="mono" :title="row.dn">{{ row.dn || "—" }}</span>
            <span class="form-error">{{ row.error }}</span>
          </li>
        </ul>
        <div class="import-failed-actions">
          <button type="button" :disabled="importing" @click="copyFailedList">{{ t("ldap.importEntry.copyFailedList") }}</button>
          <button type="button" :disabled="!canRetry" @click="retryFailed">{{ t("ldap.importEntry.retryFailed") }}</button>
        </div>
      </div>

      <footer>
        <span v-if="!canWrite" class="muted" style="margin-right: auto">{{ t("editor.readonlyHint") }}</span>
        <span v-else class="muted" style="margin-right: auto">{{ t("ldap.importEntry.entryCount", { count: entries.length }) }}</span>
        <button type="button" @click="emit('close')">{{ t("cancel") }}</button>
        <button type="button" class="primary-button" :disabled="!canImport" @click="doImport">
          {{ importing ? "…" : t("ldap.importEntry.importButton") }}
        </button>
      </footer>
    </div>
    <DnPickerDialog :open="pickerOpen" :base-dn="parentDn || parentDnDraft" @close="pickerOpen = false" @select="(dn) => { parentDnDraft = dn; pickerOpen = false; }" />
  </div>
</template>

<style scoped>
.import-entry-modal {
  gap: 10px;
}
.import-source {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.import-source-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.import-textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  background: var(--background);
  color: var(--foreground);
  font-size: 11px;
  resize: vertical;
}
.import-dn-strategy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.import-strategy-option {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}
.import-parent-input {
  flex: 1;
  min-width: 200px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 7px;
  background: var(--background);
  color: var(--foreground);
  font-size: 11px;
}
.import-preview {
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.import-preview table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.import-preview th,
.import-preview td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
  overflow-wrap: anywhere;
}
/* 状态徽标沿用全局 .badge 骨架，仅按结果补语义色（组件内 scoped，非全局 CSS）。 */
.import-status--ok {
  color: var(--success);
}
.import-status--failed {
  color: var(--destructive);
}
.import-failed {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.import-failed-title {
  margin: 0;
}
.import-failed-list {
  margin: 0;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--background);
  font-size: 11px;
  list-style: none;
}
.import-failed-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.import-failed-list li .mono {
  min-width: 0;
  overflow-wrap: anywhere;
}
.import-failed-actions {
  display: flex;
  gap: 8px;
}
</style>
