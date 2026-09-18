// 审计事件面板：最近 `ldap/audit` 事件的工作台可视化（§11.2 候选）。
// 数据面在 App.vue（handleEvent → lib/auditFeed 纯函数），本组件纯展示：
// - 头部常驻：事件总数 + denied/error 计数徽标（denied 高亮为 destructive）
// - 列表折叠可展开；denied 事件到达（含初始列表）时自动展开保证可见，
//   error 仅徽标高亮不展开
// - 清空按钮由父级处理（App.vue 持有列表状态）
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronDown, ChevronRight, ScrollText, Trash2 } from "@lucide/vue";
import { formatAuditTime, type AuditFeedItem } from "../lib/auditFeed";
import { t } from "../lib/i18n";

const props = defineProps<{ items: AuditFeedItem[] }>();
const emit = defineEmits<{ (e: "clear"): void }>();

const expanded = ref(false);
const hasEvents = computed(() => props.items.length > 0);
const deniedCount = computed(() => props.items.filter((item) => item.result !== "ok").length);

// denied 事件自动展开（含初始挂载即携带 denied 的场景），保证拒绝可见；
// error 只做徽标/计数高亮，不展开打断当前视图。监听数组引用（父组件每次
// 到达/清空都替换数组）：只要更新后的列表仍含 denied 就恢复展开，兜住
// "清空后面板保持可见、新事件到达即恢复列表"的空态回路。
watch(
  () => props.items,
  (items) => {
    if (items.some((item) => item.result === "denied")) expanded.value = true;
  },
  { immediate: true },
);

const summary = computed(() => {
  if (!hasEvents.value) return t("audit.empty");
  const total = t("audit.events", { total: props.items.length });
  return deniedCount.value > 0 ? `${total} · ${t("audit.deniedCount", { denied: deniedCount.value })}` : total;
});

function resultLabel(result: AuditFeedItem["result"]): string {
  return t(`audit.result.${result}`);
}

// F10：耗时展示为「耗时标签 + 123ms」；仅新事件携带 durationMs>0 时出现。
function durationLabel(durationMs: number): string {
  return `${t("audit.duration")} ${durationMs}ms`;
}
</script>

<template>
  <section v-if="hasEvents || expanded" class="audit-feed" :class="{ 'audit-feed-denied': deniedCount > 0 }">
    <div class="audit-header">
      <button
        type="button"
        class="audit-toggle"
        :disabled="!hasEvents"
        :aria-expanded="expanded"
        :title="expanded ? t('audit.hide') : t('audit.show')"
        @click="expanded = !expanded"
      >
        <ChevronDown v-if="expanded" aria-hidden="true" />
        <ChevronRight v-else aria-hidden="true" />
        <ScrollText aria-hidden="true" />
        <span class="audit-title">{{ t("audit.title") }}</span>
        <span class="audit-summary" :class="{ 'audit-summary-denied': deniedCount > 0 }">{{ summary }}</span>
      </button>
      <button v-if="hasEvents" type="button" class="audit-clear" :title="t('audit.clear')" @click="emit('clear')">
        <Trash2 aria-hidden="true" />
      </button>
    </div>
    <ol v-if="expanded && hasEvents" class="audit-list">
      <li
        v-for="item in items"
        :key="item.id"
        class="audit-item"
        :class="`audit-item-${item.result}`"
        :title="item.detail || item.target"
      >
        <span class="audit-time">{{ formatAuditTime(item.at) }}</span>
        <span class="audit-badge" :class="`audit-badge-${item.result}`">{{ resultLabel(item.result) }}</span>
        <!-- F10：操作名徽标（旧事件无 operation 字段时不显示）。 -->
        <span v-if="item.operation" class="audit-op" :title="`${t('audit.operation')}: ${item.operation}`">{{ item.operation }}</span>
        <span class="audit-action">{{ item.action }}</span>
        <span class="audit-target">{{ item.target || "—" }}</span>
        <span v-if="item.durationMs && item.durationMs > 0" class="audit-duration">{{ durationLabel(item.durationMs) }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
/* F10 新增元素的操作徽标与耗时（style.css 尚无 audit 系列规则，先组件内自持）：
   徽标沿用小号 mono 的中性观感，不与 result 徽标抢视觉层级。 */
.audit-op {
  flex: 0 0 auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  font-family: var(--mono-font-family);
  font-size: 10px;
  color: var(--muted-foreground);
}
.audit-duration {
  flex: 0 0 auto;
  color: var(--muted-foreground);
  font-size: 10px;
  white-space: nowrap;
}
</style>
