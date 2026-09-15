<script setup lang="ts">
// ImportEntryDialog（阶段4）：条目导入——粘贴文本（自动识别 LDIF /
// PowerShell Format-List）或选择 .ldif 文件 → 解析预览（DN/属性数/告警）→
// DN 策略（保持原 DN / 挂到指定父 DN）→ 逐条 ldap/entry/add → 成败汇总。
// canWrite=false 时提交按钮禁用（与编辑器同门禁语义）；解析是纯前端
// entryFormats.ts，写路径复用既有 entryAdd 通道（审计/policy 原样生效）。
import { computed, ref, watch } from "vue";
import { FileUp, ListTree, X } from "@lucide/vue";
import { ldapApi } from "../lib/api";
import { parseEntriesFromText, type ParsedEntryDraft } from "../lib/entryFormats";
import { splitFirstDnRdn, joinRdnAndParent, isLikelyDn } from "../lib/dn";
import { useModalA11y } from "../lib/modal";
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
  resultSummary.value = null;
  if (needsParentStrategy.value) strategy.value = "under";
}

function onTextChange() {
  // 输入防抖交由按钮触发（大文本实时解析会卡输入）；清空文本即清预览
  if (text.value.trim() === "") {
    parseFormat.value = "unknown";
    parseNotes.value = [];
    entries.value = [];
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
}

const previewRows = computed<ImportRow[]>(() =>
  entries.value.map((entry) => ({
    dn: finalDn(entry),
    attributeCount: Object.keys(entry.attributes).length,
    warnings: entry.warnings,
  })),
);

function finalDn(entry: ParsedEntryDraft): string {
  if (effectiveStrategy.value === "under" && parentDnDraft.value) {
    const { rdn } = splitFirstDnRdn(entry.dn);
    return joinRdnAndParent(rdn, parentDnDraft.value);
  }
  return entry.dn;
}

async function doImport() {
  if (!canImport.value) return;
  importing.value = true;
  let ok = 0;
  let failed = 0;
  const firstError = "";
  try {
    for (const entry of entries.value) {
      const dn = finalDn(entry);
      if (!dn) {
        failed++;
        continue;
      }
      try {
        await ldapApi.entryAdd(dn, entry.attributes);
        ok++;
      } catch {
        failed++;
      }
    }
    resultSummary.value = { ok, failed };
    emit("imported", ok, failed);
  } finally {
    importing.value = false;
    void firstError;
  }
}

function reset() {
  text.value = "";
  fileName.value = "";
  parseFormat.value = "unknown";
  parseNotes.value = [];
  entries.value = [];
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

useModalA11y(
  () => props.open,
  { close: () => emit("close") },
);
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
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
</style>
