<script setup lang="ts">
// ObjectClassPickerDialog:条目编辑器 objectClass chips 行的「添加」选择器
// (对标 Apache Directory Studio ObjectClass Editor 的类选择弹窗)。
// 数据源 = schema.objectClassAttributes(键 = 类名);schema 缺失/为空时回退
// builtinSchema 的内置常用类表——与新建向导同源,保证 subschema 被禁读的
// 服务器上选择器仍可用而不是空壳。点击列表项 = 加入该类(emit add,由父级
// 写回行 valuesText;弹窗保持打开以支持连续添加),「关闭」退出。已被当前
// 行使用的类标记已选(✓)并禁点:LDAP 中同一 objectClass 不可重复声明。
import { computed, nextTick, ref, watch } from "vue";
import { Check, X } from "@lucide/vue";
import type { LdapSchema } from "../lib/newEntryTemplates";
import { BUILTIN_OBJECT_CLASSES } from "../lib/builtinSchema";
import { useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";

interface PickerItem {
  name: string;
  must: string[];
}

const props = defineProps<{
  open: boolean;
  schema?: LdapSchema;
  /** 当前行已使用的类(小写),用于「已选禁点」。 */
  usedClasses?: string[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "add", className: string): void;
}>();

const search = ref("");
const searchInput = ref<HTMLInputElement>();

// schema 缺失时的兜底列表(builtinSchema 内置常用类,含 must/may)。
const FALLBACK_ITEMS: PickerItem[] = Object.values(BUILTIN_OBJECT_CLASSES).map((definition) => ({
  name: definition.name,
  must: definition.must,
}));

const items = computed<PickerItem[]>(() => {
  const map = props.schema?.objectClassAttributes;
  const fromSchema = map
    ? Object.keys(map).map((name) => ({ name, must: map[name]?.must ?? [] }))
    : [];
  const source = fromSchema.length > 0 ? fromSchema : FALLBACK_ITEMS;
  // 类名排序:真实服务器的 schema 可达数百类,字母序比 wire 顺序更可扫读。
  return [...source].sort((left, right) => left.name.localeCompare(right.name));
});

const filtered = computed<PickerItem[]>(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return items.value;
  return items.value.filter((item) => item.name.toLowerCase().includes(query));
});

function isUsed(item: PickerItem): boolean {
  return (props.usedClasses ?? []).includes(item.name.trim().toLowerCase());
}

function choose(item: PickerItem) {
  if (isUsed(item)) return;
  emit("add", item.name);
}

// useModalA11y 以「当前文档唯一弹窗」为前提(全局容器查询),双层模态下
// 初始聚焦不可依赖它:这里自己把焦点放进搜索框,连续添加时焦点也不丢。
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    search.value = "";
    void nextTick(() => searchInput.value?.focus());
  },
  { immediate: true },
);

// Esc 关闭仍走统一弹窗语义;编辑器侧 canRequestClose 会对 picker 打开态整体
// 否决,保证 Esc 只关本层而不动编辑器里的编辑。
useModalA11y(
  () => props.open,
  { close: () => emit("close") },
);
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal small-modal oc-picker-modal" role="dialog" aria-modal="true" :aria-label="t('editor.objectClassPickerTitle')">
      <header>
        <h2>{{ t("editor.objectClassPickerTitle") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <input
        ref="searchInput"
        v-model="search"
        type="text"
        class="oc-picker-search"
        :placeholder="t('editor.objectClassSearch')"
        :aria-label="t('editor.objectClassSearch')"
        spellcheck="false"
      />
      <p v-if="filtered.length === 0" class="empty oc-picker-empty">{{ t("editor.objectClassEmpty") }}</p>
      <ul v-else class="oc-picker-list">
        <li v-for="item in filtered" :key="item.name">
          <button type="button" class="oc-picker-item" :disabled="isUsed(item)" @click="choose(item)">
            <span class="oc-picker-name mono">{{ item.name }}</span>
            <Check v-if="isUsed(item)" class="oc-picker-used" aria-hidden="true" />
            <small v-if="item.must.length > 0" class="oc-picker-must">{{ t("editor.objectClassMustHint", { attributes: item.must.join(", ") }) }}</small>
          </button>
        </li>
      </ul>
      <footer>
        <!-- i18n 无专用「完成」键:复用 close(关闭)承担"结束连续添加"语义。 -->
        <button type="button" class="primary-button" @click="emit('close')">{{ t("close") }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.oc-picker-modal {
  min-height: 320px;
  max-height: 70vh;
}
.oc-picker-search {
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 10px;
  background: var(--background);
  color: var(--foreground);
}
.oc-picker-list {
  min-height: 0;
  flex: 1;
  overflow: auto;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.oc-picker-item {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  background: var(--background);
  color: var(--foreground);
  cursor: pointer;
  text-align: left;
}
.oc-picker-item:hover:not(:disabled) {
  background: var(--accent);
}
.oc-picker-item:disabled {
  opacity: 0.55;
  cursor: default;
}
.oc-picker-name {
  font-weight: 600;
}
.oc-picker-used {
  width: 14px;
  height: 14px;
  color: var(--muted-foreground);
}
.oc-picker-must {
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
  text-align: left;
}
.oc-picker-empty {
  margin: 0;
}
</style>
