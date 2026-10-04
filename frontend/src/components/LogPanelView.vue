// 请求日志面板（底部 dock：宿主以 surface=panel + plugin.mode=logs 注入同一
// ui 入口的独立 iframe，manifest open-ldap-logs 命令打开）。VSCode Output
// 风格的请求级日志流：
// - 挂载时 ldap/log/tail(after=游标) 回填缓冲历史（面板关闭期间的条目不丢），
//   onEvent 订阅 ldap/log 增量（App.vue 的 handleEvent 不消费该方法，互不抢）
// - 工具条：级别/连接过滤 + 子串查询 + 自动滚动 + 复制 + 清空
// - 面板 iframe 无 connectionId：tail 与 statuses 直连 window.dbxPlugin.invoke
//   （ldapApi.callLdap 会注入并强校验 connectionId，此处不能用）
// 数据面纯函数在 lib/logFeed（单测覆盖），本组件只持有列表与交互。
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronDown, Check, Copy, ScrollText, Trash2 } from "@lucide/vue";
import {
  collectConnectionIds,
  filterLogItems,
  formatLogLine,
  formatLogTime,
  mergeLogTail,
  nextLogCursor,
  parseLogEvent,
  type LogFeedItem,
  type LogLevel,
} from "../lib/logFeed";
import { t } from "../lib/i18n";
import { writeClipboardText } from "../lib/clipboard";
import VirtualList from "./VirtualList.vue";

// 单次回填上限：后端 ring 容量 1000，取两倍冗余防旧宿主缓冲更大。
const TAIL_LIMIT = 2000;

// 虚拟化行高（审查 M-5）：单行 nowrap（11px × line-height 1.7 ≈ 18.7px），
// 取 19px。1000 行全量 DOM + 每条事件强制 reflow 在高频日志下明显卡顿，
// 视口外行不再挂载。
const LOG_ROW_HEIGHT = 19;

const items = ref<LogFeedItem[]>([]);
const levelFilter = ref<"all" | LogLevel>("all");
const connectionFilter = ref<"all" | string>("all");
const query = ref("");
const autoScroll = ref(true);
const tailError = ref("");
const copied = ref(false);
// ref 类型按 expose 的方法面声明（泛型组件 InstanceType 不适用，DnTree 同款）。
const listRef = ref<{ scrollToIndex(index: number): void }>();

const filtered = computed(() =>
  filterLogItems(items.value, { level: levelFilter.value, connectionId: connectionFilter.value, query: query.value }),
);
const connectionOptions = computed(() => collectConnectionIds(items.value));

function connectionLabel(connectionId: string): string {
  return connectionNames.value.get(connectionId) ?? connectionId;
}

// statuses 提供连接显示名（best-effort：失败回退裸 connectionId）。
const connectionNames = ref(new Map<string, string>());

let unsubscribe: (() => void) | undefined;
let copiedTimer = 0;
// 连续事件的滚动合并（rAF 节流）：高频日志下每条事件只排一次滚底，
// 不再逐条 nextTick + 读 scrollHeight 强制布局。
let scrollRaf = 0;

function scrollToBottom() {
  if (!autoScroll.value) return;
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    listRef.value?.scrollToIndex(filtered.value.length - 1);
  });
}

function push(entry: LogFeedItem) {
  // 审查 B-M3：live 事件不保证到达序=seq 序（后端每请求一个 goroutine，
  // Append 与 emit 之间可交错），复用 mergeLogTail 的 seq 排序+去重合入，
  // 面板时间轴不再倒挂；n≤1000 的单条合并成本可接受。
  items.value = mergeLogTail(items.value, [entry]);
  scrollToBottom();
}

// 过滤条件变化后列表内容整体换代：自动滚动开启时跟随到底部。
watch([levelFilter, connectionFilter, query], () => scrollToBottom());

// 回填历史：after=已见最大 seq（增量语义，重开面板不重复）。连接名与回填
// 并行 best-effort，任一失败不影响增量渲染。
async function backfill() {
  try {
    const result = await window.dbxPlugin.invoke<{ entries?: unknown[] }>("ldap/log/tail", {
      after: nextLogCursor(items.value),
      limit: TAIL_LIMIT,
    });
    const parsed = (result.entries ?? [])
      .map((entry) => parseLogEvent(entry, Date.now()))
      .filter((entry): entry is LogFeedItem => entry !== undefined);
    if (parsed.length) {
      items.value = mergeLogTail(items.value, parsed);
      scrollToBottom();
    }
    tailError.value = "";
  } catch (cause) {
    tailError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function loadConnectionNames() {
  try {
    const result = await window.dbxPlugin.invoke<{ statuses?: Array<{ connectionId: string; name?: string }> }>(
      "ldap/connections/statuses",
    );
    const next = new Map<string, string>();
    for (const row of result.statuses ?? []) {
      if (row.connectionId && row.name) next.set(row.connectionId, row.name);
    }
    connectionNames.value = next;
  } catch {
    // 旧 sidecar / 瞬断：下拉退回裸 connectionId。
  }
}

function handleEvent(event: DbxPluginEvent) {
  if (event.type === "env") return;
  if (event.method !== "ldap/log") return;
  const parsed = parseLogEvent(event.params, Date.now());
  if (parsed) push(parsed);
}

function clearLog() {
  items.value = [];
  tailError.value = "";
}

function toggleAutoScroll() {
  autoScroll.value = !autoScroll.value;
  if (autoScroll.value) scrollToBottom();
}

async function copyLog() {
  const text = filtered.value.map((entry) => formatLogLine(entry, formatLogTime(entry.at))).join("\n");
  if (!text) return;
  copied.value = await writeClipboardText(text);
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => (copied.value = false), 1500);
}

function levelLabel(level: LogFeedItem["level"]): string {
  return t(`logs.level.${level}`);
}

function resultBadgeClass(result: LogFeedItem["result"]): string {
  return result === "ok" ? "log-badge-ok" : result === "denied" ? "log-badge-denied" : "log-badge-error";
}

onMounted(() => {
  const api = window.dbxPlugin;
  if (api?.onEvent) unsubscribe = api.onEvent(handleEvent);
  void backfill();
  void loadConnectionNames();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  window.clearTimeout(copiedTimer);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
});
</script>

<template>
  <section class="log-panel" :aria-label="t('logs.title')">
    <header class="log-toolbar">
      <span class="log-title">
        <ScrollText aria-hidden="true" />
        <span>{{ t("logs.title") }}</span>
        <span class="log-count" :class="{ 'log-count-filtered': filtered.length !== items.length }">
          {{ filtered.length === items.length ? t("logs.entries", { total: items.length }) : t("logs.filtered", { shown: filtered.length, total: items.length }) }}
        </span>
      </span>
      <select v-model="levelFilter" class="log-select" :aria-label="t('logs.levelFilter')">
        <option value="all">{{ t("logs.levelAll") }}</option>
        <option value="info">{{ t("logs.level.info") }}</option>
        <option value="warn">{{ t("logs.level.warn") }}</option>
        <option value="error">{{ t("logs.level.error") }}</option>
      </select>
      <select v-model="connectionFilter" class="log-select" :aria-label="t('logs.connectionFilter')">
        <option value="all">{{ t("logs.connectionAll") }}</option>
        <option v-for="connectionId in connectionOptions" :key="connectionId" :value="connectionId">
          {{ connectionLabel(connectionId) }}
        </option>
      </select>
      <input v-model="query" type="search" class="log-query" :placeholder="t('logs.queryPlaceholder')" :aria-label="t('logs.queryPlaceholder')" />
      <button
        type="button"
        class="log-tool"
        :class="{ 'log-tool-active': autoScroll }"
        :aria-pressed="autoScroll"
        :title="t('logs.autoScroll')"
        @click="toggleAutoScroll"
      >
        <ChevronDown aria-hidden="true" />
      </button>
      <button
        type="button"
        class="log-tool"
        :disabled="filtered.length === 0"
        :title="copied ? t('logs.copied') : t('logs.copy')"
        @click="copyLog"
      >
        <Check v-if="copied" aria-hidden="true" />
        <Copy v-else aria-hidden="true" />
      </button>
      <button type="button" class="log-tool" :disabled="items.length === 0" :title="t('logs.clear')" @click="clearLog">
        <Trash2 aria-hidden="true" />
      </button>
    </header>
    <p v-if="tailError" class="log-tail-error" role="alert">{{ t("logs.tailFailed") }}: {{ tailError }}</p>
    <div class="log-list" role="log">
      <p v-if="filtered.length === 0" class="log-empty">{{ items.length === 0 ? t("logs.empty") : t("logs.emptyFiltered") }}</p>
      <VirtualList v-else ref="listRef" :items="filtered" :row-height="LOG_ROW_HEIGHT" class="log-vlist">
        <template #default="{ item }">
          <div
            class="log-row"
            :class="`log-row-${item.level}`"
            :title="item.detail || item.target || item.method"
          >
            <span class="log-time">{{ formatLogTime(item.at) }}</span>
            <span class="log-badge" :class="resultBadgeClass(item.result)">{{ item.result }}</span>
            <span class="log-level" :class="`log-level-${item.level}`">{{ levelLabel(item.level) }}</span>
            <span class="log-method">{{ item.method }}</span>
            <span v-if="item.source && item.source !== 'ui'" class="log-source">{{ item.source }}</span>
            <span v-if="item.connectionId" class="log-connection">{{ connectionLabel(item.connectionId) }}</span>
            <span class="log-target">{{ item.target || "—" }}</span>
            <span v-if="item.detail" class="log-detail">{{ item.detail }}</span>
            <span v-if="item.durationMs" class="log-duration">{{ item.durationMs }}ms</span>
          </div>
        </template>
      </VirtualList>
    </div>
  </section>
</template>

<style scoped>
/* 组件内自持样式（同 AuditFeedPanel 先例）：面板是独立宿主容器，不复用
   main-pane 的 audit-feed 布局；颜色全部走宿主令牌，明暗主题自动跟随。 */
.log-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--background);
  color: var(--foreground);
}
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.log-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  margin-right: 4px;
  white-space: nowrap;
}
.log-count {
  font-weight: 400;
}
.log-count-filtered {
  color: var(--primary);
}
.log-select,
.log-query {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 220px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--background);
  color: var(--foreground);
  font-size: 11px;
  padding: 2px 6px;
}
.log-query {
  flex: 1 1 120px;
}
.log-tool {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.log-tool:hover:not(:disabled) {
  background: var(--accent);
  color: var(--accent-foreground);
}
.log-tool:disabled {
  opacity: 0.4;
  cursor: default;
}
.log-tool-active {
  color: var(--primary);
  border-color: var(--border);
}
.log-tail-error {
  flex: 0 0 auto;
  margin: 0;
  padding: 2px 10px;
  font-size: 11px;
  color: var(--destructive);
}
.log-list {
  flex: 1 1 auto;
  min-height: 0;
  font-family: var(--mono-font-family);
  font-size: 11px;
  line-height: 1.7;
  padding: 2px 0;
}
/* VirtualList 是真正的滚动容器（.vlist 全局 height:100%），字体继承自
   .log-list；行高由 :row-height 固定（LOG_ROW_HEIGHT），行内不再自行撑高。 */
.log-vlist :deep(.log-row) {
  height: 19px;
}
.log-empty {
  margin: 0;
  padding: 8px 10px;
  color: var(--muted-foreground);
  font-family: var(--ui-font-family);
}
.log-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 10px;
  white-space: nowrap;
}
.log-row:hover {
  background: var(--accent);
}
.log-row-error {
  background: color-mix(in srgb, var(--destructive) 12%, transparent);
}
.log-row-error:hover {
  background: color-mix(in srgb, var(--destructive) 20%, transparent);
}
.log-time {
  flex: 0 0 auto;
  color: var(--muted-foreground);
}
.log-badge {
  flex: 0 0 auto;
  border-radius: 4px;
  padding: 0 5px;
  font-size: 10px;
}
.log-badge-ok {
  color: var(--muted-foreground);
  border: 1px solid var(--border);
}
.log-badge-denied {
  color: var(--destructive);
  border: 1px solid color-mix(in srgb, var(--destructive) 55%, transparent);
}
.log-badge-error {
  color: var(--destructive);
  border: 1px solid color-mix(in srgb, var(--destructive) 55%, transparent);
}
.log-level {
  flex: 0 0 auto;
  min-width: 30px;
}
.log-level-warn {
  color: #d97706;
}
.log-level-error {
  color: var(--destructive);
}
.log-method {
  flex: 0 0 auto;
  color: var(--primary);
}
.log-source {
  flex: 0 0 auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  font-size: 10px;
  color: var(--muted-foreground);
}
.log-connection {
  flex: 0 0 auto;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted-foreground);
}
.log-target {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}
.log-detail {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted-foreground);
}
.log-duration {
  flex: 0 0 auto;
  color: var(--muted-foreground);
}
</style>
