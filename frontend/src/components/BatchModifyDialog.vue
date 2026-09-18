<script setup lang="ts">
// 批量修改属性弹窗：结果表多选后对所选条目统一 add/replace/delete 同一个属性
// （对标 ADS 批量操作）。逐条 ldapApi.entryModify 的执行循环在 App 侧（控制方），
// 本组件只负责操作类型/属性名/值的表单校验与确认/关闭交互（与 BatchMoveDialog
// 同款骨架）。delete 契约：删除整个属性固定传 values=[]（LdapModifyChange 语义），
// 不提供按值删除，故选 delete 时值输入不参与校验、hint 提示可留空。
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { decideBackdropClose, useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";

const props = defineProps<{
  open: boolean;
  dns: string[];
  submitting?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "confirm", payload: { operation: "add" | "replace" | "delete"; attribute: string; values: string[] }): void;
}>();

// 表单草稿：每次打开重置——上一次的操作/属性/值不该悄悄套用到新一批所选条目。
const operation = ref<"add" | "replace" | "delete">("add");
const attributeDraft = ref("");
const valuesDraft = ref("");
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    operation.value = "add";
    attributeDraft.value = "";
    valuesDraft.value = "";
  },
  { immediate: true },
);

// 值解析：多行文本每行一个值，逐行 trim 后剔除空行（含纯空白行）。
const parsedValues = computed(() =>
  valuesDraft.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
);

// 行内校验：属性名必填；add/replace 至少一个值（delete 忽略值，允许留空）。
// 错误随输入即时反映（aria-invalid + 行内红字 + 禁用确认），不发无效 confirm。
const attributeInvalid = computed(() => attributeDraft.value.trim() === "");
const valuesInvalid = computed(() => operation.value !== "delete" && parsedValues.value.length === 0);
const canConfirm = computed(() => !props.submitting && !attributeInvalid.value && !valuesInvalid.value);

// 确认文案：显示受影响条目数（与 BatchMoveDialog 的 confirm-copy 同位）。
const confirmCopy = computed(() => t("batchModify.affected", { count: props.dns.length }));

function confirm() {
  if (props.submitting || attributeInvalid.value || valuesInvalid.value) return;
  emit("confirm", {
    operation: operation.value,
    attribute: attributeDraft.value.trim(),
    // delete 固定传空数组 = 删除整个属性（控制方据此构造 LdapModifyChange）。
    values: operation.value === "delete" ? [] : [...parsedValues.value],
  });
}

// Esc 关闭 + Tab 焦点陷阱；修改请求在途时否决关闭（防结果不明，同 BatchMoveDialog）。
// 初始聚焦属性名输入框：这是打开后第一个需要填写的字段。
useModalA11y(
  () => props.open,
  { close: () => emit("close"), allowClose: () => !props.submitting, initialFocus: ".attribute-input" },
);

function onBackdropClick() {
  if (decideBackdropClose(!props.submitting).kind !== "close") return;
  emit("close");
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="onBackdropClick">
    <div class="modal small-modal batch-modify-modal" role="dialog" aria-modal="true" :aria-label="t('batchModify.title')">
      <header>
        <h2>{{ t("batchModify.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <p class="confirm-copy">{{ confirmCopy }}</p>
      <label class="settings-field">
        <span>{{ t("batchModify.operation") }}</span>
        <select v-model="operation" class="operation-select" :aria-label="t('batchModify.operation')">
          <option value="add">{{ t("batchModify.addValues") }}</option>
          <option value="replace">{{ t("batchModify.replaceValues") }}</option>
          <option value="delete">{{ t("batchModify.deleteAttribute") }}</option>
        </select>
      </label>
      <label class="settings-field">
        <span>{{ t("batchModify.attribute") }}</span>
        <input
          v-model="attributeDraft"
          type="text"
          class="mono attribute-input"
          spellcheck="false"
          :aria-invalid="attributeInvalid"
          :aria-label="t('batchModify.attribute')"
          @keydown.enter.prevent="confirm"
        />
      </label>
      <p v-if="attributeInvalid" class="form-error">{{ t("batchModify.needAttribute") }}</p>
      <label class="settings-field">
        <span>{{ t("batchModify.values") }}</span>
        <textarea
          v-model="valuesDraft"
          class="mono values-input"
          rows="4"
          spellcheck="false"
          :aria-label="t('batchModify.values')"
        ></textarea>
      </label>
      <!-- delete 忽略值输入（valuesHint），此时不展示 needValue 校验错误。 -->
      <p v-if="valuesInvalid" class="form-error">{{ t("batchModify.needValue") }}</p>
      <p v-if="operation === 'delete'" class="hint">{{ t("batchModify.valuesHint") }}</p>
      <footer>
        <button type="button" @click="emit('close')">{{ t("cancel") }}</button>
        <button type="button" class="primary-button" :disabled="!canConfirm" @click="confirm">
          {{ submitting ? "…" : t("confirm") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* .settings-field 全局只覆盖 input/select，多行值输入这里补 scoped：
   边框/底色沿用弹窗输入质感，mono 字体 + 可纵向拖拽。 */
.batch-modify-modal .confirm-copy {
  margin: 0;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.batch-modify-modal .values-input {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--mono-font-family);
  font-size: 12px;
  resize: vertical;
  min-height: 72px;
}
</style>
