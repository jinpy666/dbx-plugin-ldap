<script setup lang="ts">
// LDAP 工作台外壳：布局 + 连接上下文（照 ssh-sftp App.vue 的宿主桥用法）。
// 连接生命周期由宿主驱动（connection/test|connect|disconnect），工作台只持有
// connectionId；所有 ldap/* 调用经 lib/api.ts 注入 connectionId。
// 领域会话拆分在 lib/ 组合式（搜索/条目详情/关联视图/最近条目/反馈），本文件
// 只做编排：宿主桥、弹窗开关、写操作事务。写操作后的详情缓存失效与结果表
// 重放统一由 lib/entryEvents 事件总线驱动（对标 ADS EventRegistry 的最小形态）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { DBX_POPOVER, resolveAppearance, type DbxPluginAppearanceInput } from "./lib/appearance";
import { isDbxPluginTheme, onHostThemeChange, themeToAppearance } from "./lib/hostTheme";
import { setWorkbenchLocale, t, workbenchLocale } from "./lib/i18n";
import { getLdapConnectionId, ldapApi, setLdapConnectionId, type LdapEntry, type LdapSearchRequest } from "./lib/api";
import { appendOpenTab } from "./lib/openTabs";
import { inferBaseDnFromProfile, pickBaseDnFromRootDse } from "./lib/baseDn";
import { joinRdnAndParent, splitFirstDnRdn } from "./lib/dn";
import { escapeLdapFilterValue } from "./lib/ldapFilter";
import { writeClipboardText } from "./lib/clipboard";
import { saveTextFile, type SaveTextOutcome } from "./lib/fileSave";
import { serializeEntriesToCsv, serializeEntriesToJson, serializeEntriesToLdifText } from "./lib/ldapExporter";
import { randomUUID } from "./lib/uuid";
import { connectionIdentityText, protocolBadge, serverBadgeLabel, toolbarTint } from "./lib/connectionIdentity";
import { useWorkbenchFeedback } from "./lib/useWorkbenchFeedback";
import { useSearchSession, type SearchFormModel } from "./lib/useSearchSession";
import { useEntryDetail } from "./lib/useEntryDetail";
import { useReferenceTabs } from "./lib/useReferenceTabs";
import { useRecentEntries } from "./lib/useRecentEntries";
import { emitEntryChanged, emitEntryDeleted, emitEntryMoved, onEntryEvent } from "./lib/entryEvents";
import { addBookmark, loadBookmarks, removeBookmark } from "./lib/bookmarks";
import DnTree from "./components/DnTree.vue";
import WorkbenchToolbar from "./components/WorkbenchToolbar.vue";
import SearchForm from "./components/SearchForm.vue";
import ResultTable from "./components/ResultTable.vue";
import EntryEditorDialog from "./components/EntryEditorDialog.vue";
import ImportEntryDialog from "./components/ImportEntryDialog.vue";
import DeleteEntryDialog from "./components/DeleteEntryDialog.vue";
import ModifyDnDialog from "./components/ModifyDnDialog.vue";
import BatchMoveDialog from "./components/BatchMoveDialog.vue";
import BatchModifyDialog from "./components/BatchModifyDialog.vue";
import CompareDialog from "./components/CompareDialog.vue";
import NewEntryWizard from "./components/NewEntryWizard.vue";
import SchemaPanel from "./components/SchemaPanel.vue";
import ConnectionsPanel from "./components/ConnectionsPanel.vue";
import RootDseDialog from "./components/RootDseDialog.vue";
import AuditFeedPanel from "./components/AuditFeedPanel.vue";
import { useLdapSchemaCache } from "./lib/schemaCache";
import { deriveDnValuedAttributes } from "./lib/dnAttributes";
import type { LdapSchema } from "./lib/newEntryTemplates";
import { parseAuditEvent, pushAuditItem, type AuditFeedItem } from "./lib/auditFeed";
import { setupTooltipLayer, teardownTooltipLayer } from "./lib/tooltip";
import { useUiIntent, type UiIntentOutcome, type UiIntentSummary } from "../../shared/frontend/uiIntent";

interface ConnectionSummary {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  color?: string;
  readOnly?: boolean;
  baseDn?: string;
  external_config?: Record<string, unknown>;
}

const hostContext = ref<Record<string, unknown>>({});
const appearance = ref(resolveAppearance());
const ready = ref(false);
const busy = ref(false);

const treeRef = ref<InstanceType<typeof DnTree>>();
const searchRef = ref<InstanceType<typeof SearchForm>>();

const baseDn = ref("");

// -- 即时反馈（横幅/通知/初始化错误） -------------------------------------------

const {
  notice,
  ldapError,
  ldapErrorDetail,
  initError,
  showNotice,
  showError,
  dismissError,
  clearBanner,
  dispose: disposeFeedback,
} = useWorkbenchFeedback();

// -- 连接上下文 ----------------------------------------------------------------

const connectionId = computed(() => String(hostContext.value.connectionId || ""));
const fallbackWorkbenchId = randomUUID();
const workbenchId = computed(() => String(hostContext.value.workbenchId || fallbackWorkbenchId));
const connection = computed<ConnectionSummary>(() => {
  const value = hostContext.value.connection;
  return value && typeof value === "object" ? (value as ConnectionSummary) : {};
});
// 写权限 = 宿主 context 未标记只读 且 后端策略层未开启只读门禁
// （ldap/connections/statuses 行的 readOnly：表单 read_only ∥ 宿主 read_only）。
const backendReadOnly = ref(false);
const canWrite = computed(() => !connection.value.readOnly && !backendReadOnly.value);

// 只读统一写守卫：所有工作台写入口（树新增/改名/删除、编辑器保存、导入提交、
// 批量删除/移动/修改）在调用前先过这里——UI 层各入口已禁用（DnTree 菜单、
// ResultTable 批量条、编辑器/向导/导入对话框），此处兜住快捷路径与状态翻转
// 竞态（弹窗开着时连接变只读）；后端 ensureLDAPWriteAllowed 是最终防线。
function guardWrite(): boolean {
  if (canWrite.value) return true;
  showNotice(t("editor.readonlyHint"));
  return false;
}

// 从连接状态表读取生效只读门禁；旧 sidecar 无 readOnly 字段时保持可写回退。
async function refreshBackendReadOnly() {
  try {
    const result = await ldapApi.connectionStatuses();
    const mine = (result.statuses || []).find((row) => row.connectionId === connectionId.value);
    backendReadOnly.value = mine?.readOnly === true;
  } catch {
    // 探测失败保持上次值（fail-sticky，审计 L-4）：瞬时抖动不应把已知的只读
    // 连接翻转为可写；首次探测失败维持初始 false，与旧 sidecar 无字段同语义。
  }
}
const contextBaseDn = computed(() => {
  const direct = connection.value.baseDn;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const external = connection.value.external_config;
  if (external && typeof external === "object") {
    const value = (external as Record<string, unknown>)["base_dn"];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
});
// 初始化失败（最常见：无连接上下文）时 identity 降级为占位，不再展示
// 看似就绪的完整连接身份（UI 扫描 P2-2：与"未就绪"提示自相矛盾）。
const identityText = computed(() => (initError.value ? t("connectionPlaceholder") : connectionIdentityText(connection.value, connectionId.value)));
const toolbarStyle = computed(() => toolbarTint(connection.value.color, appearance.value.colorScheme));

function applyAppearance(next?: DbxPluginAppearanceInput | null) {
  // 宿主可能缺字段（1.0 部分下发、1.1 theme 通道只带颜色令牌），按 DBX 规范色板补齐。
  const resolved = resolveAppearance(next);
  appearance.value = resolved;
  const root = document.documentElement;
  root.dataset.theme = resolved.colorScheme;
  root.style.colorScheme = resolved.colorScheme;
  root.style.setProperty("--background", resolved.colors.background);
  root.style.setProperty("--foreground", resolved.colors.foreground);
  root.style.setProperty("--muted", resolved.colors.muted);
  root.style.setProperty("--muted-foreground", resolved.colors.mutedForeground);
  root.style.setProperty("--accent", resolved.colors.accent);
  root.style.setProperty("--accent-foreground", resolved.colors.accentForeground);
  root.style.setProperty("--border", resolved.colors.border);
  root.style.setProperty("--destructive", resolved.colors.destructive);
  root.style.setProperty("--popover", DBX_POPOVER[resolved.colorScheme]);
  // 字体不在此内联回写：main.ts 安装的宿主令牌桥已把 --ui-font-family /
  // --mono-font-family 声明为宿主 --font-sans / --font-mono 的 var() 引用，
  // 内联样式会压过桥接样式，导致字体永远停留在插件默认栈。令牌缺失时
  // （Host API 1.0 / mock）桥自身的回退值与原默认一致，行为不变。
}

// -- 搜索会话（lib/useSearchSession） -------------------------------------------

// MCP intent 快照回报通道在 uiIntent 装配后才可用；领域组合式先建、
// 通过此可变绑定在装配后接通（回调只会在交互期触发）。
let reportSnapshot: (payload: Record<string, unknown>) => void = () => {};

const {
  searchModel,
  results,
  resultCount,
  resultTruncated,
  resultsComplete,
  searching,
  loadingMore,
  loadMoreError,
  loadMoreErrorDetail,
  searchError,
  searchErrorDetail,
  hasSearched,
  resultAtLimit,
  lastSizeLimit,
  runSearch,
  retrySearch,
  requestNextSearchPage,
  refreshAfterWrite,
  summarize,
  reset: resetSearchSession,
  dispose: disposeSearchSession,
} = useSearchSession({
  getConnectionId: () => connectionId.value,
  clearBanner,
  onSnapshot: (payload) => reportSnapshot(payload),
  onHistory: (model) => searchRef.value?.recordSearch?.(model),
});

// -- 条目详情 / 关联视图 / 最近条目（lib 组合式） ---------------------------------

// 关联视图打开时递增共享 token，使编辑器侧遗留 openEntry 兜底打开失效。
const dialogToken = { value: 0 };

const recentEntriesRecord = useRecentEntries();
const { recentEntries } = recentEntriesRecord;

// 条目关联视图的 schema 依赖（DN 值属性名集合 + MUST/SUP 元数据）：
// schema 缓存走 useLdapSchemaCache 共享视图（J-8：per-connection TTL，
// 与 wizard/面板/搜索共用同一次 ldap/schema 拉取）。
const dnAttributes = ref<string[]>([]);
const editorSchema = ref<LdapSchema>();
let dnAttributesReady = false;
const dnSchemaCache = useLdapSchemaCache();
async function ensureDnAttributes() {
  if (dnAttributesReady) return;
  const requestedConnection = connectionId.value;
  try {
    const payload = await dnSchemaCache.ensureLoaded(requestedConnection);
    if (requestedConnection !== connectionId.value) return;
    // deriveDnValuedAttributes 消费 raw RFC 4512 定义串：共享缓存透出的
    // rawAttributeTypes 已按「sidecar 原始串优先，mock/旧形状即 attributeTypes
    // 原文」归一（J-8 前由本处 loader 覆写 attributeNames 实现）。
    dnAttributes.value = deriveDnValuedAttributes(payload?.rawAttributeTypes ?? []);
    editorSchema.value = payload ?? undefined;
    dnAttributesReady = true;
  } catch {
    // schema 拉取失败静默降级；不置位 ready，下次打开编辑器可重试
    // （ensureLoaded 内部有 inFlight 去重与 TTL，不会并发重复请求）。
  }
}

const {
  editorOpen,
  editorEntry,
  editorParentDn,
  editorRequestedDn,
  editorLoading,
  editorLoadingMore,
  editorDeferredLoading,
  editorDeferredAttributes,
  editorLoadError,
  editorLoadErrorDetail,
  editorAddPrefill,
  editorInitialTab,
  openEntry,
  openEntryFromDialog,
  openCopyEntry,
  loadDeferredEditorAttributes,
  closeEditor: closeEditorSession,
  invalidate: invalidateEntryCache,
  clear: clearEntryCache,
  dispose: disposeEntrySession,
} = useEntryDetail({
  getConnectionId: () => connectionId.value,
  dialogToken,
  clearBanner,
  onBannerError: (cause) => showError(cause),
  onSnapshot: (payload) => reportSnapshot(payload),
  onRecent: (dn) => recentEntriesRecord.record(dn),
  onNotice: (message) => showNotice(message),
  getEditorSchema: () => editorSchema.value,
  ensureDnAttributes: () => void ensureDnAttributes(),
});

const {
  referenceOpen,
  referenceTabs,
  activeReferenceTabId,
  referenceEntry,
  referenceRequestedDn,
  referenceAttribute,
  referenceLoading,
  referenceLoadError,
  referenceLoadErrorDetail,
  openReferencedEntry,
  closeReference,
  closeReferenceTab,
  selectReferenceTab,
  closeActiveReference,
  retryReference,
  dispose: disposeReferenceTabs,
} = useReferenceTabs({
  dialogToken,
  onSnapshot: (payload) => reportSnapshot(payload),
  onRecent: (dn) => recentEntriesRecord.record(dn),
  ensureDnAttributes: () => void ensureDnAttributes(),
});

// 编辑器会话关闭 = 主条目 + 右侧引用一并收口（原 App.vue closeEditor 语义）。
function closeEditor() {
  closeReference();
  closeEditorSession();
}

// -- F5 条目事件总线：写操作后的缓存失效 + 结果表重放统一收口 ---------------------

// deleted/moved → 失效（含子树）并按受影响子树重放最近搜索；changed（保存）→
// 只失效详情缓存（树刷新与 reopen 属于保存流程自身的 UI 语义，留在事件发射处）。
// 批量写会同步连发 N 条事件：重放按 150ms 尾沿防抖合并为一次 runSearch（每 DN
// 只需命中任一受影响前缀即重放），避免批量删除 N 条触发 N 次搜索、撞上后端
// 并发会话上限；详情缓存失效仍逐事件即时生效，不参与防抖。
const ENTRY_REPLAY_DEBOUNCE_MS = 150;
let entryReplayTimer = 0;
let entryReplayConnectionId = "";
let entryReplayAffectedKeys: string[] = [];

function flushEntryReplay() {
  entryReplayTimer = 0;
  const affectedKeys = entryReplayAffectedKeys;
  const replayedConnection = entryReplayConnectionId;
  entryReplayAffectedKeys = [];
  entryReplayConnectionId = "";
  if (affectedKeys.length === 0 || replayedConnection !== connectionId.value) return;
  void refreshAfterWrite((dn) => {
    const key = dn.toLowerCase();
    return affectedKeys.some((affected) => key === affected || key.endsWith(`,${affected}`));
  });
}

const disposeEntryEventWire = onEntryEvent((event) => {
  if (event.connectionId !== connectionId.value) return;
  invalidateEntryCache(event.dn, event.descendants === true);
  if (event.kind === "moved" && event.previousDn) invalidateEntryCache(event.previousDn, event.descendants === true);
  // 工作集维护：deleted 剔除目标（含子树命中），moved 原位改名。
  const affects = (tab: string) => {
    const key = tab.toLowerCase();
    const base = (event.kind === "moved" && event.previousDn ? event.previousDn : event.dn).toLowerCase();
    return key === base || (event.descendants === true && key.endsWith(`,${base}`));
  };
  openTabs.value = openTabs.value.flatMap((tab) => {
    if (!affects(tab)) return [tab];
    if (event.kind === "moved") return [event.dn];
    return [];
  });
  if (event.kind === "changed") return;
  const affected = (event.kind === "moved" && event.previousDn ? event.previousDn : event.dn).toLowerCase();
  if (entryReplayConnectionId !== event.connectionId) {
    // 换连接的窗口（理论上已被上面的过滤拦截）丢弃残留批次，防跨连接串扰。
    entryReplayConnectionId = event.connectionId;
    entryReplayAffectedKeys = [];
  }
  if (!entryReplayAffectedKeys.includes(affected)) entryReplayAffectedKeys.push(affected);
  if (entryReplayTimer === 0) entryReplayTimer = window.setTimeout(flushEntryReplay, ENTRY_REPLAY_DEBOUNCE_MS);
});

// -- 审计事件流（ldap/audit → 最近操作面板）；横幅/通知仍保留作为即时反馈 -------

const auditItems = ref<AuditFeedItem[]>([]);
let auditSeq = 0;

// -- 弹窗与确认流（编排状态留在 App）---------------------------------------------

let dialogOpenToken = 0;
const deleteOpen = ref(false);
const deleteDn = ref("");
const deleteSubmitting = ref(false);
const modifyDnOpen = ref(false);
const modifyDnSource = ref("");
const modifyDnSubmitting = ref(false);
// 批量移动（结果表多选，ADS Batch Operations 单步版）：所选 DN 由 ResultTable
// 的 batchMove 事件带入；移动执行在 onBatchMoveConfirm，submitting 兼作防重入门闩。
const batchMoveOpen = ref(false);
const batchMoveDns = ref<string[]>([]);
const batchMoveSubmitting = ref(false);
// 批量修改（F6）：状态与批量移动同风格。
const batchModifyOpen = ref(false);
const batchModifyDns = ref<string[]>([]);
const batchModifySubmitting = ref(false);
// 书签（F7，localStorage 按连接隔离）与比较弹窗（F3）。
const bookmarks = ref<string[]>([]);
function reloadBookmarks() {
  bookmarks.value = loadBookmarks(connectionId.value);
}
const compareOpen = ref(false);
const compareDn = ref("");
const schemaOpen = ref(false);
// 服务器信息弹窗（F12）：对标 ADS RootDSEPropertyPage，namingContexts 可一键设为浏览基。
const rootDseOpen = ref(false);
// 条目多开工作集（F9，对标 ADS MultiTabEntryEditor 的最小形态）：页签 = 已打开
// 条目快速切换入口（内存态），脏态守卫在编辑器组件内（脏时 switchTab 不发出）。
// 顺序按打开次序稳定排列：激活已有页签不重排（点击跳动的根因即每次激活都把
// DN 插到最前），新开追加尾部，超限淘汰最早的——见 lib/openTabs。
const openTabs = ref<string[]>([]);
const tabDirty = ref(false);
const OPEN_TABS_MAX = 6;
watch([editorOpen, editorRequestedDn], ([open, dn]) => {
  tabDirty.value = false;
  if (open && dn) {
    openTabs.value = appendOpenTab(openTabs.value, dn, OPEN_TABS_MAX);
  }
});
function onSwitchTab(dn: string) {
  void openEntry(dn);
}
function onCloseTab(dn: string) {
  openTabs.value = openTabs.value.filter((item) => item !== dn);
  if (dn.toLowerCase() === editorRequestedDn.value.toLowerCase()) closeEditor();
}
// 条目导入弹窗（阶段4）：LDIF / PowerShell Format-List 粘贴或文件导入。
const importOpen = ref(false);
const connectionsOpen = ref(false);

// M6 N4：新建条目走模板向导（树「新增子条目」入口），schema 复用共享缓存
// 视图（J-8：与 SearchForm/SchemaPanel 同源，per-connection TTL 30min）。
const wizardOpen = ref(false);
const wizardParentDn = ref("");
const wizardSchemaCache = useLdapSchemaCache();
const wizardSchema = computed(() => ({ objectClassAttributes: wizardSchemaCache.objectClassAttributes.value }));

// -- MCP UI intent 通道（M1，shared/frontend/uiIntent 公共层） -----------------

const uiIntentHandlers = {
  focus: async (params: Record<string, unknown>): Promise<UiIntentOutcome> => {
    const panel = String(params.panel ?? "");
    if (panel === "schema") {
      schemaOpen.value = true;
      uiIntent.reportSnapshot({ panel: "schema" });
      return { status: "applied", summary: { panel } };
    }
    if (panel === "tree" || panel === "search") {
      // 主区常驻（树/搜索面板无独立开关）；关闭弹窗让目标面板可见。
      deleteOpen.value = false;
      modifyDnOpen.value = false;
      batchMoveOpen.value = false;
      wizardOpen.value = false;
      // 搜索面板默认折叠为快捷条：宿主点名聚焦时展开，字段必须可见可交互。
      if (panel === "search") searchRef.value?.expandSearch();
      return { status: "applied", summary: { panel } };
    }
    return { status: "rejected", reason: t("intent.unknownPanel") };
  },
  search: async (params: Record<string, unknown>): Promise<UiIntentOutcome> => {
    if (!searchRef.value || busy.value || searching.value) {
      return { status: "rejected", reason: "search form is not ready" };
    }
    const model = searchRef.value.applyIntentSearch(params);
    await runSearch(model);
    if (searchError.value) {
      return { status: "rejected", reason: searchError.value };
    }
    showNotice(t("intent.applied"));
    return { status: "applied", summary: summarize.value };
  },
  select: async (params: Record<string, unknown>): Promise<UiIntentOutcome> => {
    const dn = String(params.dn ?? "").trim();
    const row = results.value.find((entry) => entry.dn.toLowerCase() === dn.toLowerCase());
    if (!row) {
      return { status: "rejected", reason: t("intent.selectMissing") };
    }
    void openEntry(row.dn);
    return { status: "applied", summary: { count: 1, anchor: row.dn, rows: [{ dn: row.dn }] } };
  },
};

// intent 处理器引用 uiIntent.reportSnapshot（快照型 report），声明后装配。
const uiIntent = useUiIntent("ldap", uiIntentHandlers);
reportSnapshot = (payload) => uiIntent.reportSnapshot(payload);

const unsubscribeAppearance: Array<() => void> = [];
const unsubscribeLocale: Array<() => void> = [];
const unsubscribeContext: Array<() => void> = [];
const unsubscribeEvent: Array<() => void> = [];

// -- 树/搜索联动与结果表批量操作 -------------------------------------------------

function searchHere(dn: string) {
  // 右键「搜索此子树」直达：立即以该节点为 Base 执行子树搜索并在右侧结果表
  // 展示（此前只把搜索面板 base 指过去、不执行）。树根（baseDn）仍固定为
  // 连接 Base DN，树不重根（tiny-rdm 语义：树常驻、搜索联动）。
  searchRef.value?.runSubtreeAt(dn);
}

function selectEntry(dn: string) {
  // 点选节点只联动搜索面板 base（tiny-rdm 搜索框跟随选中节点语义），
  // 不取数、不动树根；打开编辑器由显式动作触发。
  searchRef.value?.applyBaseDn(dn);
}

// 树右键「成员」：立即以 (memberOf=<DN>) 在连接 Base 下子树搜索，
// 右侧结果表承接浏览（分页/排序/导出）；OpenLDAP 无 memberof overlay
// 时结果为空，组内成员仍可在条目编辑器「关联」页签直读 member 属性。
function searchMembersAt(dn: string) {
  searchRef.value?.runFilterAt(baseDn.value, `(memberOf=${escapeLdapFilterValue(dn)})`);
}

// 结果表批量删除（结果多选，ADS Batch Operations 单步版）：逐条非递归删除，
// 与确认文案一致——仍有子条目的条目会失败并计入 failed，不做半递归的意外删除。
// 成功条目经事件总线失效缓存并（防抖合并后）重放受影响的结果行。
async function onBatchDelete(dns: string[]) {
  if (dns.length === 0 || busy.value || !guardWrite()) return;
  clearBanner();
  // 连接守卫（审计 L-1）：循环中途切换连接就中止，剩余 DN 不再发往新连接；
  // 汇总通知按实际成功/失败数展示，用户可感知中途停止。
  const conn = connectionId.value;
  const failed = new Set<string>();
  const deleted: string[] = [];
  for (const dn of dns) {
    if (connectionId.value !== conn) break;
    try {
      await ldapApi.entryDelete(dn, false);
      emitEntryDeleted(conn, dn, true);
      deleted.push(dn);
    } catch {
      failed.add(dn);
    }
  }
  showNotice(t("result.batchResult", { ok: deleted.length, failed: failed.size }));
  if (deleted.length === 0) return;
  for (const parent of new Set(deleted.map((dn) => splitFirstDnRdn(dn).parentDn))) treeRef.value?.invalidate(parent);
}

// 批量移动入口（ResultTable 多选 → batchMove 事件，payload 与 batchDelete
// 同为条目顺序的原始大小写 DN）：空数组忽略，只负责打开确认框；真正的移动
// 在 onBatchMoveConfirm 执行，便于单测与防重入。
function onBatchMove(dns: string[]) {
  if (dns.length === 0 || busy.value || !guardWrite()) return;
  batchMoveDns.value = dns;
  batchMoveOpen.value = true;
}

// 批量修改（F6，ADS BatchOperationWizard modify 型的单步版）：ResultTable
// batchModify 事件 → 打开表单弹窗；执行在 onBatchModifyConfirm（submitting 兼作
// 防重入门闩）。逐条 entryModify 单变更（delete 时 values=[] 删整个属性），
// 单条失败计数不中断；成功条目经事件总线失效详情缓存（changed 不重放结果表——
// 被修改的行仍有效，双击可打开最新值）。
function onBatchModify(dns: string[]) {
  if (dns.length === 0 || busy.value || !guardWrite()) return;
  batchModifyDns.value = dns;
  batchModifyOpen.value = true;
}

async function onBatchModifyConfirm(payload: { operation: "add" | "replace" | "delete"; attribute: string; values: string[] }) {
  const dns = batchModifyDns.value;
  if (dns.length === 0 || batchModifySubmitting.value || !guardWrite()) return;
  batchModifySubmitting.value = true;
  clearBanner();
  // 连接守卫（审计 L-1）：循环中途切换连接就中止，剩余 DN 不再发往新连接；
  // 汇总通知按实际成功/失败数展示，用户可感知中途停止。
  const conn = connectionId.value;
  const failed = new Set<string>();
  const modified: string[] = [];
  for (const dn of dns) {
    if (connectionId.value !== conn) break;
    try {
      await ldapApi.entryModify(dn, [{ operation: payload.operation, attribute: payload.attribute, values: payload.values }]);
      emitEntryChanged(conn, dn);
      modified.push(dn);
    } catch {
      failed.add(dn);
    }
  }
  batchModifySubmitting.value = false;
  batchModifyOpen.value = false;
  showNotice(t("batchModify.result", { ok: modified.length, failed: failed.size }));
}

// 书签（F7）：树右键加入；工具栏下拉跳转（revealDn 逐级展开定位）与移除。
function onAddBookmark(dn: string) {
  if (addBookmark(connectionId.value, dn)) {
    reloadBookmarks();
    showNotice(t("bookmark.added"));
  }
}

function onRemoveBookmark(dn: string) {
  removeBookmark(connectionId.value, dn);
  reloadBookmarks();
  showNotice(t("bookmark.removed"));
}

async function onOpenBookmark(dn: string) {
  const revealed = (await treeRef.value?.revealDn(dn)) === true;
  if (!revealed) {
    showNotice(t("goto.notFound"));
    return;
  }
  void openEntry(dn);
}

async function onGotoDn(dn: string) {
  const revealed = (await treeRef.value?.revealDn(dn)) === true;
  if (!revealed) showNotice(t("goto.notFound"));
}

// 比较（F3）：树右键 → 打开 CompareDialog（弹窗内自执行 entryCompare）。
function onCompare(dn: string) {
  compareDn.value = dn;
  compareOpen.value = true;
}

// 逐条 modifyDN 换父（RDN 用原条目首段——splitFirstDnRdn 转义感知，`cn=Doe\,
// John` 不会在转义逗号处被截断；deleteOldRdn=true 为保留原 RDN 的 modifyDN 语义）；
// 单条失败计数、不中断其余条目（与 onBatchDelete 同风格）。全部失败也给出
// failed=count 的通知；成功条目经事件总线失效新旧 DN 并重放结果。
async function onBatchMoveConfirm(targetParentDn: string) {
  const dns = batchMoveDns.value;
  if (dns.length === 0 || batchMoveSubmitting.value || !guardWrite()) return;
  batchMoveSubmitting.value = true;
  clearBanner();
  // 连接守卫（审计 L-1）：循环中途切换连接就中止，剩余 DN 不再发往新连接；
  // 汇总通知按实际成功/失败数展示，用户可感知中途停止。
  const conn = connectionId.value;
  const failed = new Set<string>();
  const moved: string[] = [];
  for (const dn of dns) {
    if (connectionId.value !== conn) break;
    const { rdn } = splitFirstDnRdn(dn);
    try {
      await ldapApi.entryModifyDn(dn, rdn, targetParentDn, true);
      emitEntryMoved(conn, dn, joinRdnAndParent(rdn, targetParentDn), true);
      moved.push(dn);
    } catch {
      failed.add(dn);
    }
  }
  batchMoveSubmitting.value = false;
  batchMoveOpen.value = false;
  showNotice(t("batchMove.result", { ok: moved.length, failed: failed.size }));
  if (moved.length === 0) return;
  const affectedParents = new Set<string>([targetParentDn, ...moved.map((dn) => splitFirstDnRdn(dn).parentDn)]);
  for (const parent of affectedParents) treeRef.value?.invalidate(parent);
}

// 树右键「复制条目」入口：取源条目 → 预填编辑器 add 态（细节在 useEntryDetail）。
function onCopyEntry(dn: string) {
  void openCopyEntry(dn);
}

function openAddChild(parentDn: string) {
  if (!guardWrite()) return;
  wizardParentDn.value = parentDn || baseDn.value;
  wizardOpen.value = true;
  void wizardSchemaCache.ensureLoaded(connectionId.value);
}

// 向导提交 = 空白新增的模板化版本：payload 由向导铺好 must 属性。
async function onWizardCreate(payload: { dn: string; attributes: Record<string, string[]> }) {
  if (!guardWrite()) return;
  clearBanner();
  try {
    await ldapApi.entryAdd(payload.dn, payload.attributes);
    wizardOpen.value = false;
    showNotice(t("editor.added"));
    treeRef.value?.invalidate(splitFirstDnRdn(payload.dn).parentDn);
  } catch (cause) {
    showError(cause);
  }
}

// 导入完成：刷新整棵树（批量写可能落在多个父节点下）并反馈汇总。
function onImported(importedCount: number, failed: number) {
  if (importedCount > 0) {
    treeRef.value?.invalidate();
    showNotice(t("ldap.importEntry.summary", { ok: importedCount, failed }));
  }
}

function onEditorSaved(dn: string, mode_: "add" | "edit") {
  emitEntryChanged(connectionId.value, dn);
  closeEditor();
  showNotice(mode_ === "add" ? t("editor.added") : t("editor.saved"));
  // 保存动作本身也应把条目记入最近打开。
  recentEntriesRecord.record(dn);
  treeRef.value?.invalidate(mode_ === "add" ? splitFirstDnRdn(dn).parentDn : dn);
}

function onReferenceSaved(dn: string, mode_: "add" | "edit") {
  emitEntryChanged(connectionId.value, dn);
  const activeId = activeReferenceTabId.value;
  if (activeId) closeReferenceTab(activeId);
  showNotice(mode_ === "add" ? t("editor.added") : t("editor.saved"));
  recentEntriesRecord.record(dn);
  treeRef.value?.invalidate(mode_ === "add" ? splitFirstDnRdn(dn).parentDn : dn);
}

function askDelete(dn: string) {
  if (!guardWrite()) return;
  deleteDn.value = dn;
  deleteOpen.value = true;
}

async function confirmDelete(options?: { recursive?: boolean }) {
  if (!deleteDn.value || deleteSubmitting.value || !guardWrite()) return;
  deleteSubmitting.value = true;
  clearBanner();
  try {
    // 递归标志由确认框勾选（有子条目才出现）；sidecar 优先走 Tree Delete
    // 控件、不支持时回退自底向上逐层删除（上限 1000 条）。
    const recursive = options?.recursive === true;
    await ldapApi.entryDelete(deleteDn.value, recursive);
    emitEntryDeleted(connectionId.value, deleteDn.value, recursive);
    deleteOpen.value = false;
    showNotice(t("deleteDialog.deleted"));
    treeRef.value?.invalidate(splitFirstDnRdn(deleteDn.value).parentDn);
  } catch (cause) {
    showError(cause);
  } finally {
    deleteSubmitting.value = false;
  }
}

function askRename(dn: string) {
  if (!guardWrite()) return;
  modifyDnSource.value = dn;
  modifyDnOpen.value = true;
}

async function confirmRename(newRdn: string, newParentDn: string | undefined, deleteOldRdn: boolean) {
  if (!modifyDnSource.value || modifyDnSubmitting.value || !guardWrite()) return;
  modifyDnSubmitting.value = true;
  clearBanner();
  try {
    await ldapApi.entryModifyDn(modifyDnSource.value, newRdn, newParentDn, deleteOldRdn);
    emitEntryMoved(
      connectionId.value,
      modifyDnSource.value,
      joinRdnAndParent(newRdn, newParentDn || splitFirstDnRdn(modifyDnSource.value).parentDn),
      true,
    );
    modifyDnOpen.value = false;
    showNotice(t("modifyDn.moved"));
    treeRef.value?.invalidate();
  } catch (cause) {
    showError(cause);
  } finally {
    modifyDnSubmitting.value = false;
  }
}

// -- 导出（子树/结果/RootDSE）---------------------------------------------------

// 导出子树单次抓取上限（条）：契约没有分页游标，前端无法逐页续拉；但
// pageSize>0 时 sidecar 会做服务端 paged search 聚合，聚合上限 = sizeLimit，
// 达上限截断并置 truncated=true。这里把导出上限提到契约计数上限量级
// （5000，与 ldap/count 一致，远大于此前硬编码 500），并消费 truncated：
// 仍被截断时通知明确告知"仅导出前 N 条"，不再静默残缺（UI 扫描 P1-3）。
const EXPORT_SIZE_LIMIT = 5000;
const EXPORT_PAGE_SIZE = 500;

async function exportSubtree(dn: string) {
  clearBanner();
  try {
    const result = await ldapApi.search({ baseDn: dn, filter: "(objectClass=*)", scope: "sub", sizeLimit: EXPORT_SIZE_LIMIT, pageSize: EXPORT_PAGE_SIZE });
    const outcome = await saveTextFile({ name: `${splitFirstDnRdn(dn).rdn || "subtree"}.ldif`, contentType: "text/plain", text: serializeEntriesToLdifText(result.entries) });
    if (outcome.status === "cancelled") return;
    if (result.truncated === true) {
      showNotice(t("result.exportTruncated", { count: result.entries.length, limit: EXPORT_SIZE_LIMIT }));
    } else {
      notifyExportSaved(outcome);
    }
  } catch (cause) {
    showError(cause);
  }
}

async function exportResults(format: "ldif" | "csv" | "json") {
  // An incomplete cursor is only the prefix currently rendered in the grid.
  // Exporting it as though it were the complete search would silently lose data.
  if (results.value.length === 0 || !resultsComplete.value) return;
  try {
    const text = format === "ldif" ? serializeEntriesToLdifText(results.value) : format === "csv" ? serializeEntriesToCsv(results.value) : serializeEntriesToJson(results.value);
    const contentType = format === "ldif" ? "text/plain" : format === "csv" ? "text/csv" : "application/json";
    const outcome = await saveTextFile({ name: `ldap-search.${format}`, contentType, text });
    notifyExportSaved(outcome);
  } catch (cause) {
    showError(cause);
  }
}

// 保存成功后的通知：宿主/浏览器对话框保存显示用户最终确认的文件名；只有走
// 旧版匿名下载兜底时才提示"进了浏览器默认下载目录"（否则用户无从找起）。
function notifyExportSaved(outcome: SaveTextOutcome) {
  if (outcome.status === "cancelled") return;
  if (outcome.via === "legacy") showNotice(t("result.exportDownloaded", { name: outcome.name }));
  else showNotice(t("result.exportDone", { name: outcome.name }));
}

// F12：设为浏览基——baseDn 变更由树/搜索的既有 watch 自动跟随（同 resolveAutoBaseDn 语义）。
function setBrowseBase(nextBaseDn: string) {
  baseDn.value = nextBaseDn;
  void searchRef.value?.applyBaseDn(nextBaseDn, false);
  showNotice(t("rootDse.setBaseDone", { baseDn: nextBaseDn }));
}

async function copyDn(dn: string) {
  // 桥缺失或写入失败要如实反馈（此前 catch 也提示"已复制"）。
  showNotice((await writeClipboardText(dn)) ? t("copied") : t("copyFailed"));
}

function openRecent(dn: string) {
  void openEntry(dn);
}

// -- 宿主桥与初始化 --------------------------------------------------------------

function handleEvent(event: DbxPluginEvent) {
  if (event.type === "env") {
    if (typeof event.locale === "string") setWorkbenchLocale(event.locale || "zh-CN");
    return;
  }
  if (event.method === "ldap/audit") {
    const params = event.params || {};
    // 数据面：进入最近操作面板（denied/error 高亮）。ok 结果不再弹通知——
    // 面板已承载记录，弹窗反而会覆盖领域反馈（审计 J-9）；denied/error 保留横幅。
    auditItems.value = pushAuditItem(auditItems.value, parseAuditEvent(params, auditSeq++, Date.now()));
    const result = String(params.result ?? "");
    if (result === "denied" || result === "error") {
      showError(`${params.action ?? "ldap"}: ${result}`);
    }
  }
}

function clearAuditFeed() {
  auditItems.value = [];
}

async function waitForHostApi(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!window.dbxPlugin && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!window.dbxPlugin) throw new Error(t("hostApiUnavailable"));
  return window.dbxPlugin;
}

async function initialize() {
  const api = await waitForHostApi();
  hostContext.value = await Promise.any([
    api.ready,
    api.request<Record<string, unknown>>("host.getContext"),
  ]);
  setWorkbenchLocale(api.locale || "zh-CN");
  if (api.appearance) applyAppearance(api.appearance);
  else if (isDbxPluginTheme(api.theme)) applyAppearance(themeToAppearance(api.theme));
  if (api.onAppearanceChange) unsubscribeAppearance.push(api.onAppearanceChange(applyAppearance));
  // appearance 契约缺失（当前 1.1 桥只推 theme）时订阅 env 主题推送，两套不同时挂。
  else unsubscribeAppearance.push(onHostThemeChange((theme) => applyAppearance(themeToAppearance(theme))));
  if (api.onLocaleChange) unsubscribeLocale.push(api.onLocaleChange((next) => setWorkbenchLocale(next || "zh-CN")));
  const onContext = api.onContext ?? api.onContextChange;
  if (onContext) unsubscribeContext.push(onContext.call(api, (context) => {
    hostContext.value = context;
    syncConnectionContext();
  }));
  if (api.onEvent) unsubscribeEvent.push(api.onEvent(handleEvent));
  if (!connectionId.value) throw new Error(t("connectionMissing"));
  setLdapConnectionId(connectionId.value);
  syncConnectionContext();
  void refreshBackendReadOnly();
  ready.value = true;
  await nextTick();
  void treeRef.value?.refresh();
  void searchRef.value?.applyBaseDn(baseDn.value, false);
}

// 连接切换时的状态隔离（UI 扫描 P2-24）：结果表/已开弹窗属于上一个连接，
// 残留会把写操作发往新连接。树随 baseDn watch 自动重载，无需在此处理。
let lastSyncedConnectionId = "";
function syncConnectionContext() {
  setLdapConnectionId(connectionId.value);
  const current = connectionId.value;
  const switched = lastSyncedConnectionId !== "" && lastSyncedConnectionId !== current;
  lastSyncedConnectionId = current;
  if (switched) {
    resetSearchSession();
    closeEditor();
    editorAddPrefill.value = undefined;
    deleteOpen.value = false;
    modifyDnOpen.value = false;
    batchMoveOpen.value = false;
    batchModifyOpen.value = false;
    wizardOpen.value = false;
    // 比较/导入/Schema/连接面板同属上一个连接的弹窗状态（审计 J-3/L-9）：
    // 残留会把旧连接的 DN/上下文带进新连接的操作里，一并关闭复位。
    compareOpen.value = false;
    compareDn.value = "";
    importOpen.value = false;
    schemaOpen.value = false;
    connectionsOpen.value = false;
    // 服务器信息弹窗同属上一个连接（statuses/whoami 都跟随全局连接语义），
    // 切换时一并关闭，防止把旧连接的 RootDSE 数据带进新连接的视图。
    rootDseOpen.value = false;
    // DN 属性名集合属于上一个连接的 schema，随连接切换一并失效重取。
    dnAttributes.value = [];
    editorSchema.value = undefined;
    dnAttributesReady = false;
    // 最近操作面板同属上一个连接（round-4）：残留会让新连接的写操作反馈
    // 与旧连接的 denied/ok 事件混在一起，误导排查。
    auditItems.value = [];
    // 最近打开条目同样是上一个连接的浏览状态（DN 只在原目录里有意义）。
    recentEntriesRecord.clear();
    openTabs.value = [];
    tabDirty.value = false;
    clearEntryCache();
  }
  // 书签按连接隔离：切换后重载（首次初始化也经此处装载）。
  reloadBookmarks();
  baseDn.value = contextBaseDn.value;
  void resolveAutoBaseDn();
  // Schema is intentionally not warmed here: a user-visible entry read must
  // always win over metadata.  The wizard and entry detail loaders request it
  // lazily after their own primary data is visible.
}

// 协议徽章与服务器徽章（纯函数见 lib/connectionIdentity.ts）。
const protocolBadgeText = computed(() => protocolBadge(connection.value));
const serverBadge = computed(() => serverBadgeLabel(wizardSchemaCache.serverInfo.value));

// 连接未配置 base_dn 时的兜底定位（tiny-rdm baseDn.js 语义）：
// RootDSE namingContexts（AD 取 defaultNamingContext）→ 主机名推断
// （corp.int.kn → dc=corp,dc=int,dc=kn）。两路都失败则保留空值，
// 由目录树提示用户补配。显式配置永远优先；解析成功后提示实际生效值。
async function resolveAutoBaseDn() {
  if (baseDn.value) return;
  let resolved = "";
  try {
    const result = await ldapApi.rootDse(["namingContexts", "defaultNamingContext"]);
    resolved = pickBaseDnFromRootDse(result.attributes || {});
  } catch {
    // RootDSE 不可读（如配置了 allowed_base_dns）：退回主机名推断。
  }
  if (!resolved) {
    resolved = inferBaseDnFromProfile({ url: connection.value.host, host: connection.value.host });
  }
  if (!resolved || baseDn.value || contextBaseDn.value) return; // 竞态守卫：期间带来显式值则放弃
  baseDn.value = resolved;
  void searchRef.value?.applyBaseDn(resolved, false);
  showNotice(t("tree.autoBaseDn", { baseDn: resolved }));
}

function refreshTree() {
  void treeRef.value?.refresh();
}

onMounted(() => {
  setupTooltipLayer();
  void initialize().catch((cause) => showError(cause, "init"));
});

onBeforeUnmount(() => {
  disposeSearchSession();
  disposeEntrySession();
  disposeReferenceTabs();
  // 先清重放防抖定时器再退订事件总线：挂载同 tick 卸载时回调不会随定时器"复活"。
  window.clearTimeout(entryReplayTimer);
  disposeEntryEventWire();
  disposeFeedback();
  uiIntent.stop();
  teardownTooltipLayer();
  for (const dispose of [...unsubscribeAppearance, ...unsubscribeLocale, ...unsubscribeContext, ...unsubscribeEvent]) dispose();
});
</script>

<template>
  <div class="workbench">
    <WorkbenchToolbar
      :ready="ready"
      :show-spinner="!ready && !initError"
      :identity-text="identityText"
      :protocol-badge="protocolBadgeText"
      :server-badge="serverBadge"
      :can-write="canWrite"
      :connection-color="connection.color"
      :toolbar-style="toolbarStyle"
      :recent-entries="recentEntries"
      :bookmarks="bookmarks"
      :exportable="results.length > 0 && resultsComplete"
      :export-title="resultsComplete ? t('result.exportLdif') : t('result.exportIncomplete')"
      @root-dse="rootDseOpen = true"
      @open-schema="schemaOpen = true"
      @open-connections="connectionsOpen = true"
      @open-import="importOpen = true"
      @open-recent="openRecent"
      @open-bookmark="onOpenBookmark"
      @remove-bookmark="onRemoveBookmark"
      @goto-dn="onGotoDn"
      @refresh="refreshTree"
      @export-ldif="exportResults('ldif')"
    />

    <!-- 错误横幅改为布局流内（UI 扫描 P2-8）：出现时主区整体下移让位，
         不再遮住 Base DN/范围字段；瞬时且可关闭，位移可接受。 -->
    <div v-if="ldapError" class="error-banner" role="alert">
      <span :title="ldapErrorDetail || ldapError">{{ ldapError }}</span>
      <button type="button" :title="t('close')" :aria-label="t('close')" @click="dismissError"><X aria-hidden="true" /></button>
    </div>

    <div v-if="initError" class="tree-state">{{ initError }}</div>
    <div v-else-if="!ready" class="tree-state">{{ t("tree.loading") }}</div>

    <div v-else class="panes">
      <DnTree
        ref="treeRef"
        :base-dn="baseDn"
        :connection-id="connectionId"
        :can-write="canWrite"
        @select="selectEntry"
        @search-here="searchHere"
        @view="openEntry"
        @members="searchMembersAt"
        @add="openAddChild"
        @copy-entry="onCopyEntry"
        @rename="askRename"
        @remove="askDelete"
        @export="exportSubtree"
        @copy-dn="copyDn"
        @add-bookmark="onAddBookmark"
        @compare="onCompare"
      />
      <div class="divider" />
      <main class="main-pane">
        <SearchForm
          ref="searchRef"
          :base-dn="baseDn"
          :disabled="searching"
          :running="searching"
          @run="runSearch"
          @notify="showNotice"
          @error="(message) => showError(message)"
        />
        <p v-if="!baseDn" class="hint" style="padding: 0 10px">{{ t("tree.missingBaseDn") }}</p>
        <ResultTable
          :entries="results"
          :count="resultCount"
          :truncated="resultTruncated"
          :at-limit="resultAtLimit"
          :size-limit="lastSizeLimit"
          :searched="hasSearched"
          :disabled="searching"
          :loading="searching"
          :complete="resultsComplete"
          :loading-more="loadingMore"
          :load-more-error="loadMoreError"
          :load-more-error-detail="loadMoreErrorDetail"
          :error="searchError"
          :error-detail="searchErrorDetail"
          :can-write="canWrite"
          @retry="retrySearch"
          @load-more="requestNextSearchPage"
          @retry-more="requestNextSearchPage"
          @open="openEntry"
          @export="exportResults"
          @notify="showNotice"
          @batch-delete="onBatchDelete"
          @batch-move="onBatchMove"
          @batch-modify="onBatchModify"
        />
        <AuditFeedPanel :items="auditItems" @clear="clearAuditFeed" />
      </main>
    </div>

    <div v-if="notice" class="notice" role="status">{{ notice }}</div>

    <template v-if="referenceOpen">
      <div class="entry-relation-backdrop" @click.self="closeActiveReference">
        <div class="entry-relation-layout" role="dialog" aria-modal="true" :aria-label="t('editor.relationTitle')">
          <header class="entry-relation-header">
            <div class="entry-relation-heading">
              <strong>{{ t("editor.relationTitle") }}</strong>
            </div>
            <button class="icon-button" :title="t('close')" :aria-label="t('close')" @click="closeEditor">
              <X aria-hidden="true" />
            </button>
          </header>
          <div class="entry-relation-pane">
            <div class="entry-relation-label">
              <strong>{{ t("editor.relationSource") }}</strong>
              <!-- 走查定稿：标签只展示 RDN 短名，完整 DN 收进 hover title。 -->
              <span :title="editorRequestedDn">{{ splitFirstDnRdn(editorRequestedDn).rdn || editorRequestedDn }}</span>
            </div>
            <EntryEditorDialog
              :open="editorOpen"
              :entry="editorEntry"
              :parent-dn="editorParentDn"
              :add-prefill="editorAddPrefill"
              :can-write="canWrite"
              :base-dn="baseDn"
              :dn-attributes="dnAttributes"
              :schema="editorSchema"
              :requested-dn="editorRequestedDn"
              :loading="editorLoading"
              :loading-more="editorLoadingMore"
              :loading-deferred="editorDeferredLoading"
              :deferred-attribute-count="editorDeferredAttributes.length"
              :load-error="editorLoadError"
              :load-error-detail="editorLoadErrorDetail"
              :initial-tab="editorInitialTab"
              presentation="relation"
              @close="closeEditor"
              @retry="openEntry(editorRequestedDn, editorInitialTab)"
              @load-deferred="loadDeferredEditorAttributes"
              @saved="onEditorSaved"
              @error="showError"
              @notify="showNotice"
              @open-related-entry="openReferencedEntry"
            />
          </div>
          <div class="entry-relation-connector" aria-hidden="true">
            <span class="entry-relation-arrow">→</span>
            <span v-if="referenceAttribute" class="entry-relation-field-label">{{ referenceAttribute }}</span>
          </div>
          <div class="entry-relation-pane">
            <div class="entry-relation-tabs" role="tablist" :aria-label="t('editor.relationTarget')">
              <div
                v-for="tab in referenceTabs"
                :key="tab.id"
                class="entry-relation-tab-shell"
                :class="{ 'is-active': tab.id === activeReferenceTabId }"
              >
                <button
                  type="button"
                  class="entry-relation-tab"
                  role="tab"
                  :aria-selected="tab.id === activeReferenceTabId"
                  :title="tab.dn"
                  @click="selectReferenceTab(tab.id)"
                >
                  <span class="entry-relation-tab-name">{{ splitFirstDnRdn(tab.dn).rdn || tab.dn }}</span>
                  <span v-if="tab.attribute" class="entry-relation-tab-attribute">{{ tab.attribute }}</span>
                  <span
                    role="button"
                    tabindex="0"
                    class="entry-relation-tab-close"
                    :title="t('close')"
                    :aria-label="t('close')"
                    @click.stop="closeReferenceTab(tab.id)"
                    @keydown.enter.prevent="closeReferenceTab(tab.id)"
                    @keydown.space.prevent="closeReferenceTab(tab.id)"
                  >
                    <X aria-hidden="true" />
                  </span>
                </button>
              </div>
            </div>
            <div class="entry-relation-label">
              <strong>{{ t("editor.relationTarget") }}</strong>
              <span :title="referenceRequestedDn">{{ splitFirstDnRdn(referenceRequestedDn).rdn || referenceRequestedDn }}</span>
            </div>
            <EntryEditorDialog
              :open="referenceOpen"
              :entry="referenceEntry"
              :can-write="canWrite"
              :base-dn="baseDn"
              :dn-attributes="dnAttributes"
              :schema="editorSchema"
              :requested-dn="referenceRequestedDn"
              :loading="referenceLoading"
              :load-error="referenceLoadError"
              :load-error-detail="referenceLoadErrorDetail"
              presentation="relation"
              @close="closeActiveReference"
              @retry="retryReference"
              @saved="onReferenceSaved"
              @error="showError"
              @notify="showNotice"
              @open-related-entry="openReferencedEntry"
            />
          </div>
        </div>
      </div>
    </template>
    <EntryEditorDialog
      v-else
      :open="editorOpen"
      :entry="editorEntry"
      :parent-dn="editorParentDn"
      :add-prefill="editorAddPrefill"
      :can-write="canWrite"
      :base-dn="baseDn"
      :dn-attributes="dnAttributes"
      :schema="editorSchema"
      :requested-dn="editorRequestedDn"
      :loading="editorLoading"
      :loading-more="editorLoadingMore"
      :loading-deferred="editorDeferredLoading"
      :deferred-attribute-count="editorDeferredAttributes.length"
      :load-error="editorLoadError"
      :load-error-detail="editorLoadErrorDetail"
      :initial-tab="editorInitialTab"
      :open-tabs="openTabs"
      :active-tab-dn="editorRequestedDn"
      @close="closeEditor"
      @retry="openEntry(editorRequestedDn, editorInitialTab)"
      @dirty-change="tabDirty = $event"
      @switch-tab="onSwitchTab"
      @close-tab="onCloseTab"
      @load-deferred="loadDeferredEditorAttributes"
      @saved="onEditorSaved"
      @error="showError"
      @notify="showNotice"
      @open-entry="openEntryFromDialog"
      @open-related-entry="openReferencedEntry"
    />
    <DeleteEntryDialog
      :open="deleteOpen"
      :dn="deleteDn"
      :submitting="deleteSubmitting"
      @close="deleteOpen = false"
      @confirm="confirmDelete"
    />
    <ModifyDnDialog
      :open="modifyDnOpen"
      :dn="modifyDnSource"
      :base-dn="baseDn"
      :submitting="modifyDnSubmitting"
      @close="modifyDnOpen = false"
      @confirm="confirmRename"
    />
    <BatchMoveDialog
      :open="batchMoveOpen"
      :dns="batchMoveDns"
      :submitting="batchMoveSubmitting"
      @close="batchMoveOpen = false"
      @confirm="onBatchMoveConfirm"
    />
    <BatchModifyDialog
      :open="batchModifyOpen"
      :dns="batchModifyDns"
      :submitting="batchModifySubmitting"
      @close="batchModifyOpen = false"
      @confirm="onBatchModifyConfirm"
    />
    <CompareDialog :open="compareOpen" :dn="compareDn" @close="compareOpen = false" @notify="showNotice" />
    <NewEntryWizard
      :open="wizardOpen"
      :parent-dn="wizardParentDn"
      :schema="wizardSchema"
      :can-write="canWrite"
      @submit="onWizardCreate"
      @cancel="wizardOpen = false"
    />
    <SchemaPanel :open="schemaOpen" :connection-id="connectionId" @close="schemaOpen = false" @error="showError" />
    <ImportEntryDialog
      :open="importOpen"
      :can-write="canWrite"
      :parent-dn="baseDn"
      @close="importOpen = false"
      @imported="onImported"
      @error="showError"
      @notify="showNotice"
    />
    <ConnectionsPanel :open="connectionsOpen" :disabled="!ready" @close="connectionsOpen = false" @error="showError" />
    <RootDseDialog :open="rootDseOpen" :connection="connection" @close="rootDseOpen = false" @error="showError" @notify="showNotice" @set-base="setBrowseBase" />
  </div>
</template>

