<script setup lang="ts">
// DN 树：scope=one 懒展开 + 关键字远程子树过滤 + 右键菜单。
// 交互语义对照 tiny-rdm LdapConsolePage 的树区块（fetchTreeChildren /
// buildTreeKeywordFilter / searchTreeFilterRemote），组件按 DBX 插件形态重实现。
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Clipboard, Copy, Download, Eye, GitCompare, Pencil, Plus, RefreshCw, Search, Star, Trash2, Users, X } from "@lucide/vue";
import { getLdapConnectionId, ldapApi, type LdapDerefAliases, type LdapEntry, type LdapSearchPage, type LdapSearchSessionResult } from "../lib/api";
import { buildTreeKeywordFilter } from "../lib/ldapFilter";
import { friendlyLdapError } from "../lib/ldapErrors";
import { splitFirstDnRdn } from "../lib/dn";
import { dnPathChain } from "../lib/bookmarks";
import { TREE_WIDTH_KEY, pluginStore } from "../lib/pluginStore";
import { nextFocusIndex } from "../lib/modal";
import { t } from "../lib/i18n";
import { canExpandDnTreeNode, compareDnByLabel, compareDnForTree, flattenDnTree, nextTreeFocusIndex, objectClassValues, TREE_FETCH_PAGE, type DnTreeNode } from "../lib/dnTree";
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
  (e: "addBookmark", dn: string): void;
  (e: "compare", dn: string): void;
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

// -- 侧栏宽度（右缘 resizer 拖拽，pluginStore 记忆，双击重置默认宽）----------
// 通道降级见 shared/frontend/pluginStorage.ts（宿主 host.storage → guarded
// localStorage → 内存）；无存储通道时仅内存态。数值口径与 kafka TopicTree 同族。

const TREE_WIDTH_DEFAULT = 280;
const TREE_WIDTH_MIN = 200;
const TREE_WIDTH_MAX = 480;

function readStoredWidth(): number {
  try {
    const parsed = Number.parseInt(pluginStore.getItem(TREE_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(parsed) ? Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, parsed)) : TREE_WIDTH_DEFAULT;
  } catch {
    return TREE_WIDTH_DEFAULT;
  }
}

function persistWidth(value: number) {
  try {
    pluginStore.setItem(TREE_WIDTH_KEY, String(value));
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

function makeNode(dn: string, objectClass: string[] = []): DnTreeNode {
  return { dn, label: nodeLabel(dn), objectClass, expanded: false, loaded: false, loading: false, children: [] };
}

function currentConnectionId(): string {
  return props.connectionId || getLdapConnectionId();
}

// -- 树浏览解引用（GAP §1「别名处理」P2）---------------------------------------
// 子节点列举（ldap/search/start，scope=one）的 derefAliases 选项；缺省 never
// 与历史行为逐字节一致（零配置无行为变化）。切换后整树按新解引用重建——
// 已展开节点的游标/子列表都是旧语义的产物，混排会造成父子关系错乱。
const treeDerefAliases = ref<LdapDerefAliases>("never");

const treeDerefOptions = computed(() => [
  { value: "never" as LdapDerefAliases, label: t("search.derefNever") },
  { value: "searching" as LdapDerefAliases, label: t("search.derefSearching") },
  { value: "finding" as LdapDerefAliases, label: t("search.derefFinding") },
  { value: "always" as LdapDerefAliases, label: t("search.derefAlways") },
]);

function onTreeDerefChange() {
  void refresh();
}

function nodeSessionKey(node: Pick<DnTreeNode, "dn">): string {
  return node.dn.toLowerCase();
}

function nodeIsCurrent(generation: number, connectionId: string): boolean {
  // 节点级 O(1) 校验（审计 K-6）：整树替换只有 loadRoot 一条路径，且它第一步
  // 就 resetTreeSessions 自增 treeGeneration（两者同步无 await 间隔）；invalidate
  // 不摘除节点本身。因此"代数与连接均未变 ⇒ 发起请求的节点仍在当前树内"，
  // 原先的全树 DFS 属于冗余 O(N) 遍历，去掉后行为等价。
  return generation === treeGeneration && connectionId === currentConnectionId();
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

function appendChildren(node: DnTreeNode, entries: LdapSearchPage["entries"]): DnTreeNode[] {
  // LDAP paged-results is a continuation, not an offset.  Keep existing node
  // objects so descendants that the user has expanded remain expanded, then
  // add only genuinely new DNs.  Re-sorting affects display order only.
  // 返回本次真正新建的节点（revealDn 的临时 dn 索引据此增量增补）。
  const existing = new Set(node.children.map((child) => child.dn.toLowerCase()));
  const before = node.children.length;
  for (const entry of entries) {
    const dn = entry.dn.trim();
    const key = dn.toLowerCase();
    if (!dn || key === node.dn.toLowerCase() || existing.has(key)) continue;
    existing.add(key);
    node.children.push(makeNode(dn, objectClassValues(entry.attributes)));
  }
  // 新增节点必须从响应式数组读回再外传：makeNode 产物是 raw 对象，直接返回
  // 会让 revealDn 的临时 dn 索引持有 raw 引用，后续对它写 expanded 等属性
  // 绕过 proxy，不触发视图更新（截断续载定位会"命中但树不展开"）。
  const added = node.children.slice(before);
  node.children.sort((left, right) => compareDnForTree(left.dn, right.dn));
  return added;
}

function applyPage(node: DnTreeNode, session: ChildSearchSession, page: LdapSearchPage): DnTreeNode[] {
  const added = appendChildren(node, page.entries);
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
  return added;
}

function childSearchRequest(dn: string) {
  return {
    baseDn: dn,
    filter: "(objectClass=*)",
    scope: "one" as const,
    attributes: TREE_ATTRIBUTES,
    pageSize: TREE_FETCH_PAGE,
    derefAliases: treeDerefAliases.value,
  };
}

/** Starts one stable LDAP Paged Results cursor and applies its first page. */
async function startChildren(node: DnTreeNode, generation: number): Promise<boolean> {
  const connectionId = currentConnectionId();
  const page = await ldapApi.searchStart(childSearchRequest(node.dn));
  if (!nodeIsCurrent(generation, connectionId)) {
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
  if (props.disabled || !canExpandDnTreeNode(node)) return;
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
      if (nodeIsCurrent(generation, currentConnectionId())) node.loading = false;
    }
  }
  node.expanded = !node.expanded;
}

function selectNode(node: DnTreeNode) {
  closeContextMenu();
  selectedDn.value = node.dn;
  emit("select", node.dn);
}

function viewNode(node: DnTreeNode) {
  emit("view", node.dn);
}

// Continue the original LDAP cursor.  Re-running a one-level search with a
// larger sizeLimit can duplicate work and skip/duplicate DNs while a directory
// changes; this never uses an offset or re-query.  单页续载核心抽为下方
// continueOnePage（与 revealDn 静默定位共用），此处只保留用户可见的反馈层。
async function loadMore(node: DnTreeNode) {
  if (props.disabled || node.loading) return;
  if (!childSessions.get(nodeSessionKey(node))?.hasMore) {
    // Do not quietly mark a partial node as complete if the server session was
    // lost.  The visible `+` badge remains and the user can refresh explicitly.
    treeError.value = "The child search session expired; refresh this branch to continue.";
    treeErrorRaw.value = "";
    return;
  }
  const generation = treeGeneration;
  node.loading = true;
  try {
    if (!(await continueOnePage(node, generation))) return;
    treeError.value = "";
    treeErrorRaw.value = "";
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    treeError.value = friendlyLdapError(raw);
    treeErrorRaw.value = treeError.value === raw ? "" : raw;
  } finally {
    if (nodeIsCurrent(generation, currentConnectionId())) node.loading = false;
  }
}

// -- 树内定位（F8 revealDn）---------------------------------------------------
// 从 baseDn 沿 DN 路径逐级展开（复用懒展开 startChildren 与截断续载游标），
// 每级 children 加载完成后再进下一级；最后滚动到目标行并置为现有选中态。
// 任何一级找不到/加载失败返回 false，不抛错。

// 每级截断续载的页数上限（500/页 → 单级最多探 1 万条）：防服务器游标异常
// 一直 hasMore 导致死循环。
const REVEAL_MAX_PAGES = 20;

function findChildByDn(node: DnTreeNode, dn: string): DnTreeNode | undefined {
  const key = dn.toLowerCase();
  return node.children.find((child) => child.dn.toLowerCase() === key);
}

/**
 * 单页续载共享核心（loadMore 与 revealDn 同一"续载一页"语义）：读取节点现有
 * 游标的下一页并落树。成功返回本页新增节点（revealDn 用于增量索引，可能为
 * 空数组）；游标丢失/耗尽/连接换代返回 undefined。不抛错也不动错误横幅——
 * 横幅与 loading 属 UI 反馈，由调用方按场景补充（loadMore 给用户横幅，
 * revealDn 静默失败），searchNext 的异常原样上抛交调用方处置。
 */
async function continueOnePage(node: DnTreeNode, generation: number): Promise<DnTreeNode[] | undefined> {
  const session = childSessions.get(nodeSessionKey(node));
  if (!session || !session.hasMore) return undefined;
  const page = await ldapApi.searchNext(session.searchId, session.connectionId || undefined);
  if (!nodeIsCurrent(generation, session.connectionId) || childSessions.get(nodeSessionKey(node)) !== session) return undefined;
  return applyPage(node, session, page);
}

/** 确保节点 children 已加载（照 toggleNode 的懒展开路径，但不动选中态/错误横幅）。 */
async function ensureChildrenLoaded(node: DnTreeNode, generation: number): Promise<boolean> {
  if (node.loaded) return true;
  node.loading = true;
  try {
    return await startChildren(node, generation);
  } catch {
    return false;
  } finally {
    if (nodeIsCurrent(generation, currentConnectionId())) node.loading = false;
  }
}

/**
 * 定位并高亮目标 DN：逐级展开祖先链（目标不在首 500 条时用截断续载游标
 * 继续取），成功后滚动到目标行并高亮（仅置现有选中态，不发 select——是否
 * 连带读取条目详情由调用方决定）。
 */
async function revealDn(dn: string): Promise<boolean> {
  if (props.disabled) return false;
  const chain = dnPathChain(dn, props.baseDn);
  if (chain.length === 0) return false;
  // 过滤视图会整体替换树本体：定位前先还原树视图。
  if (hasFilter.value) clearFilter();
  if (!rootNode.value) await loadRoot();
  if (!rootNode.value) return false;
  const generation = treeGeneration;
  try {
    let current = rootNode.value;
    for (let level = 1; level < chain.length; level++) {
      // 目标可能不在已载页内：命中截断时用现有游标续载，每级最多 20 页。
      let node = findChildByDn(current, chain[level]);
      // 续载专用临时索引（dn 小写 → 节点）：目标需跨页续载时避免每页对已载
      // 子级做全量线性扫（500/页 × 20 页的万级续载累计 O(n²)）。索引只在
      // 进入续载循环时建一次，其后每页只增量增补新增节点并 O(1) 命中；
      // 离开本层循环即弃（下一层展开时按需重建），不影响 findChildByDn 的
      // 其他线性调用点。
      let index: Map<string, DnTreeNode> | undefined;
      for (let pages = 0; !node; pages++) {
        if (pages >= REVEAL_MAX_PAGES) return false;
        index ??= new Map(current.children.map((child) => [child.dn.toLowerCase(), child] as const));
        const added = await continueOnePage(current, generation);
        if (!added) return false;
        for (const child of added) index.set(child.dn.toLowerCase(), child);
        node = index.get(chain[level].toLowerCase());
      }
      current = node;
      // 进下一级前先保证该级 children 已加载并展开可见。
      if (level < chain.length - 1) {
        if (!(await ensureChildrenLoaded(current, generation))) return false;
        current.expanded = true;
      }
    }
    // 滚动到目标行并高亮（treeRows 为当前可见行的扁平投影）。
    const index = treeRows.value.findIndex((row) => row.node.dn.toLowerCase() === current.dn.toLowerCase());
    selectedDn.value = current.dn;
    if (index >= 0) {
      // scrollToIndex 用可选调用：VirtualList 换成无该方法的测试桩时不至于误伤。
      visibleList.value?.scrollToIndex?.(index);
      await nextTick();
    }
    return true;
  } catch {
    return false;
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

/* 右键菜单（对标 ADS 分组）：查看/导航 → 条目编辑 → 数据（刷新/导出）→
   剪贴板/收藏；sep 渲染为分隔线。 */
type ContextMenuItem = { action: string; label: string; icon: typeof Search; write?: boolean; danger?: boolean; sep?: boolean };
const contextMenuItems: ContextMenuItem[] = [
  { action: "view", label: "tree.viewEntry", icon: Eye },
  { action: "search", label: "tree.searchHere", icon: Search },
  { action: "members", label: "associations.members", icon: Users },
  { action: "compare", label: "compare.title", icon: GitCompare },
  { action: "sep1", label: "", icon: Search, sep: true },
  { action: "add", label: "tree.addEntry", icon: Plus, write: true },
  { action: "copyEntry", label: "tree.copyEntry", icon: Copy, write: true },
  { action: "rename", label: "tree.renameEntry", icon: Pencil, write: true },
  { action: "delete", label: "tree.deleteEntry", icon: Trash2, write: true, danger: true },
  { action: "sep2", label: "", icon: Search, sep: true },
  { action: "reloadNode", label: "tree.reloadNode", icon: RefreshCw },
  { action: "export", label: "tree.exportSubtree", icon: Download },
  { action: "sep3", label: "", icon: Search, sep: true },
  { action: "copy", label: "copyDn", icon: Clipboard },
  { action: "bookmark", label: "bookmark.add", icon: Star },
];

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
  else if (action === "bookmark") emit("addBookmark", dn);
  else if (action === "compare") emit("compare", dn);
  else if (action === "reloadNode") void reloadNodeChildren(dn);
}

/** 右键「刷新此节点」：丢子级缓存并按原展开态立即重载（折叠节点只丢缓存，
 *  下次展开时走既有懒加载）。失败保持折叠未加载态，再次展开即重试
 *  （同 toggleNode 口径）。 */
async function reloadNodeChildren(dn: string) {
  const find = (node?: DnTreeNode): DnTreeNode | undefined => {
    if (!node) return undefined;
    if (node.dn === dn) return node;
    for (const child of node.children) {
      const found = find(child);
      if (found) return found;
    }
    return undefined;
  };
  const node = find(rootNode.value);
  if (!node || node.loading) return;
  const wasExpanded = node.expanded;
  releaseNodeSessions(node);
  node.loaded = false;
  node.expanded = false;
  node.truncated = false;
  node.children = [];
  if (!wasExpanded || props.disabled) return;
  const generation = treeGeneration;
  node.loading = true;
  try {
    if (await startChildren(node, generation)) node.expanded = true;
  } catch {
    // 保持折叠未加载态：错误态与懒展开失败共用，重试路径一致。
  } finally {
    if (generation === treeGeneration) node.loading = false;
  }
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
  /** 树内定位（F8）：逐级展开到目标 DN 并高亮；失败返回 false，不抛错。 */
  revealDn,
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

// 文档级点击关闭监听延后一个 tick 注册，避免注册瞬间的点击立即触发关闭；
// timer 必须保存并在卸载时清除（审计 K-8），否则挂载同 tick 卸载时监听器
// 会随回调"复活"泄漏。
let menuListenerTimer = 0;

function onMountedCleanup() {
  window.clearTimeout(filterTimer);
  window.clearTimeout(menuListenerTimer);
  filterSequence += 1;
  resetTreeSessions();
  document.removeEventListener("click", closeContextMenu);
}

menuListenerTimer = window.setTimeout(() => document.addEventListener("click", closeContextMenu), 0);
onBeforeUnmount(onMountedCleanup);
</script>

<template>
  <section class="tree-pane" :class="{ 'is-resizing': resizing }" :style="{ '--tree-pane-width': `${paneWidth}px` }">
    <header class="panel-header">
      <span class="panel-title"><Search class="icon-neutral" aria-hidden="true" />{{ t("tree.title") }}</span>
      <span class="actions">
        <select
          v-model="treeDerefAliases"
          class="deref-select"
          :aria-label="t('tree.deref')"
          :title="t('tree.deref')"
          :disabled="disabled || !hasBaseDn"
          @change.stop="onTreeDerefChange"
        >
          <option v-for="option in treeDerefOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
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
                    <TreeNodeIcon :dn="item.dn" :object-class="objectClassValues(item.attributes)" />
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
                @view="viewNode"
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
        <template v-for="(item, index) in contextMenuItems" :key="item.action || `sep${index}`">
          <hr v-if="item.sep" />
          <button
            v-else
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

<style scoped>
/* 树工具栏解引用下拉（GAP §1）：紧凑条形态贴合 panel-header 34px 高度，
   选项文案复用 search.deref* 既有词条（never/searching/finding/always）。 */
.deref-select {
  height: 24px;
  min-width: 0;
  max-width: 92px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 11px;
  outline: none;
  background: color-mix(in srgb, var(--background) 95%, var(--foreground));
  color: var(--foreground);
}
.deref-select:focus { border-color: color-mix(in srgb, var(--primary) 70%, var(--border)); }
.deref-select[disabled] { opacity: 0.42; }
</style>
