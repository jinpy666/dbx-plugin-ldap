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
import { computed, onBeforeUnmount, nextTick, onMounted, ref } from "vue";
import { ChevronDown, Check, Copy, ScrollText, Trash2 } from "@lucide/vue";
import {
  collectConnectionIds,
  filterLogItems,
  formatLogLine,
  formatLogTime,
  mergeLogTail,
  nextLogCursor,
  parseLogEvent,
  pushLogItem,
  type LogFeedItem,
  type LogLevel,
} from "../lib/logFeed";
import { t } from "../lib/i18n";
import { writeClipboardText } from "../lib/clipboard";

// 单次回填上限：后端 ring 容量 1000，取两倍冗余防旧宿主缓冲更大。
const TAIL_LIMIT = 2000;

const items = ref<LogFeedItem[]>([]);
const levelFilter = ref<"all" | LogLevel>("all");
const connectionFilter = ref<"all" | string>("all");
const query = ref("");
const autoScroll = ref(true);
const tailError = ref("");
const copied = ref(false);
const listRef = ref<HTMLElement>();

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

async function scrollToBottom() {
  await nextTick();
  const element = listRef.value;
  if (element && autoScroll.value) element.scrollTop = element.scrollHeight;
}

function push(entry: LogFeedItem) {
  items.value = pushLogItem(items.value, entry);
  void scrollToBottom();
}

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
      void scrollToBottom();
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
  if (autoScroll.value) void scrollToBottom();
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
});
</script>

<template>
  <section class="log-panel" aria-label="LDAP Logs">
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
    <div ref="listRef" class="log-list" role="log">
      <p v-if="filtered.length === 0" class="log-empty">{{ items.length === 0 ? t("logs.empty") : t("logs.emptyFiltered") }}</p>
      <div
        v-for="entry in filtered"
        :key="entry.seq"
        class="log-row"
        :class="`log-row-${entry.level}`"
        :title="entry.detail || entry.target || entry.method"
      >
        <span class="log-time">{{ formatLogTime(entry.at) }}</span>
        <span class="log-badge" :class="resultBadgeClass(entry.result)">{{ entry.result }}</span>
        <span class="log-level" :class="`log-level-${entry.level}`">{{ levelLabel(entry.level) }}</span>
        <span class="log-method">{{ entry.method }}</span>
        <span v-if="entry.source && entry.source !== 'ui'" class="log-source">{{ entry.source }}</span>
        <span v-if="entry.connectionId" class="log-connection">{{ connectionLabel(entry.connectionId) }}</span>
        <span class="log-target">{{ entry.target || "—" }}</span>
        <span v-if="entry.detail" class="log-detail">{{ entry.detail }}</span>
        <span v-if="entry.durationMs" class="log-duration">{{ entry.durationMs }}ms</span>
      </div>
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
  overflow: auto;
  font-family: var(--mono-font-family);
  font-size: 11px;
  line-height: 1.7;
  padding: 2px 0;
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
