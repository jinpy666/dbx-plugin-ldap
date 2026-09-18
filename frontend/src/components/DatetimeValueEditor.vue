<script setup lang="ts">
// DatetimeValueEditor：时间值编辑器（表单页签属性行内使用）。
// - kind=datetime：RFC 4517 GeneralizedTime（createTimestamp/whenCreated 等）；
// - kind=filetime：AD FILETIME（pwdLastSet/accountExpires 等，1601 纪元 100ns）。
// 走查定稿：行内只保留原始值 + 可编辑日期选择器（step=1 带时分秒），不显示
// 「现在」按钮与人类可读预览行；哨兵值（0 / INT64_MAX）下选择器保持为空，
// 存储始终写回原始格式。
// 单值编辑：多值行由 dialog 降级回 textarea，不进本组件。
import { computed } from "vue";
import {
  formatGeneralizedTime,
  isGeneralizedTimeShape,
  parseGeneralizedTime,
  parseDatetimeLocalValue,
  toDatetimeLocalValue,
} from "../lib/generalizedTime";
import {
  filetimeSentinelLabel,
  filetimeToDate,
  isFiletimeShape,
  dateToFiletime,
} from "../lib/filetime";
import { t } from "../lib/i18n";

const props = defineProps<{
  modelValue: string;
  kind: "datetime" | "filetime";
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const isFiletime = computed(() => props.kind === "filetime");

// 哨兵值仅用于选择器判空（0 / INT64_MAX 不是真实时间点，不渲染成日期）。
const sentinelLabel = computed(() =>
  isFiletime.value ? filetimeSentinelLabel(props.modelValue, { notSet: t("ldap.valueEditors.notSet"), never: t("ldap.valueEditors.never") }) : null,
);

const invalid = computed(() => {
  if (props.modelValue.trim() === "") return false;
  return isFiletime.value ? !isFiletimeShape(props.modelValue) : !isGeneralizedTimeShape(props.modelValue);
});

// datetime-local 选择器的双向绑定：解析失败/哨兵值时选择器显示空
//（0 / INT64_MAX 不是真实时间点，渲染成 1601 年会误导）。
const pickerValue = computed(() => {
  if (isFiletime.value) {
    if (sentinelLabel.value) return "";
    const date = filetimeToDate(props.modelValue);
    return date ? toDatetimeLocalValue(date) : "";
  }
  const date = parseGeneralizedTime(props.modelValue);
  return date ? toDatetimeLocalValue(date) : "";
});

function onPickerInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (!value) return; // 清空选择器不清空原始值（显式删除走原始值框）
  const date = parseDatetimeLocalValue(value);
  if (!date) return;
  emit("update:modelValue", isFiletime.value ? dateToFiletime(date) : formatGeneralizedTime(date));
}
</script>

<template>
  <div class="datetime-editor" :class="{ 'is-invalid': invalid }">
    <div class="datetime-controls">
      <div class="datetime-control">
        <span class="datetime-control-label">{{ t("ldap.valueEditors.rawValue") }}</span>
        <input
          class="mono datetime-raw"
          type="text"
          :value="modelValue"
          :disabled="disabled"
          :aria-label="t('ldap.valueEditors.rawValue')"
          :placeholder="isFiletime ? '132223104000000000' : '20260102030405Z'"
          spellcheck="false"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="datetime-control">
        <span class="datetime-control-label">{{ t("ldap.valueEditors.pickDate") }}</span>
        <!-- step=1 让原生选择器带时分秒字段，与 LDAP 秒级精度对齐。 -->
        <input
          class="datetime-picker"
          type="datetime-local"
          step="1"
          :value="pickerValue"
          :disabled="disabled"
          :aria-label="t('ldap.valueEditors.pickDate')"
          @input="onPickerInput"
        />
      </div>
    </div>
    <p v-if="invalid" class="form-error">{{ isFiletime ? t("ldap.valueEditors.integerInvalid") : t("ldap.valueEditors.notDatetime") }}</p>
  </div>
</template>

<style scoped>
.datetime-editor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.datetime-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: flex-end;
}
.datetime-control {
  display: flex;
  min-width: 0;
  flex: 1 1 180px;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
}
.datetime-control-label {
  color: var(--muted-foreground);
  font-size: 9px;
}
.datetime-raw {
  min-width: 140px;
}
.is-invalid .datetime-raw {
  border-color: var(--danger, #c0392b);
}
</style>
