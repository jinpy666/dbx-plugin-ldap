<script setup lang="ts">
// DatetimeValueEditor：时间值编辑器（表单页签属性行内使用）。
// - kind=datetime：RFC 4517 GeneralizedTime（createTimestamp/whenCreated 等）；
// - kind=filetime：AD FILETIME（pwdLastSet/accountExpires 等，1601 纪元 100ns）。
// 行为对齐 Apache Directory Studio：原始值始终可见可编辑、提供日期选择器与
// 「现在」快捷键、预览行显示人类可读时间，存储写回原始格式；FILETIME 的
// "0"/INT64_MAX 哨兵值显示语义标签而不渲染日期。单值编辑：多值行由 dialog
// 降级回 textarea，不进本组件。
import { computed } from "vue";
import { Clock } from "@lucide/vue";
import {
  formatGeneralizedTime,
  generalTimeDisplay,
  isGeneralizedTimeShape,
  parseGeneralizedTime,
  parseDatetimeLocalValue,
  toDatetimeLocalValue,
} from "../lib/generalizedTime";
import {
  filetimeDisplay,
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

const sentinelLabel = computed(() =>
  isFiletime.value ? filetimeSentinelLabel(props.modelValue, { notSet: t("ldap.valueEditors.notSet"), never: t("ldap.valueEditors.never") }) : null,
);

const preview = computed(() => {
  if (props.modelValue.trim() === "") return "";
  if (isFiletime.value) return filetimeDisplay(props.modelValue, { notSet: t("ldap.valueEditors.notSet"), never: t("ldap.valueEditors.never") });
  return generalTimeDisplay(props.modelValue);
});

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

function setNow() {
  emit("update:modelValue", isFiletime.value ? dateToFiletime(new Date()) : formatGeneralizedTime(new Date()));
}
</script>

<template>
  <div class="datetime-editor" :class="{ 'is-invalid': invalid }">
    <div class="datetime-controls">
      <label class="datetime-control">
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
      </label>
      <label class="datetime-control">
        <span class="datetime-control-label">{{ t("ldap.valueEditors.pickDate") }}</span>
        <input
          class="datetime-picker"
          type="datetime-local"
          :value="pickerValue"
          :disabled="disabled"
          :aria-label="t('ldap.valueEditors.pickDate')"
          @input="onPickerInput"
        />
      </label>
      <button type="button" class="toolbar-button" :disabled="disabled" :title="t('ldap.valueEditors.now')" @click="setNow">
        <Clock aria-hidden="true" /><span>{{ t("ldap.valueEditors.now") }}</span>
      </button>
    </div>
    <p v-if="sentinelLabel" class="datetime-preview">{{ sentinelLabel }}</p>
    <p v-else-if="preview" class="datetime-preview">{{ preview }} <span v-if="!isFiletime" class="muted">({{ t("ldap.valueEditors.previewUtc") }})</span></p>
    <p v-else-if="invalid" class="form-error">{{ isFiletime ? t("ldap.valueEditors.integerInvalid") : t("ldap.valueEditors.notDatetime") }}</p>
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
.datetime-picker {
  min-width: 180px;
}
.datetime-preview {
  font-size: 12px;
  opacity: 0.85;
  margin: 0;
}
.is-invalid .datetime-raw {
  border-color: var(--danger, #c0392b);
}
</style>
