<script setup lang="ts">
// 值编辑器弹窗壳（ADS 交互）：特殊类型值（时间/DN/二进制/密码/UAC）在条目
// 编辑器里只读展示，点「编辑」打开本弹窗，内嵌对应编辑器组件；打开瞬间把
// modelValue 拷进草稿，OK 才 emit confirm 写回，Cancel 只 close 不落值。
// binary 编辑器按数组（一行一值）进出，弹窗统一字符串语义按 \n 切分/合并。
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";
import DatetimeValueEditor from "./DatetimeValueEditor.vue";
import DnValueEditor from "./DnValueEditor.vue";
import BinaryValueEditor from "./BinaryValueEditor.vue";
import PasswordAttributeEditor from "./PasswordAttributeEditor.vue";
import UacValueEditor from "./UacValueEditor.vue";

export type ValueDialogKind = "datetime" | "filetime" | "dn" | "binary" | "password" | "uac";

const props = defineProps<{
  open: boolean;
  kind: ValueDialogKind;
  /** 弹窗标题里展示的属性行名（可为空）。 */
  attributeName?: string;
  modelValue: string;
  disabled?: boolean;
  /** dn 编辑器的搜索根 / password 编辑器的 RFC 3062 扩展操作目标。 */
  baseDn?: string;
  dn?: string;
}>();

const emit = defineEmits<{
  (e: "confirm", value: string): void;
  (e: "close"): void;
  (e: "openReference", dn: string): void;
  (e: "notify", message: string): void;
  (e: "error", message: string): void;
  (e: "plainGenerated", plain: string): void;
}>();

// 草稿只在打开瞬间拷贝：Cancel 丢弃编辑、OK 才写回（ ADS 同款语义）。
const draft = ref(props.modelValue);
watch(
  () => props.open,
  (open) => {
    if (open) draft.value = props.modelValue;
  },
);

// binary 编辑器是数组语义（一行一值），空串视为无值。
const binaryValues = computed<string[]>(() => (draft.value === "" ? [] : draft.value.split("\n")));

// 标题复用值类型标签（formatXxx），与行内类型标签同一套文案。
const kindLabel = computed(() => {
  switch (props.kind) {
    case "password": return t("ldap.valueEditors.formatPassword");
    case "binary": return t("ldap.valueEditors.formatBinary");
    case "datetime": return t("ldap.valueEditors.formatGeneralizedTime");
    case "filetime": return t("ldap.valueEditors.formatFiletime");
    case "dn": return t("ldap.valueEditors.formatDn");
    default: return t("ldap.valueEditors.formatUac");
  }
});

function confirm() {
  emit("confirm", draft.value);
}

useModalA11y(
  () => props.open,
  { close: () => emit("close") },
);
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal value-editor-dialog" role="dialog" aria-modal="true" :aria-label="kindLabel">
      <header>
        <h2>{{ kindLabel }}<span v-if="attributeName" class="mono value-editor-attr"> · {{ attributeName }}</span></h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <div class="value-editor-body">
        <DatetimeValueEditor v-if="kind === 'datetime' || kind === 'filetime'" :kind="kind" v-model="draft" :disabled="disabled" />
        <DnValueEditor v-else-if="kind === 'dn'" v-model="draft" :disabled="disabled" :base-dn="baseDn" @open-reference="emit('openReference', $event)" />
        <BinaryValueEditor v-else-if="kind === 'binary'" :attribute-name="attributeName ?? ''" :model-value="binaryValues" :disabled="disabled" @update:model-value="draft = $event.join('\n')" @notify="emit('notify', $event)" />
        <PasswordAttributeEditor
          v-else-if="kind === 'password'"
          v-model="draft"
          :disabled="disabled"
          :dn="dn"
          @plain-generated="emit('plainGenerated', $event)"
          @notify="emit('notify', $event)"
          @error="emit('error', $event)"
        />
        <UacValueEditor v-else v-model="draft" :disabled="disabled" />
      </div>
      <footer>
        <button type="button" class="value-editor-cancel" @click="emit('close')">{{ t("cancel") }}</button>
        <button type="button" class="primary-button value-editor-confirm" :disabled="disabled" @click="confirm">{{ t("editor.valueEditorConfirm") }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 与 editor-modal 同级的二层面板：宽度按最宽的内嵌编辑器（binary）给足。 */
.value-editor-dialog {
  width: min(640px, 92vw);
}
.value-editor-attr {
  font-size: 12px;
  color: var(--muted-foreground);
}
.value-editor-body {
  min-height: 0;
  overflow: auto;
}
</style>
