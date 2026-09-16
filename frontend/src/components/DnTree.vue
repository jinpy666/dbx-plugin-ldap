<script setup lang="ts">
// DN 树：scope=one 懒展开 + 关键字远程子树过滤 + 右键菜单。
// 交互语义对照 tiny-rdm LdapConsolePage 的树区块（fetchTreeChildren /
// buildTreeKeywordFilter / searchTreeFilterRemote），组件按 DBX 插件形态重实现。
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Clipboard, Copy, Download, Eye, Pencil, Plus, RefreshCw, Search, Trash2, Users, X } from "@lucide/vue";
import { getLdapConnectionId, ldapApi, type LdapEntry, type LdapSearchPage, type LdapSearchSessionResult } from "../lib/api";
import { buildTreeKeywordFilter } from "../lib/ldapFilter";
import { friendlyLdapError } from "../lib/ldapErrors";
import { splitFirstDnRdn } from "../lib/dn";
import { nextFocusIndex } from "../lib/modal";
import { t } from "../lib/i18n";
import { compareDnByLabel, compareDnForTree, flattenDnTree, nextTreeFocusIndex, TREE_FETCH_PAGE, type DnTreeNode } from "../lib/dnTree";
import VirtualList from "./VirtualList.vue";
import TreeBranch from "./TreeBranch.vue";
import TreeNodeIcon from "./TreeNodeIcon.vue";

const props = defineProps<{
  baseDn: string;
  canWrite: boolean;
  disabled?: boolean;
  /** Passed by App so an old search can be cancelled after a connection switch. */
  connectionId?: string;
}>();

const emit = defineEmits<{
  (e: "select", dn: string): void;
  (e: "searchHere", dn: string): void;
  (e: "view", dn: string): void;
  (e: "members", dn: string): void;
  (e: "add", dn: string): void;
  (e: "copyEntry", dn: string): void;
  (e: "rename", dn: string): void;
  (e: "remove", dn: string): void;
  (e: "export", dn: string): void;
  (e: "copyDn", dn: string): void;
}>();
const rootNode = ref<DnTreeNode>();
const treeError = ref("");
const treeErrorRaw = ref("");
const loadingRoot = ref(false);
const selectedDn = ref("");
const filterKeyword = ref("");
const filterLoading = ref(false);
const filterError = ref("");
const filterErrorRaw = ref("");
const filterResults = ref<LdapEntry[]>([]);
const contextMenu = ref<{ x: number; y: number; dn: string }>();
let filterSequence = 0;
let filterTimer = 0;

interface ChildSearchSession {
  searchId: string;
  connectionId: string;
  hasMore: boolean;
}

// A node owns exactly one live server-side cursor.  Do not store this on the
// reactive node object: sessions are transport state, not tree presentation.
const childSessions = new Map<string, ChildSearchSession>();
let treeGeneration = 0;

const TREE_ATTRIBUTES = ["dn", "name", "cn", "ou", "objectClass"];
// 请求列（只用于展示/补全，服务器对未知属性名回缺席名不报错）：树过滤命中
// 面已扩到 dc/o/sn/givenName（与 buildTreeKeywordFilter 的属性集对齐）。
const FILTER_ATTRIBUTES = ["dn", "name", "cn", "ou", "dc", "uid", "o", "sn", "givenName", "displayName", "mail", "objectClass"];
// 关键字远程过滤的单次抓取上限：达到即视为"可能有更多"，给可见截断提示。
const TREE_FILTER_LIMIT = 100;

// 过滤结果按 RDN 标签字母排序（服务器返回序无保障；字母序可预期、可扫描）。
const sortedFilterResults = computed(() => [...filterResults.value].sort((left, right) => compareDnByLabel(left.dn, right.dn)));

// 虚拟滚动固定行高（与 .tree-vlist CSS 保持一致）；零依赖实现见 VirtualList.vue。
const TREE_ROW_HEIGHT = 28;

// -- 侧栏宽度（右缘 resizer 拖拽，localStorage 记忆，双击重置默认宽）----------
// 宿主 webview 禁存储时静默降级为仅内存态。数值口径与 kafka TopicTree 同族。

const TREE_WIDTH_KEY = "dbx.ldap.ui.treeWidth";
const TREE_WIDTH_DEFAULT = 280;
const TREE_WIDTH_MIN = 200;
const TREE_WIDTH_MAX = 480;

function readStoredWidth(): number {
  try {
    const parsed = Number.parseInt(localStorage.getItem(TREE_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(parsed) ? Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, parsed)) : TREE_WIDTH_DEFAULT;
  } catch {
    return TREE_WIDTH_DEFAULT;
  }
}

function persistWidth(value: number) {
  try {
    localStorage.setItem(TREE_WIDTH_KEY, String(value));
  } catch {
    /* 存储不可用（隐私模式等）：仅内存态 */
  }
}

const paneWidth = ref(readStoredWidth());

function clampWidth(value: number): number {
  return Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(value)));
}

// resizer：pointer capture 拖拽（移出面板也不丢），双击重置默认宽。
const resizing = ref(false);
let dragStartX = 0;
let dragStartWidth = 0;

function onResizeStart(event: PointerEvent) {
  event.preventDefault();
  dragStartX = event.clientX;
  dragStartWidth = paneWidth.value;
  resizing.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onResizeMove(event: PointerEvent) {
  if (!resizing.value) return;
  paneWidth.value = clampWidth(dragStartWidth + event.clientX - dragStartX);
}

function onResizeEnd(event: PointerEvent) {
  if (!resizing.value) return;
  resizing.value = false;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  persistWidth(paneWidth.value);
}

function onResizeReset() {
  paneWidth.value = TREE_WIDTH_DEFAULT;
  persistWidth(TREE_WIDTH_DEFAULT);
}

const hasBaseDn = computed(() => props.baseDn.trim() !== "");
const hasFilter = computed(() => filterKeyword.value.trim() !== "");

// 可见行扁平投影：VirtualList 只渲染视口 ± 缓冲窗口，千行子条目不再一次
// 性挂载全量 DOM。展开/选中/右键语义不变（状态仍在 node 对象上）。
const treeRows = computed(() => flattenDnTree(rootNode.value));
const visibleList = ref<{ scrollToIndex(index: number): void }>();

function nodeLabel(dn: string): string {
  const { rdn } = splitFirstDnRdn(dn);
  return rdn || dn || "-";
}

function makeNode(dn: string): DnTreeNode {
  return { dn, label: nodeLabel(dn), expanded: false, loaded: false, loading: false, children: [] };
}

function currentConnectionId(): string {
  return props.connectionId || getLdapConnectionId();
}

function nodeSessionKey(node: Pick<DnTreeNode, "dn">): string {
  return node.dn.toLowerCase();
}

function nodeIsCurrent(node: DnTreeNode, generation: number, connectionId: string): boolean {
  if (generation !== treeGeneration || connectionId !== currentConnectionId()) return false;
  const key = nodeSessionKey(node);
  // Vue wraps data assigned to a ref in a proxy, so object identity is not
  // stable across the component boundary. DNs are unique within this tree.
  const visit = (candidate?: DnTreeNode): boolean => nodeSessionKey(candidate ?? { dn: "" }) === key || !!candidate?.children.some(visit);
  return visit(rootNode.value);
}

function cancelSearch(searchId: string, connectionId: string) {
  // Cancellation is cleanup only.  A disconnected/expired sidecar must not
  // replace an otherwise useful tree with an error banner.
  void ldapApi.searchCancel(searchId, connectionId || undefined).catch(() => {});
}

function releaseNodeSessions(node?: DnTreeNode) {
  if (!node) return;
  for (const child of node.children) releaseNodeSessions(child);
  const key = nodeSessionKey(node);
  const session = childSessions.get(key);
  if (!session) return;
  childSessions.delete(key);
  cancelSearch(session.searchId, session.connectionId);
}

function resetTreeSessions() {
  treeGeneration += 1;
  releaseNodeSessions(rootNode.value);
}

function appendChildren(node: DnTreeNode, entries: LdapSearchPage["entries"]) {
  // LDAP paged-results is a continuation, not an offset.  Keep existing node
  // objects so descendants that the user has expanded remain expanded, then
  // add only genuinely new DNs.  Re-sorting affects display order only.
  const existing = new Set(node.children.map((child) => child.dn.toLowerCase()));
  for (const entry of entries) {
    const dn = entry.dn.trim();
    const key = dn.toLowerCase();
    if (!dn || key === node.dn.toLowerCase() || existing.has(key)) continue;
    existing.add(key);
    node.children.push(makeNode(dn));
  }
  node.children.sort((left, right) => compareDnForTree(left.dn, right.dn));
}

function applyPage(node: DnTreeNode, session: ChildSearchSession, page: LdapSearchPage) {
  appendChildren(node, page.entries);
  session.hasMore = page.hasMore;
  // Only the server cursor can establish completeness.  Never infer it from
  // a short page, otherwise a server-side page policy could silently hide DNs.
  node.truncated = page.hasMore;
  if (page.hasMore) childSessions.set(nodeSessionKey(node), session);
  else {
    childSessions.delete(nodeSessionKey(node));
    node.childCount = node.children.length;
  }
  node.loaded = true;
}

function childSearchRequest(dn: string) {
  return {
    baseDn: dn,
    filter: "(objectClass=*)",
    scope: "one" as const,
    attributes: TREE_ATTRIBUTES,
    pageSize: TREE_FETCH_PAGE,
    derefAliases: "never" as const,
  };
}

/** Starts one stable LDAP Paged Results cursor and applies its first page. */
async function startChildren(node: DnTreeNode, generation: number): Promise<boolean> {
  const connectionId = currentConnectionId();
  const page = await ldapApi.searchStart(childSearchRequest(node.dn));
  if (!nodeIsCurrent(node, generation, connectionId)) {
    cancelSearch(page.searchId, connectionId);
    return false;
  }
  const session: ChildSearchSession = { searchId: page.searchId, connectionId, hasMore: page.hasMore };
  applyPage(node, session, page);
  return true;
}

async function loadRoot() {
  resetTreeSessions();
  if (!hasBaseDn.value || props.disabled) return;
  const generation = treeGeneration;
  loadingRoot.value = true;
  treeError.value = "";
  treeErrorRaw.value = "";
  try {
    const node = makeNode(props.baseDn.trim());
    node.loading = true;
    rootNode.value = node;
    if (await startChildren(node, generation)) node.expanded = true;
  } catch (cause) {
    if (generation !== treeGeneration) return;
    rootNode.value = undefined;
    const raw = cause instanceof Error ? cause.message : String(cause);
    treeError.value = friendlyLdapError(raw);
    treeErrorRaw.value = treeError.value === raw ? "" : raw;
  } finally {
    if (generation === treeGeneration) {
      loadingRoot.value = false;
      if (rootNode.value) rootNode.value.loading = false;
    }
  }
}

async function toggleNode(node: DnTreeNode) {
  if (props.disabled) return;
  closeContextMenu();
  selectedDn.value = node.dn;
  emit("select", node.dn);
  // 加载中忽略重复点击（同一节点并发去重）；已加载节点直接折叠/展开。
  if (node.loading) return;
  if (!node.expanded && !node.loaded) {
    const generation = treeGeneration;
    node.loading = true;
    try {
      if (!(await startChildren(node, generation))) return;
      // 本次懒展开成功：清除上一次失败的错误横幅（节点保持折叠，可重试）。
      treeError.value = "";
      treeErrorRaw.value = "";
    } catch (cause) {
      // 懒展开失败不清空树：错误以横幅显示，节点保持未加载状态，
      // 再次点击即重试（根加载失败才整树替换为错误态）。
      const raw = cause instanceof Error ? cause.message : String(cause);
      treeError.value = friendlyLdapError(raw);
      treeErrorRaw.value = treeError.value === raw ? "" : raw;
      return;
    } finally {
      if (nodeIsCurrent(node, generation, currentConnectionId())) node.loading = false;
    }
  }
  node.expanded = !node.expanded;
}

function selectNode(node: DnTreeNode) {
  closeContextMenu();
  selectedDn.value = node.dn;
  emit("select", node.dn);
}

// Continue the original LDAP cursor.  Re-running a one-level search with a
// larger sizeLimit can duplicate work and skip/duplicate DNs while a directory
// changes; this never uses an offset or re-query.
async function loadMore(node: DnTreeNode) {
  if (props.disabled || node.loading) return;
  const session = childSessions.get(nodeSessionKey(node));
  if (!session || !session.hasMore) {
    // Do not quietly mark a partial node as complete if the server session was
    // lost.  The visible `+` badge remains and the user can refresh explicitly.
    treeError.value = "The child search session expired; refresh this branch to continue.";
    treeErrorRaw.value = "";
    return;
  }
  const generation = treeGeneration;
  node.loading = true;
  try {
    const page = await ldapApi.searchNext(session.searchId, session.connectionId || undefined);
    if (!nodeIsCurrent(node, generation, session.connectionId) || childSessions.get(nodeSessionKey(node)) !== session) return;
    applyPage(node, session, page);
    treeError.value = "";
    treeErrorRaw.value = "";
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    treeError.value = friendlyLdapError(raw);
    treeErrorRaw.value = treeError.value === raw ? "" : raw;
  } finally {
    if (nodeIsCurrent(node, generation, session.connectionId)) node.loading = false;
  }
}

// -- keyword remote filter ---------------------------------------------------

function clearFilter() {
  window.clearTimeout(filterTimer);
  filterSequence += 1;
  filterKeyword.value = "";
  filterLoading.value = false;
  filterError.value = "";
  filterErrorRaw.value = "";
  filterResults.value = [];
}

// Refresh the visible view: while filtering, retry that query with its keyword intact.
function refresh() {
  window.clearTimeout(filterTimer);
  return hasFilter.value ? runFilter() : loadRoot();
}

async function runFilter() {
  const keyword = filterKeyword.value.trim();
  const seq = ++filterSequence;
  filterError.value = "";
  if (!keyword || !hasBaseDn.value || props.disabled) {
    filterLoading.value = false;
    filterResults.value = [];
    return;
  }
  filterLoading.value = true;
  try {
    const result = await ldapApi.search({
      baseDn: props.baseDn.trim(),
      filter: buildTreeKeywordFilter(keyword),
      scope: "sub",
      attributes: FILTER_ATTRIBUTES,
      sizeLimit: TREE_FILTER_LIMIT,
      pageSize: TREE_FILTER_LIMIT,
      derefAliases: "never",
    });
    if (seq !== filterSequence) return;
    filterResults.value = result.entries;
  } catch (cause) {
    if (seq !== filterSequence) return;
    filterResults.value = [];
    // 树内过滤错误同样走友好映射；原始串在 title 悬停可见。
    const raw = cause instanceof Error ? cause.message : String(cause);
    filterError.value = friendlyLdapError(raw);
    filterErrorRaw.value = filterError.value === raw ? "" : raw;
  } finally {
    if (seq === filterSequence) filterLoading.value = false;
  }
}

function onFilterInput() {
  window.clearTimeout(filterTimer);
  if (!filterKeyword.value.trim()) {
    clearFilter();
    return;
  }
  // Invalidate the previous query immediately, including the debounce interval.
  filterSequence += 1;
  filterLoading.value = true;
  filterError.value = "";
  filterTimer = window.setTimeout(() => void runFilter(), 300);
}

// -- context menu ------------------------------------------------------------

const contextMenuEl = ref<HTMLElement>();
let contextMenuTrigger: HTMLElement | null = null;

function openContextMenu(event: MouseEvent, dn: string) {
  contextMenuTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  contextMenu.value = { x: event.clientX, y: event.clientY, dn };
  // 渲染后按实际菜单尺寸夹回视口（右缘/底缘右键不裁切），焦点进菜单容器
  // 以便键盘操作（↑/↓ 移项、Esc 关闭）。
  void nextTick(() => {
    const menu = contextMenuEl.value;
    const state = contextMenu.value;
    if (!menu || !state) return;
    const rect = menu.getBoundingClientRect();
    state.x = Math.max(4, Math.min(state.x, window.innerWidth - rect.width - 4));
    state.y = Math.max(4, Math.min(state.y, window.innerHeight - rect.height - 4));
    menu.focus({ preventScroll: true });
  });
}

function closeContextMenu() {
  contextMenu.value = undefined;
}

function onMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    const restore = contextMenuTrigger;
    closeContextMenu();
    restore?.focus({ preventScroll: true });
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = Array.from(contextMenuEl.value?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[nextFocusIndex(items.length, index, event.key === "ArrowUp")]?.focus({ preventScroll: true });
}

// Navigate the full row model, scrolling an offscreen target into the DOM
// before focusing it. TreeBranch handles expansion/collapse locally.
async function onTreeKeydown(event: KeyboardEvent) {
  if (props.disabled || !["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const container = event.currentTarget as HTMLElement | null;
  const current = (event.target as HTMLElement).closest<HTMLElement>(".tree-node");
  if (!container || !current) return;
  const index = Number(current.dataset.treeIndex);
  const rows = treeRows.value;
  let target = nextTreeFocusIndex(hasFilter.value ? sortedFilterResults.value.length : rows.length, index, event.key);
  if (!hasFilter.value && rows[index]) {
    const { node, depth } = rows[index];
    if (event.key === "ArrowRight" && node.expanded && node.children.length > 0) target = index + 1;
    else if (event.key === "ArrowLeft") {
      for (let parent = index - 1; parent >= 0; parent--) {
        if (rows[parent].depth < depth) {
          target = parent;
          break;
        }
      }
    }
  }
  if (target < 0) return;
  event.preventDefault();
  visibleList.value?.scrollToIndex(target);
  await nextTick();
  container.querySelector<HTMLElement>(`.tree-node[data-tree-index="${target}"]`)?.focus({ preventScroll: true });
}

type ContextMenuItem = { action: string; label: string; icon: typeof Search; write?: boolean; danger?: boolean };
const contextMenuItems: ContextMenuItem[] = [
  { action: "search", label: "tree.searchHere", icon: Search },
  { action: "view", label: "tree.viewEntry", icon: Eye },
  { action: "members", label: "associations.members", icon: Users },
  { action: "add", label: "tree.addEntry", icon: Plus, write: true },
  { action: "copyEntry", label: "tree.copyEntry", icon: Copy, write: true },
  { action: "rename", label: "tree.renameEntry", icon: Pencil, write: true },
  { action: "delete", label: "tree.deleteEntry", icon: Trash2, write: true, danger: true },
  { action: "export", label: "tree.exportSubtree", icon: Download },
  { action: "copy", label: "copyDn", icon: Clipboard },
] as const;

function menuAction(action: string) {
  const dn = contextMenu.value?.dn;
  closeContextMenu();
  if (!dn) return;
  if (action === "search") emit("searchHere", dn);
  else if (action === "view") emit("view", dn);
  else if (action === "members") emit("members", dn);
  else if (action === "add") emit("add", dn);
  else if (action === "copyEntry") emit("copyEntry", dn);
  else if (action === "rename") emit("rename", dn);
  else if (action === "delete") emit("remove", dn);
  else if (action === "export") emit("export", dn);
  else if (action === "copy") emit("copyDn", dn);
}

watch(
  [() => props.baseDn, () => props.connectionId],
  () => {
    clearFilter();
    void loadRoot();
  },
);

watch(
  () => props.disabled,
  (next) => {
    if (next) {
      clearFilter();
      resetTreeSessions();
    }
  },
);

defineExpose({
  refresh,
  /** After writes, drop the cached children of `dn` (or reload everything). */
  invalidate(dn?: string) {
    if (!dn) {
      void loadRoot();
      return;
    }
    const walk = (node?: DnTreeNode): boolean => {
      if (!node) return false;
      if (node.dn === dn) {
        releaseNodeSessions(node);
        node.loaded = false;
        node.expanded = false;
        node.truncated = false;
        node.children = [];
        return true;
      }
      return node.children.some((child) => walk(child));
    };
    if (!walk(rootNode.value)) void loadRoot();
  },
});

function onMountedCleanup() {
  window.clearTimeout(filterTimer);
  filterSequence += 1;
  resetTreeSessions();
  document.removeEventListener("click", closeContextMenu);
}

window.setTimeout(() => document.addEventListener("click", closeContextMenu), 0);
onBeforeUnmount(onMountedCleanup);
</script>

<template>
  <section class="tree-pane" :class="{ 'is-resizing': resizing }" :style="{ '--tree-pane-width': `${paneWidth}px` }">
    <header class="panel-header">
      <span class="panel-title"><Search class="icon-neutral" aria-hidden="true" />{{ t("tree.title") }}</span>
      <span class="actions">
        <button class="icon-button" :title="t('refresh')" :aria-label="t('refresh')" :disabled="disabled || !hasBaseDn || (hasFilter ? filterLoading : loadingRoot)" @click.stop="refresh">
          <RefreshCw :class="{ spinning: hasFilter ? filterLoading : loadingRoot }" aria-hidden="true" />
        </button>
      </span>
    </header>
    <div class="tree-filter">
      <input
        v-model="filterKeyword"
        type="text"
        :placeholder="t('tree.filterPlaceholder')"
        :aria-label="t('tree.filterPlaceholder')"
        :disabled="disabled || !hasBaseDn"
        @input="onFilterInput"
        @keydown.esc="clearFilter"
      />
      <!-- 过滤激活时左栏切换为匹配列表：给显式还原入口，避免"树不见了" -->
      <button v-if="hasFilter" class="icon-button" :title="t('tree.clearFilter')" :aria-label="t('tree.clearFilter')" @click.stop="clearFilter">
        <X aria-hidden="true" />
      </button>
    </div>
    <div class="tree-rows" role="tree" :aria-label="t('tree.title')" :aria-busy="hasFilter ? filterLoading : loadingRoot" @click="closeContextMenu" @keydown="onTreeKeydown">
      <div v-if="!hasBaseDn" class="tree-state" role="status">{{ t("tree.missingBaseDn") }}</div>
      <template v-else-if="hasFilter">
        <div v-if="filterLoading" class="tree-state" role="status">{{ t("tree.loading") }}</div>
        <div v-else-if="filterError" class="tree-error" role="alert">
          <span :title="filterErrorRaw || filterError">{{ filterError }}</span>
          <button type="button" class="toolbar-button" :disabled="disabled" @click.stop="refresh">{{ t("tree.retry") }}</button>
        </div>
        <div v-else-if="filterResults.length === 0" class="tree-state" role="status">{{ t("tree.filterNoMatch", { keyword: filterKeyword.trim() }) }}</div>
        <template v-else>
          <VirtualList ref="visibleList" :items="sortedFilterResults" :row-height="TREE_ROW_HEIGHT" :reset-key="filterKeyword" class="tree-vlist">
            <template #default="{ item, index }">
              <button class="tree-node" :data-tree-index="index" role="treeitem" aria-level="1" :aria-selected="selectedDn === item.dn" :title="item.dn" :disabled="disabled" @click.stop="selectNode(makeNode(item.dn))" @dblclick.stop="emit('view', item.dn)" @contextmenu.prevent.stop="openContextMenu($event, item.dn)">
                <span class="tree-row" :class="{ selected: selectedDn === item.dn }">
                  <span class="tree-label">
                    <TreeNodeIcon :dn="item.dn" />
                    <span class="tree-name">{{ nodeLabel(item.dn) }}</span>
                  </span>
                </span>
              </button>
            </template>
          </VirtualList>
          <!-- 命中数达到单次抓取上限：可能有更多，可见化提示而不是静默截断 -->
          <div v-if="filterResults.length >= TREE_FILTER_LIMIT" class="tree-more-hint">
            {{ t("tree.filterTruncated", { limit: TREE_FILTER_LIMIT }) }}
          </div>
        </template>
      </template>
      <template v-else>
        <div v-if="loadingRoot" class="tree-state" role="status">{{ t("tree.loading") }}</div>
        <template v-else>
          <!-- 懒展开失败：错误横幅与树并存，不吞掉已加载的树 -->
          <div v-if="treeError" class="tree-error" role="alert" :title="treeErrorRaw || treeError">{{ treeError }}</div>
          <div v-if="!rootNode && !treeError" class="tree-state" role="status">{{ t("tree.empty") }}</div>
          <VirtualList
            v-else-if="rootNode"
            ref="visibleList"
            :items="treeRows"
            :row-height="TREE_ROW_HEIGHT"
            :reset-key="props.baseDn"
            class="tree-vlist"
          >
            <template #default="{ item, index }">
              <TreeBranch
                :data-tree-index="index"
                :node="item.node"
                :depth="item.depth"
                :selected-dn="selectedDn"
                :base-dn="props.baseDn"
                :disabled="disabled"
                @toggle="toggleNode"
                @select="selectNode"
                @menu="openContextMenu"
                @load-more="loadMore"
              />
            </template>
          </VirtualList>
        </template>
      </template>
    </div>
    <Teleport to="body">
      <div
        v-if="contextMenu"
        ref="contextMenuEl"
        class="context-menu"
        role="menu"
        tabindex="-1"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @click.stop
        @keydown="onMenuKeydown"
      >
        <template v-for="(item, index) in contextMenuItems" :key="item.action">
          <hr v-if="index === 7" />
          <button
            role="menuitem"
            :disabled="item.write && !canWrite"
            :class="{ danger: item.danger }"
            @click="menuAction(item.action)"
          >
            <component :is="item.icon" class="context-menu-item-icon" aria-hidden="true" />
            <span>{{ t(item.label) }}</span>
          </button>
        </template>
      </div>
    </Teleport>
    <!-- 右缘拖宽把手：pointer capture 拖拽调宽，双击重置默认宽 -->
    <div
      class="tree-resizer"
      :class="{ active: resizing }"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="onResizeStart"
      @pointermove="onResizeMove"
      @pointerup="onResizeEnd"
      @pointercancel="onResizeEnd"
      @dblclick="onResizeReset"
    />
  </section>
</template>
