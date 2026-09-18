<script setup lang="ts">
// Compare 弹窗（F3，RFC 4511 Compare 操作）：断言条目在某属性上持有指定值。
// 自执行式——entryCompare 请求由本组件直发（区别于 BatchModifyDialog 的
// 控制方执行循环），结果内联展示；异常走行内红字 + notify 通知条。
// 关闭重开重置表单与结果；submitting 防重入；骨架/a11y 与 BatchModifyDialog 同款。
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { ldapApi } from "../lib/api";
import { friendlyLdapError } from "../lib/ldapErrors";
import { decideBackdropClose, useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";

const props = defineProps<{
  open: boolean;
  dn: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "notify", message: string): void;
}>();

// 比较结果三态：match（成功色调）/ noMatch（警示色调）/ failed（行内红字）。
type CompareOutcome = { kind: "match" | "noMatch" | "failed"; message: string } | null;

const attributeDraft = ref("");
const valueDraft = ref("");
const outcome = ref<CompareOutcome>(null);
const submitting = ref(false);
// 校验展示门（视觉审计 UX-V8）：打开瞬间空字段不渲染行内红字；错误等
// 「字段被编辑过（touched）」或「提交尝试过（submitted）」后才显示。
const touched = ref({ attribute: false, value: false });
const submitted = ref(false);

// 每次打开重置：上一次的断言与结果不该悄悄带到新条目（同 BatchModifyDialog）。
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    attributeDraft.value = "";
    valueDraft.value = "";
    outcome.value = null;
    touched.value = { attribute: false, value: false };
    submitted.value = false;
  },
  { immediate: true },
);

// 行内校验：属性名/值必填。invalid 始终参与禁用/拦截逻辑（不发无效请求）；
// 错误文案与 aria-invalid 的展示则经 touched/submitted 门控（UX-V8）。
const attributeInvalid = computed(() => attributeDraft.value.trim() === "");
const valueInvalid = computed(() => valueDraft.value.trim() === "");
const showAttributeError = computed(() => attributeInvalid.value && (touched.value.attribute || submitted.value));
const showValueError = computed(() => valueInvalid.value && (touched.value.value || submitted.value));
const canRun = computed(() => !submitting.value && !attributeInvalid.value && !valueInvalid.value);

// 字段被编辑：标记 touched；已有断言结果时一并清除——旧 match/noMatch 对
// 新输入不再成立，不能继续挂着误导用户。
function markTouched(field: "attribute" | "value") {
  touched.value[field] = true;
  if (outcome.value) outcome.value = null;
}

// 结果的 kind/message 拆成独立计算属性，模板 narrowing 与测试断言都更直接。
const outcomeKind = computed(() => outcome.value?.kind ?? "");
const outcomeMessage = computed(() => outcome.value?.message ?? "");

async function run() {
  // 提交尝试即激活校验展示：空字段按 Enter/强点禁用按钮后错误立即可见。
  submitted.value = true;
  if (submitting.value || attributeInvalid.value || valueInvalid.value) return;
  submitting.value = true;
  try {
    // 值按原文发送（LDAP Compare 是精确断言，前后空白可能有语义）；属性名 trim。
    const { match } = await ldapApi.entryCompare(props.dn, attributeDraft.value.trim(), valueDraft.value);
    outcome.value = { kind: match ? "match" : "noMatch", message: t(match ? "compare.match" : "compare.noMatch") };
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    const message = t("compare.failed", { error: friendlyLdapError(raw) });
    outcome.value = { kind: "failed", message };
    emit("notify", message);
  } finally {
    submitting.value = false;
  }
}

// Esc 关闭 + Tab 焦点陷阱；比较在途时否决 Esc（防结果不明，家族约定），
// 显式关闭通道（✕ / 取消）仍可用。初始聚焦属性名输入框。
useModalA11y(
  () => props.open,
  { close: () => emit("close"), allowClose: () => !submitting.value, initialFocus: ".compare-attribute-input" },
);

function onBackdropClick() {
  if (decideBackdropClose(!submitting.value).kind !== "close") return;
  emit("close");
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="onBackdropClick">
    <div class="modal small-modal compare-modal" role="dialog" aria-modal="true" :aria-label="t('compare.title')">
      <header>
        <h2>{{ t("compare.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <!-- DN 预填只读展示：来源为树/结果区选中条目，弹窗内不可改。 -->
      <label class="settings-field">
        <span>{{ t("compare.dn") }}</span>
        <input :value="dn" type="text" class="mono compare-dn" readonly spellcheck="false" :aria-label="t('compare.dn')" />
      </label>
      <label class="settings-field">
        <span>{{ t("compare.attribute") }}</span>
        <input
          v-model="attributeDraft"
          type="text"
          class="mono compare-attribute-input"
          spellcheck="false"
          :aria-invalid="showAttributeError"
          :aria-label="t('compare.attribute')"
          @input="markTouched('attribute')"
          @keydown.enter.prevent="run"
        />
      </label>
      <p v-if="showAttributeError" class="form-error">{{ t("compare.needAttribute") }}</p>
      <label class="settings-field">
        <span>{{ t("compare.value") }}</span>
        <input
          v-model="valueDraft"
          type="text"
          class="mono compare-value-input"
          spellcheck="false"
          :aria-invalid="showValueError"
          :aria-label="t('compare.value')"
          @input="markTouched('value')"
          @keydown.enter.prevent="run"
        />
      </label>
      <p v-if="showValueError" class="form-error">{{ t("compare.needValue") }}</p>
      <p v-if="outcomeKind === 'match'" class="compare-result compare-result-match" role="status">{{ outcomeMessage }}</p>
      <p v-else-if="outcomeKind === 'noMatch'" class="compare-result compare-result-nomatch" role="status">{{ outcomeMessage }}</p>
      <p v-else-if="outcomeKind === 'failed'" class="form-error" role="alert">{{ outcomeMessage }}</p>
      <footer>
        <button type="button" @click="emit('close')">{{ t("cancel") }}</button>
        <button type="button" class="primary-button" :disabled="!canRun" @click="run">
          {{ submitting ? "…" : t("compare.run") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 比较结果内联展示：match 用成功色调、noMatch 用警示色调（failed 复用 form-error）。 */
.compare-result {
  margin: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.compare-result-match { color: var(--success); }
.compare-result-nomatch { color: var(--destructive); }
</style>
