<script setup lang="ts">
// Compare 弹窗（条目对比）：当前 DN 与目标 DN 的整条目属性对比。弹窗内自
// 执行——两次 entryGet 拉取两侧条目（读白名单/屏蔽属性由 sidecar 把守），
// lib/entryDiff 纯函数算差异，差异表内联展示；异常走行内红字 + notify 通知
// 条。目标 DN 支持手输或 DnPickerDialog 层级选择。关闭重开重置表单与结果；
// submitting 防重入；骨架/a11y 与家族弹窗同款。
import { computed, ref, watch } from "vue";
import { ListTree, X } from "@lucide/vue";
import DnPickerDialog from "./DnPickerDialog.vue";
import { ldapApi, type LdapEntry } from "../lib/api";
import { friendlyLdapError } from "../lib/ldapErrors";
import { splitFirstDnRdn } from "../lib/dn";
import { decideBackdropClose, useModalA11y } from "../lib/modal";
import { countEntryDiff, diffLdapEntries, type EntryDiffRow, type EntryDiffStatus } from "../lib/entryDiff";
import { t } from "../lib/i18n";

const props = defineProps<{
  open: boolean;
  dn: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "notify", message: string): void;
}>();

// 对比结果三态：diff（差异表）/ identical（成功色调）/ failed（行内红字）。
type DiffOutcome =
  | { kind: "diff"; rows: EntryDiffRow[] }
  | { kind: "identical"; total: number }
  | { kind: "failed"; message: string }
  | null;

const targetDraft = ref("");
const outcome = ref<DiffOutcome>(null);
const submitting = ref(false);
const pickerOpen = ref(false);
// 校验展示门（视觉审计 UX-V8）：目标 DN 错误等「编辑过或提交过」后才显示。
const touched = ref(false);
const submitted = ref(false);

// 每次打开重置：上一次的目标 DN 与结果不该悄悄带到新条目（同 BatchModifyDialog）。
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    targetDraft.value = "";
    outcome.value = null;
    touched.value = false;
    submitted.value = false;
  },
  { immediate: true },
);

const targetInvalid = computed(() => targetDraft.value.trim() === "");
const showTargetError = computed(() => targetInvalid.value && (touched.value || submitted.value));
// 同 DN 对比无意义（大小写不敏感粗判，足够拦手误）。
const sameDn = computed(() => targetDraft.value.trim().toLowerCase() === props.dn.trim().toLowerCase());
const showSameDnError = computed(() => sameDn.value && (touched.value || submitted.value));
const canRun = computed(() => !submitting.value && !targetInvalid.value && !sameDn.value);

// 选择器浏览根：当前条目的父 DN（顶层条目退化为自身）。
const pickerBaseDn = computed(() => splitFirstDnRdn(props.dn).parentDn || props.dn);

function onPickTarget(dn: string) {
  pickerOpen.value = false;
  targetDraft.value = dn;
  markTouched();
}

// 目标被编辑：标记 touched；已有对比结果时一并清除——旧结果对新输入不再
// 成立，不能继续挂着误导用户。
function markTouched() {
  touched.value = true;
  if (outcome.value) outcome.value = null;
}

const outcomeKind = computed(() => outcome.value?.kind ?? "");
// 差异表只列存在差异的属性；一致的属性由汇总行计数交代。
const diffRows = computed(() =>
  outcome.value?.kind === "diff" ? outcome.value.rows.filter((row) => row.status !== "equal") : [],
);
const diffCounts = computed(() => (outcome.value?.kind === "diff" ? countEntryDiff(outcome.value.rows) : { total: 0, differences: 0 }));
const identicalTotal = computed(() => (outcome.value?.kind === "identical" ? outcome.value.total : 0));
const failedMessage = computed(() => (outcome.value?.kind === "failed" ? outcome.value.message : ""));

// computed（而非 setup 期常量）：t() 结果随语言切换保持响应。
const statusLabels = computed<Record<EntryDiffStatus, string>>(() => ({
  equal: t("compare.equal"),
  different: t("compare.different"),
  onlyLeft: t("compare.onlyLeft"),
  onlyRight: t("compare.onlyRight"),
}));

async function run() {
  // 提交尝试即激活校验展示：空/同 DN 目标按 Enter/强点禁用按钮后错误立即可见。
  submitted.value = true;
  if (submitting.value || targetInvalid.value || sameDn.value) return;
  submitting.value = true;
  try {
    // 两次 base 读取；任一侧失败即整单失败（Promise.all 短路）。
    const target = targetDraft.value.trim();
    const [left, right] = await Promise.all([ldapApi.entryGet(props.dn), ldapApi.entryGet(target)]);
    const rows = diffLdapEntries(left.entry, right.entry);
    outcome.value = rows.some((row) => row.status !== "equal")
      ? { kind: "diff", rows }
      : { kind: "identical", total: rows.length };
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    const message = t("compare.failed", { error: friendlyLdapError(raw) });
    outcome.value = { kind: "failed", message };
    emit("notify", message);
  } finally {
    submitting.value = false;
  }
}

// Esc 关闭 + Tab 焦点陷阱；对比在途时否决 Esc（防结果不明，家族约定），
// 显式关闭通道（✕ / 取消）仍可用。初始聚焦目标 DN 输入框。
useModalA11y(
  () => props.open,
  { close: () => emit("close"), allowClose: () => !submitting.value, initialFocus: ".compare-target-input" },
);

function onBackdropClick() {
  if (decideBackdropClose(!submitting.value).kind !== "close") return;
  emit("close");
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="onBackdropClick">
    <div class="modal compare-modal" role="dialog" aria-modal="true" :aria-label="t('compare.title')">
      <header>
        <h2>{{ t("compare.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <!-- 当前 DN 预填只读展示：来源为树/结果区选中条目，弹窗内不可改。 -->
      <label class="settings-field">
        <span>{{ t("compare.dn") }}</span>
        <input :value="dn" type="text" class="mono compare-dn" readonly spellcheck="false" :aria-label="t('compare.dn')" />
      </label>
      <div class="settings-field">
        <span>{{ t("compare.targetDn") }}</span>
        <div class="compare-target-row">
          <input
            v-model="targetDraft"
            type="text"
            class="mono compare-target-input"
            spellcheck="false"
            placeholder="cn=user,ou=people,dc=example,dc=com"
            :aria-invalid="showTargetError || showSameDnError"
            :aria-label="t('compare.targetDn')"
            @input="markTouched"
            @keydown.enter.prevent="run"
          />
          <button type="button" class="toolbar-button" :disabled="!pickerBaseDn" @click="pickerOpen = true">
            <ListTree aria-hidden="true" /><span>{{ t("compare.pickDn") }}</span>
          </button>
        </div>
        <p v-if="showTargetError" class="form-error">{{ t("compare.needTarget") }}</p>
        <p v-else-if="showSameDnError" class="form-error">{{ t("compare.sameDn") }}</p>
      </div>
      <p v-if="outcomeKind === 'identical'" class="compare-result compare-result-match" role="status">
        {{ t("compare.identical", { count: identicalTotal }) }}
      </p>
      <template v-else-if="outcomeKind === 'diff'">
        <p class="compare-result compare-result-nomatch" role="status">
          {{ t("compare.diffSummary", { count: diffCounts.differences, total: diffCounts.total }) }}
        </p>
        <!-- 差异表只列存在差异的属性；一致的属性由汇总行计数交代。 -->
        <div v-if="diffRows.length" class="compare-diff-table" role="table">
          <div class="compare-diff-head" role="row">
            <span role="columnheader">{{ t("compare.attribute") }}</span>
            <span role="columnheader">{{ t("compare.currentEntry") }}</span>
            <span role="columnheader">{{ t("compare.targetEntry") }}</span>
          </div>
          <div v-for="row of diffRows" :key="row.name" class="compare-diff-row" role="row">
            <span class="compare-diff-name" role="cell">
              <span class="mono">{{ row.name }}</span>
              <span class="badge compare-diff-badge">{{ statusLabels[row.status] }}</span>
            </span>
            <span class="mono compare-diff-values" role="cell">
              <div v-for="(value, index) of row.leftValues" :key="`l${index}`">{{ value }}</div>
              <div v-if="row.leftValues.length === 0" class="compare-diff-empty">—</div>
            </span>
            <span class="mono compare-diff-values" role="cell">
              <div v-for="(value, index) of row.rightValues" :key="`r${index}`">{{ value }}</div>
              <div v-if="row.rightValues.length === 0" class="compare-diff-empty">—</div>
            </span>
          </div>
        </div>
      </template>
      <p v-else-if="outcomeKind === 'failed'" class="form-error" role="alert">{{ failedMessage }}</p>
      <footer>
        <button type="button" @click="emit('close')">{{ t("cancel") }}</button>
        <button type="button" class="primary-button" :disabled="!canRun" @click="run">
          {{ submitting ? "…" : t("compare.run") }}
        </button>
      </footer>
    </div>
    <DnPickerDialog :open="pickerOpen" :base-dn="pickerBaseDn" @close="pickerOpen = false" @select="onPickTarget" />
  </div>
</template>

<style scoped>
.compare-target-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.compare-target-row input {
  flex: 1;
  min-width: 0;
}
/* 弹窗内的选择按钮不做顶栏那套 ≤900px 收成纯图标的响应式（全局规则
   font-size:0 会吞掉标签）；保持自然宽度，窄视口换行到输入框下方。 */
.compare-target-row .toolbar-button {
  flex: none;
  width: auto;
  padding: 0 6px;
  font-size: inherit;
}
/* 对比结果内联展示：identical 用成功色调、diff 汇总用警示色调（failed 复用 form-error）。 */
.compare-result {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.compare-result-match { color: var(--success); }
.compare-result-nomatch { color: var(--destructive); }
.compare-diff-table {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 6px;
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
}
.compare-diff-head,
.compare-diff-row {
  display: grid;
  grid-template-columns: minmax(110px, 0.8fr) minmax(0, 1.1fr) minmax(0, 1.1fr);
  gap: 8px;
  padding: 6px 8px;
  align-items: start;
}
.compare-diff-head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--popover);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}
.compare-diff-row {
  border-bottom: 1px solid var(--border);
}
.compare-diff-row:last-child {
  border-bottom: none;
}
.compare-diff-name {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.compare-diff-badge {
  max-width: none;
}
.compare-diff-values {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.compare-diff-empty {
  color: var(--muted-foreground);
}
</style>
