<script setup lang="ts">
// DnValueEditor：DN 值编辑器（member/manager/managedBy 等 DN 引用属性）。
// 文本输入（可手工粘贴 DN）+「从目录树选择」打开 DnPickerDialog 层级选择；
// 形态预检（dn.ts isLikelyDn）给出非阻断提示。多值行由 dialog 降级回
// textarea，不进本组件。
import { computed, ref } from "vue";
import { ListTree } from "@lucide/vue";
import DnPickerDialog from "./DnPickerDialog.vue";
import { isLikelyDn } from "../lib/dn";
import { t } from "../lib/i18n";

const props = defineProps<{
  modelValue: string;
  disabled?: boolean;
  /** 选择器浏览根（连接 Base DN）。 */
  baseDn?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const pickerOpen = ref(false);

const shapeHint = computed(() => props.modelValue.trim() !== "" && !isLikelyDn(props.modelValue));

function onPick(dn: string) {
  pickerOpen.value = false;
  emit("update:modelValue", dn);
}
</script>

<template>
  <div class="dn-editor">
    <div class="dn-controls">
      <input
        class="mono dn-input"
        type="text"
        :value="modelValue"
        :disabled="disabled"
        :aria-label="t('ldap.valueEditors.rawValue')"
        :aria-invalid="shapeHint"
        :placeholder="'cn=user,ou=people,dc=example,dc=com'"
        spellcheck="false"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <button type="button" class="toolbar-button" :disabled="disabled || !baseDn" @click="pickerOpen = true">
        <ListTree aria-hidden="true" /><span>{{ t("ldap.valueEditors.pickFromTree") }}</span>
      </button>
    </div>
    <p v-if="shapeHint" class="form-error">{{ t("ldap.valueEditors.dnShapeHint") }}</p>
    <DnPickerDialog :open="pickerOpen" :base-dn="baseDn ?? ''" @close="pickerOpen = false" @select="onPick" />
  </div>
</template>

<style scoped>
.dn-editor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.dn-controls {
  display: flex;
  gap: 6px;
  align-items: center;
}
.dn-input {
  flex: 1;
  min-width: 160px;
}
</style>
