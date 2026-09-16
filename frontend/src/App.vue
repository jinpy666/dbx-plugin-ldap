<script setup lang="ts">
// LDAP 工作台外壳：布局 + 连接上下文（照 ssh-sftp App.vue 的宿主桥用法）。
// 连接生命周期由宿主驱动（connection/test|connect|disconnect），工作台只持有
// connectionId；所有 ldap/* 调用经 lib/api.ts 注入 connectionId。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Database, Download, FileText, FileUp, History, Info, Loader2, Network, RefreshCw, X } from "@lucide/vue";
import { DBX_POPOVER, resolveAppearance, type DbxPluginAppearanceInput } from "./lib/appearance";
import { isDbxPluginTheme, onHostThemeChange, themeToAppearance } from "./lib/hostTheme";
import { setWorkbenchLocale, t, workbenchLocale } from "./lib/i18n";
import { getLdapConnectionId, ldapApi, setLdapConnectionId, type LdapEntry, type LdapSearchRequest } from "./lib/api";
import { inferBaseDnFromProfile, pickBaseDnFromRootDse } from "./lib/baseDn";
import { splitFirstDnRdn } from "./lib/dn";
import { escapeLdapFilterValue } from "./lib/ldapFilter";
import { friendlyLdapError } from "./lib/ldapErrors";
import { writeClipboardText } from "./lib/clipboard";
import { saveTextFile, type SaveTextOutcome } from "./lib/fileSave";
import { serializeEntriesToCsv, serializeEntriesToJson, serializeEntriesToLdifText } from "./lib/ldapExporter";
import { randomUUID } from "./lib/uuid";
import DnTree from "./components/DnTree.vue";
import SearchForm, { type SearchFormModel } from "./components/SearchForm.vue";
import ResultTable from "./components/ResultTable.vue";
import EntryEditorDialog from "./components/EntryEditorDialog.vue";
import ImportEntryDialog from "./components/ImportEntryDialog.vue";
import DeleteEntryDialog from "./components/DeleteEntryDialog.vue";
import ModifyDnDialog from "./components/ModifyDnDialog.vue";
import BatchMoveDialog from "./components/BatchMoveDialog.vue";
import NewEntryWizard from "./components/NewEntryWizard.vue";
import SchemaPanel from "./components/SchemaPanel.vue";
import ConnectionsPanel from "./components/ConnectionsPanel.vue";
import AuditFeedPanel from "./components/AuditFeedPanel.vue";
import { deriveSchemaMetadata, useLdapSchemaCache } from "./lib/schemaCache";
import { deriveDnValuedAttributes } from "./lib/dnAttributes";
import { prepareCopyEntry } from "./lib/copyEntry";
import type { LdapSchema } from "./lib/newEntryTemplates";
import { parseAuditEvent, pushAuditItem, type AuditFeedItem } from "./lib/auditFeed";
import { setupTooltipLayer, teardownTooltipLayer } from "./lib/tooltip";
import { chunkEntryAttributes, ENTRY_PRIORITY_ATTRIBUTES, mergeEntryAttributes, partitionEntryAttributes } from "./lib/stagedEntry";
import { loadPreferredPageSize } from "./lib/ldapGrid";
import { useModalA11y } from "./lib/modal";
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
const initError = ref("");
const ldapError = ref("");
const ldapErrorDetail = ref("");
const notice = ref("");
const busy = ref(false);

const treeRef = ref<InstanceType<typeof DnTree>>();
const searchRef = ref<InstanceType<typeof SearchForm>>();

const baseDn = ref("");
const searchModel = ref<SearchFormModel>();
const results = ref<LdapEntry[]>([]);
const resultCount = ref(0);
const resultTruncated = ref(false);
// `resultCount` is an exact total only when the LDAP search cursor is exhausted.
// Until then it deliberately means "entries loaded", never an invented total.
const resultsComplete = ref(true);
const searching = ref(false);
const loadingMore = ref(false);
const loadMoreError = ref("");
const loadMoreErrorDetail = ref("");
const searchError = ref("");
const searchErrorDetail = ref("");
let searchRequestSeq = 0;
let activeSearchSession: { id: string; connectionId: string } | undefined;
let idlePrefetchHandle: number | undefined;
// 空结果两态（UI 扫描 P2-3）：执行过搜索后的 0 条 ≠ "请先执行搜索"。
const hasSearched = ref(false);
// 恰好等于 sizeLimit 的"整页结果"信号（UI 扫描 P2-15）：契约 truncated 只在
// 后端真实截断时为 true，夹具/真机都可能出现"count===上限但 truncated=false"
// 的巧合态——此时给"可能不完整"提示而不是假装完整。
const resultAtLimit = ref(false);
// 最近一次搜索的 sizeLimit（P2-15 提示文案需要展示上限值）。
const lastSizeLimit = ref<number>();

const editorOpen = ref(false);
const editorEntry = ref<LdapEntry>();
const editorParentDn = ref("");
const editorRequestedDn = ref("");
const editorLoading = ref(false);
// `editorLoading` only covers the small first read.  The dialog renders that
// result immediately; `editorLoadingMore` keeps writes disabled until the
// regular attributes have caught up, so a partial edit can never manufacture
// deletes for attributes that have not arrived yet.
const editorLoadingMore = ref(false);
const editorDeferredLoading = ref(false);
const editorDeferredAttributes = ref<string[]>([]);
const editorDeferredRequested = ref(false);
const editorLoadError = ref("");
const editorLoadErrorDetail = ref("");
let entryRequestSeq = 0;
const entryDetailCache = new Map<string, { entry: LdapEntry; fetchedAt: number }>();

function entryCacheKey(connection: string, dn: string): string {
  return `${connection}\u0000${dn.trim().toLowerCase()}`;
}

function invalidateEntryCache(dn: string, descendants = false) {
  const connection = connectionId.value;
  const normalized = dn.trim().toLowerCase();
  for (const key of entryDetailCache.keys()) {
    const [cachedConnection, cachedDn] = key.split("\u0000", 2);
    if (cachedConnection === connection && (cachedDn === normalized || (descendants && cachedDn.endsWith(`,${normalized}`)))) {
      entryDetailCache.delete(key);
    }
  }
}
// 关联双栏会话：左侧保留发起引用的详情，右侧以标签页独立加载被引用条目。
// 每个引用标签都有自己的请求序号，加载/失败/重试不会覆盖主条目或其他标签。
const referenceOpen = ref(false);
interface ReferenceTab {
  id: string;
  dn: string;
  entry?: LdapEntry;
  loading: boolean;
  loadError: string;
  loadErrorDetail: string;
  requestSeq: number;
}
const referenceTabs = ref<ReferenceTab[]>([]);
const activeReferenceTabId = ref("");
let nextReferenceTabId = 0;
const activeReferenceTab = computed(() => referenceTabs.value.find((tab) => tab.id === activeReferenceTabId.value));
const referenceEntry = computed(() => activeReferenceTab.value?.entry);
const referenceRequestedDn = computed(() => activeReferenceTab.value?.dn ?? "");
const referenceLoading = computed(() => activeReferenceTab.value?.loading ?? false);
const referenceLoadError = computed(() => activeReferenceTab.value?.loadError ?? "");
const referenceLoadErrorDetail = computed(() => activeReferenceTab.value?.loadErrorDetail ?? "");
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
const schemaOpen = ref(false);
// 条目导入弹窗（阶段4）：LDIF / PowerShell Format-List 粘贴或文件导入。
const importOpen = ref(false);
const connectionsOpen = ref(false);

// M6 N4：新建条目走模板向导（树「新增子条目」入口），schema 用独立
// 进程内缓存（与 SearchForm/SchemaPanel 同款，per-connection TTL 30min）。
const wizardOpen = ref(false);
const wizardParentDn = ref("");
const wizardSchemaCache = useLdapSchemaCache({
  loader: () =>
    ldapApi.schema().then((result) =>
      deriveSchemaMetadata(result.attributeTypes, result.objectClasses, {
        dialect: result.dialect,
        vendorName: result.vendorName,
        productName: result.productName,
      }),
    ),
});
const wizardSchema = computed(() => ({ objectClassAttributes: wizardSchemaCache.objectClassAttributes.value }));

// 条目关联视图（泛化）：schema 驱动的 DN 值属性名集合，经 EntryEditorDialog
// 透传给 AssociationPanel。与 wizardSchemaCache 同款 useLdapSchemaCache 缓存
// （per-connection TTL + inFlight 去重），但 loader 直接把 ldap/schema 的
// 原始 attributeTypes 装进 attributeNames 槽供 deriveDnValuedAttributes 消费；
// 同一次加载保留 objectClass MUST/SUP，供编辑器预检。惰性：首次打开时加载；失败静默
// 降级为不传（panel 有内置兜底表），不弹错误横幅。
const dnAttributes = ref<string[]>([]);
const editorSchema = ref<LdapSchema>();
let dnAttributesReady = false;
const dnSchemaCache = useLdapSchemaCache({
  loader: () =>
    ldapApi.schema().then((result) => {
      // deriveDnValuedAttributes 消费 raw RFC 4512 定义串：真实 sidecar 的
      // attributeTypes 是结构体数组，优先用其透出的 rawAttributeTypes。
      const rawDefinitions = result.rawAttributeTypes?.length ? result.rawAttributeTypes : result.attributeTypes;
      return {
        ...deriveSchemaMetadata(result.attributeTypes, result.objectClasses, {
          dialect: result.dialect,
          vendorName: result.vendorName,
          productName: result.productName,
        }),
        attributeNames: rawDefinitions as string[],
      };
    }),
});
async function ensureDnAttributes() {
  if (dnAttributesReady) return;
  const requestedConnection = connectionId.value;
  try {
    const payload = await dnSchemaCache.ensureLoaded(requestedConnection);
    if (requestedConnection !== connectionId.value) return;
    dnAttributes.value = deriveDnValuedAttributes(payload?.attributeNames ?? []);
    editorSchema.value = payload ?? undefined;
    dnAttributesReady = true;
  } catch {
    // schema 拉取失败静默降级；不置位 ready，下次打开编辑器可重试
    // （ensureLoaded 内部有 inFlight 去重与 TTL，不会并发重复请求）。
  }
}

// 审计事件流（ldap/audit → 最近操作面板）；横幅/通知仍保留作为即时反馈。
const auditItems = ref<AuditFeedItem[]>([]);
let auditSeq = 0;

// -- MCP UI intent 通道（M1，shared/frontend/uiIntent 公共层） -----------------

const INTENT_CELL_WIDTH = 120;

// 结果摘要：count + 前 5 行（每 cell 截 120 字符，DN 定位字段不截断），
// 与 sidecar ldap_search_digest 的 summary 形状一致。
function summarizeResults(): UiIntentSummary {
  const rows = results.value.slice(0, 5).map((entry) => {
    const cells: Record<string, unknown> = { dn: entry.dn };
    for (const [name, values] of Object.entries(entry.attributes)) {
      if (Object.keys(cells).length >= 4) break;
      const value = values?.[0] ?? "";
      cells[name] = [...value].length > INTENT_CELL_WIDTH ? `${[...value].slice(0, INTENT_CELL_WIDTH).join("")}…` : value;
    }
    return cells;
  });
  const anchor = typeof rows[0]?.dn === "string" ? rows[0].dn : undefined;
  return { count: resultCount.value, truncated: resultTruncated.value, rows, ...(anchor ? { anchor } : {}) };
}

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
    return { status: "applied", summary: summarizeResults() };
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

let noticeTimer = 0;
const unsubscribeAppearance: Array<() => void> = [];
const unsubscribeLocale: Array<() => void> = [];
const unsubscribeContext: Array<() => void> = [];
const unsubscribeEvent: Array<() => void> = [];

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

// 从连接状态表读取生效只读门禁；旧 sidecar 无 readOnly 字段时保持可写回退。
async function refreshBackendReadOnly() {
  try {
    const result = await ldapApi.connectionStatuses();
    const mine = (result.statuses || []).find((row) => row.connectionId === connectionId.value);
    backendReadOnly.value = mine?.readOnly === true;
  } catch {
    backendReadOnly.value = false;
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
const connectionIdentity = computed(() => {
  const host = connection.value.host || connection.value.name || connectionId.value;
  const identity = connection.value.username ? `${connection.value.username}@${host}` : host;
  const port = connection.value.port ? `:${connection.value.port}` : "";
  return `${identity}${port}`;
});
// 初始化失败（最常见：无连接上下文）时 identity 降级为占位，不再展示
// 看似就绪的完整连接身份（UI 扫描 P2-2：与"未就绪"提示自相矛盾）。
const identityText = computed(() => (initError.value ? t("connectionPlaceholder") : connectionIdentity.value));
const toolbarStyle = computed(() => {
  const color = connection.value.color;
  if (!color) return undefined;
  // light 下染色收口到 5%（与 kafka 家族对齐，UI 扫描 P2-9：10% 淡紫易与状态色混淆）。
  const light = appearance.value.colorScheme === "light";
  return {
    backgroundColor: colorWithAlpha(color, light ? 0.05 : 0.1),
    boxShadow: `inset 0 1px 0 ${colorWithAlpha(color, light ? 0.12 : 0.18)}`,
  };
});

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
  root.style.setProperty("--ui-font-family", resolved.ui.fontFamily);
}

function showNotice(message: string) {
  notice.value = message;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (notice.value = ""), 3500);
}

function showError(cause: unknown, target: "ldap" | "init" | "search" | "entry" = "ldap") {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (target === "init") {
    initError.value = message;
    return;
  }
  if (target === "search") {
    searchError.value = friendlyLdapError(message);
    searchErrorDetail.value = message;
    return;
  }
  if (target === "entry") {
    editorLoadError.value = friendlyLdapError(message);
    editorLoadErrorDetail.value = message;
    return;
  }
  // 横幅展示本地化的可行动文案；原始错误串挂在 title 悬停里供排查。
  ldapError.value = friendlyLdapError(message);
  ldapErrorDetail.value = ldapError.value === message ? "" : message;
}

function dismissError() {
  ldapError.value = "";
}

function colorWithAlpha(color: string, alpha: number) {
  const match = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
  const hex = match[1].length === 3 ? [...match[1]].map((part) => `${part}${part}`).join("") : match[1];
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}

// -- search flow --------------------------------------------------------------

// 写操作后的结果表联动（UI 扫描 P2-25）：被删/改名条目仍在当前结果里时
// 重放最近一次搜索，避免残留行双击报 entry not found。无搜索史则跳过。
async function refreshResultsAfterWrite(affected: (dn: string) => boolean) {
  if (!hasSearched.value || !searchModel.value) return;
  if (!results.value.some((entry) => affected(entry.dn))) return;
  await runSearch(searchModel.value);
}

// 结果表批量删除（结果多选，ADS Batch Operations 单步版）：逐条非递归删除，
// 与确认文案一致——仍有子条目的条目会失败并计入 failed，不做半递归的意外删除。
// 成功的按各自父节点失效树；被删条目（及其子树内的命中行）仍留在结果里时
// 重放最近一次搜索，避免残留行双击报 entry not found。
async function onBatchDelete(dns: string[]) {
  if (dns.length === 0 || busy.value) return;
  ldapError.value = "";
  const failed = new Set<string>();
  for (const dn of dns) {
    try {
      await ldapApi.entryDelete(dn, false);
    } catch {
      failed.add(dn);
    }
  }
  showNotice(t("result.batchResult", { ok: dns.length - failed.size, failed: failed.size }));
  const deleted = dns.filter((dn) => !failed.has(dn));
  if (deleted.length === 0) return;
  for (const dn of deleted) invalidateEntryCache(dn, true);
  for (const parent of new Set(deleted.map((dn) => parentOf(dn)))) treeRef.value?.invalidate(parent);
  void refreshResultsAfterWrite((dn) => {
    const key = dn.toLowerCase();
    return deleted.some((entry) => key === entry.toLowerCase() || key.endsWith(`,${entry.toLowerCase()}`));
  });
}

// 批量移动入口（ResultTable 多选 → batchMove 事件，payload 与 batchDelete
// 同为条目顺序的原始大小写 DN）：空数组忽略，只负责打开确认框；真正的移动
// 在 onBatchMoveConfirm 执行，便于单测与防重入。
function onBatchMove(dns: string[]) {
  if (dns.length === 0 || busy.value) return;
  batchMoveDns.value = dns;
  batchMoveOpen.value = true;
}

// 逐条 modifyDN 换父（RDN 用原条目首段，deleteOldRdn=true 为保留原 RDN 的
// modifyDN 语义）；单条失败计数、不中断其余条目（与 onBatchDelete 同风格）。
// 全部失败也给出 failed=count 的通知；成功的按「目标父 + 各源父」失效树，
// 被 move 的 DN 已变化，仍留在结果里时重放搜索避免残留行。
async function onBatchMoveConfirm(targetParentDn: string) {
  const dns = batchMoveDns.value;
  if (dns.length === 0 || batchMoveSubmitting.value) return;
  batchMoveSubmitting.value = true;
  ldapError.value = "";
  const failed = new Set<string>();
  for (const dn of dns) {
    try {
      await ldapApi.entryModifyDn(dn, rdnOf(dn), targetParentDn, true);
    } catch {
      failed.add(dn);
    }
  }
  batchMoveSubmitting.value = false;
  batchMoveOpen.value = false;
  showNotice(t("batchMove.result", { ok: dns.length - failed.size, failed: failed.size }));
  const moved = dns.filter((dn) => !failed.has(dn));
  if (moved.length === 0) return;
  for (const dn of moved) {
    invalidateEntryCache(dn, true);
    invalidateEntryCache(`${rdnOf(dn)},${targetParentDn}`, true);
  }
  const affectedParents = new Set<string>([targetParentDn, ...moved.map((dn) => parentOf(dn))]);
  for (const parent of affectedParents) treeRef.value?.invalidate(parent);
  void refreshResultsAfterWrite((dn) => {
    const key = dn.toLowerCase();
    return moved.some((entry) => key === entry.toLowerCase() || key.endsWith(`,${entry.toLowerCase()}`));
  });
}

function cancelIdlePrefetch() {
  if (idlePrefetchHandle === undefined) return;
  if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idlePrefetchHandle);
  else window.clearTimeout(idlePrefetchHandle);
  idlePrefetchHandle = undefined;
}

function cancelActiveSearchSession() {
  cancelIdlePrefetch();
  const session = activeSearchSession;
  activeSearchSession = undefined;
  if (session) void ldapApi.searchCancel(session.id, session.connectionId).catch(() => {});
}

function scheduleIdlePrefetch(request: number, searchId: string) {
  // One low-priority look-ahead page makes scrolling/paging feel immediate,
  // without silently walking a potentially huge directory to completion.
  cancelIdlePrefetch();
  const callback = () => {
    idlePrefetchHandle = undefined;
    if (request === searchRequestSeq && activeSearchSession?.id === searchId) void loadNextSearchPage();
  };
  idlePrefetchHandle = typeof window.requestIdleCallback === "function"
    ? window.requestIdleCallback(callback, { timeout: 1000 })
    : window.setTimeout(callback, 750);
}

async function loadNextSearchPage() {
  const session = activeSearchSession;
  const request = searchRequestSeq;
  if (!session || loadingMore.value || searching.value) return;
  loadingMore.value = true;
  loadMoreError.value = "";
  loadMoreErrorDetail.value = "";
  try {
    const page = await ldapApi.searchNext(session.id, session.connectionId);
    if (request !== searchRequestSeq || activeSearchSession?.id !== session.id) return;
    const entries = Array.isArray(page.entries) ? page.entries : [];
    // Keep every page in server cursor order. Do not re-query with a larger
    // limit or de-duplicate locally: either would risk skipping real entries.
    results.value = [...results.value, ...entries];
    resultCount.value = results.value.length;
    resultsComplete.value = page.hasMore !== true;
    if (resultsComplete.value) activeSearchSession = undefined;
  } catch (cause) {
    if (request === searchRequestSeq && activeSearchSession?.id === session.id) {
      const message = cause instanceof Error ? cause.message : String(cause);
      loadMoreError.value = friendlyLdapError(message);
      loadMoreErrorDetail.value = message;
    }
  } finally {
    if (request === searchRequestSeq) loadingMore.value = false;
  }
}

function requestNextSearchPage() {
  // A user-requested continuation supersedes the one scheduled look-ahead;
  // otherwise a quick click could consume two pages back-to-back.
  cancelIdlePrefetch();
  void loadNextSearchPage();
}

function searchRequest(model: SearchFormModel): LdapSearchRequest {
  const attributes = model.attributes
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const requestedPageSize = positiveInt(model.pageSize) ?? loadPreferredPageSize("result");
  return {
    baseDn: model.baseDn.trim() || undefined,
    filter: model.filter.trim() || "(objectClass=*)",
    scope: model.scope,
    ...(attributes.length > 0 ? { attributes } : {}),
    sizeLimit: positiveInt(model.sizeLimit),
    // Do not let the legacy default of 500 postpone the first visible grid
    // page. A user-requested smaller page is still respected.
    pageSize: Math.min(requestedPageSize, loadPreferredPageSize("result")),
    typesOnly: model.typesOnly,
    derefAliases: model.derefAliases,
  };
}

async function runSearch(model: SearchFormModel) {
  if (busy.value) return;
  const request = ++searchRequestSeq;
  const requestedConnectionId = connectionId.value;
  cancelActiveSearchSession();
  searching.value = true;
  loadingMore.value = false;
  searchModel.value = { ...model };
  searchError.value = "";
  loadMoreError.value = "";
  loadMoreErrorDetail.value = "";
  ldapError.value = "";
  results.value = [];
  resultCount.value = 0;
  resultsComplete.value = false;
  try {
    const requestParams = searchRequest(model);
    const result = await ldapApi.searchStart(requestParams);
    if (request !== searchRequestSeq) {
      if (result.searchId) void ldapApi.searchCancel(result.searchId, requestedConnectionId).catch(() => {});
      return;
    }
    hasSearched.value = true;
    results.value = Array.isArray(result.entries) ? result.entries : [];
    resultCount.value = results.value.length;
    resultTruncated.value = false;
    resultsComplete.value = result.hasMore !== true;
    resultAtLimit.value = requestParams.sizeLimit !== undefined && resultCount.value === requestParams.sizeLimit;
    lastSizeLimit.value = requestParams.sizeLimit;
    activeSearchSession = !resultsComplete.value && result.searchId ? { id: result.searchId, connectionId: requestedConnectionId } : undefined;
    // 搜索成功才入历史（失败/竞态不记）：recordSearch 是 SearchForm 暴露的
    // 本地历史入队（去重 + localStorage），与 presets 的 sidecar 持久化互补。
    searchRef.value?.recordSearch?.(model);
    const anchorDn = results.value[0]?.dn;
    uiIntent.reportSnapshot({
      panel: "search",
      baseDn: model.baseDn,
      filter: model.filter,
      count: resultCount.value,
      truncated: resultTruncated.value,
      ...(anchorDn ? { anchor: anchorDn } : {}),
    });
    if (activeSearchSession) scheduleIdlePrefetch(request, activeSearchSession.id);
  } catch (cause) {
    if (request === searchRequestSeq) {
      resultsComplete.value = true;
      showError(cause, "search");
    }
  } finally {
    if (request === searchRequestSeq) searching.value = false;
  }
}

function retrySearch() {
  if (searchModel.value) void runSearch(searchModel.value);
}

function positiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

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

// 关联页签保持（round-4）：关联视图内点击成员/被引用条目 → openEntry 带
// "assoc" 打开新条目时保持关联页签，不再回落表单打断浏览流；树/结果表等
// 常规入口不传参，维持默认表单页签。
const editorInitialTab = ref<"ldif" | "assoc">();

// 最近打开条目（工具栏 History 下拉）：最新在前、大小写不敏感去重、上限 10 条。
// 记录点 = openEntry 的 entryGet 成功路径与 onEditorSaved（保存后 reopen 语义）；
// 属于单个连接的浏览状态，连接切换时随 auditItems 一并清空（P2-24 状态隔离）。
const RECENT_ENTRIES_MAX = 10;
const recentEntries = ref<string[]>([]);
function recordRecentEntry(dn: string) {
  const trimmed = dn.trim();
  if (!trimmed) return;
  const next = recentEntries.value.filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
  next.unshift(trimmed);
  recentEntries.value = next.slice(0, RECENT_ENTRIES_MAX);
}
// 下拉复用全局 .context-menu（fixed + z-50）：打开时按按钮位置算一次坐标即可
//（工具栏不滚动）；点击外部/Escape/再点按钮关闭，注册方式照抄 DnTree 右键菜单。
const recentButtonEl = ref<HTMLButtonElement>();
const recentMenuEl = ref<HTMLElement>();
let recentMenuTrigger: HTMLElement | null = null;
const recentMenu = ref<{ x: number; y: number }>();
function toggleRecentMenu() {
  if (recentMenu.value) {
    closeRecentMenu();
    recentMenuTrigger?.focus({ preventScroll: true });
    return;
  }
  const rect = recentButtonEl.value?.getBoundingClientRect();
  if (!rect) return;
  recentMenuTrigger = recentButtonEl.value ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  recentMenu.value = { x: rect.left, y: rect.bottom + 4 };
  void nextTick(() => recentMenuEl.value?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus({ preventScroll: true }));
}
function closeRecentMenu(restoreFocus = false) {
  recentMenu.value = undefined;
  if (restoreFocus) recentMenuTrigger?.focus({ preventScroll: true });
}
function closeRecentMenuFromDocument() {
  closeRecentMenu();
}
function openRecent(dn: string) {
  closeRecentMenu();
  void openEntry(dn);
}
// 行文本只显示首段 RDN，完整 DN 挂 title 悬停（长 DN 由行内 ellipsis 截断）。
function recentLabel(dn: string): string {
  return splitFirstDnRdn(dn).rdn || dn;
}
function onRecentMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeRecentMenu(true);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  event.stopPropagation();
  const items = Array.from(recentMenuEl.value?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") ?? []);
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (items.length === 0) return;
  const next = event.key === "ArrowUp" ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
  items[next]?.focus({ preventScroll: true });
}

async function openEntry(dn: string, initialTab?: "ldif" | "assoc") {
  const request = ++entryRequestSeq;
  const requestedConnection = connectionId.value;
  editorRequestedDn.value = dn;
  editorInitialTab.value = initialTab;
  editorLoadError.value = "";
  editorLoading.value = true;
  editorLoadingMore.value = false;
  editorDeferredLoading.value = false;
  editorDeferredAttributes.value = [];
  editorDeferredRequested.value = false;
  editorEntry.value = undefined;
  editorOpen.value = true;
  editorAddPrefill.value = undefined;
  ldapError.value = "";
  // A connection-scoped cache makes reopening a detail instantaneous, while
  // the following core read still refreshes it before any write is enabled.
  const cached = entryDetailCache.get(entryCacheKey(requestedConnection, dn));
  if (cached) {
    editorEntry.value = cached.entry;
    editorLoading.value = false;
  }
  try {
    // Render this response as soon as it arrives.  Never put schema or a full
    // entry request in front of this user-visible round trip.
    const result = await ldapApi.entryGet(dn, [...ENTRY_PRIORITY_ATTRIBUTES]);
    if (request !== entryRequestSeq || requestedConnection !== connectionId.value) return;
    editorEntry.value = result.entry;
    entryDetailCache.set(entryCacheKey(requestedConnection, dn), { entry: result.entry, fetchedAt: Date.now() });
    recordRecentEntry(dn);
    editorParentDn.value = "";
    editorOpen.value = true;
    uiIntent.reportSnapshot({ panel: "entry", anchor: dn });
    editorLoading.value = false;
    // Let Vue commit the core fields before issuing background work.  Besides
    // making the first paint observable, this prevents a slow schema request
    // from competing with the primary entry request.
    await nextTick();
    if (request !== entryRequestSeq || requestedConnection !== connectionId.value) return;
    void loadRegularEntryAttributes(dn, request, requestedConnection);
  } catch (cause) {
    if (request === entryRequestSeq && requestedConnection === connectionId.value) showError(cause, "entry");
  } finally {
    if (request === entryRequestSeq && requestedConnection === connectionId.value) editorLoading.value = false;
  }
}

function activeEntryRequest(request: number, requestedConnection: string): boolean {
  return request === entryRequestSeq && requestedConnection === connectionId.value && editorOpen.value;
}

function mergeEditorEntry(entry: LdapEntry, requestedConnection: string, dn: string) {
  const merged = mergeEntryAttributes(editorEntry.value, entry);
  editorEntry.value = merged;
  entryDetailCache.set(entryCacheKey(requestedConnection, dn), { entry: merged, fetchedAt: Date.now() });
}

function selectEntryAttributes(entry: LdapEntry, names: string[]): LdapEntry {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return {
    dn: entry.dn,
    attributes: Object.fromEntries(Object.entries(entry.attributes).filter(([name]) => wanted.has(name.toLowerCase()))),
  };
}

async function loadRegularEntryAttributes(dn: string, request: number, requestedConnection: string) {
  if (!activeEntryRequest(request, requestedConnection)) return;
  editorLoadingMore.value = true;
  try {
    // New sidecars return names with no values here.  Older sidecars ignore
    // `typesOnly`; that still degrades safely because we use the returned
    // values as the background full read, never as the first paint.
    const described = await ldapApi.entryGet(dn, ["*"], { typesOnly: true });
    if (!activeEntryRequest(request, requestedConnection)) return;
    const names = Object.keys(described.entry.attributes);
    const { regular, deferred } = partitionEntryAttributes(names);
    editorDeferredAttributes.value = deferred;
    const hasValues = Object.values(described.entry.attributes).some((values) => values.length > 0);
    if (hasValues) {
      mergeEditorEntry(selectEntryAttributes(described.entry, regular), requestedConnection, dn);
      return;
    }
    for (const batch of chunkEntryAttributes(regular)) {
      const result = await ldapApi.entryGet(dn, batch);
      if (!activeEntryRequest(request, requestedConnection)) return;
      mergeEditorEntry(result.entry, requestedConnection, dn);
    }
  } catch {
    // Old/strict sidecars may reject the optional typesOnly flag.  Preserve a
    // usable editor by falling back to one deferred full read and still avoid
    // exposing association/binary fields until the user asks for them.
    try {
      const fallback = await ldapApi.entryGet(dn);
      if (!activeEntryRequest(request, requestedConnection)) return;
      const { regular, deferred } = partitionEntryAttributes(Object.keys(fallback.entry.attributes));
      editorDeferredAttributes.value = deferred;
      mergeEditorEntry(selectEntryAttributes(fallback.entry, regular), requestedConnection, dn);
    } catch {
      // Core fields remain readable and editing becomes available; LDAP modify
      // is attribute-scoped, so absent fields cannot be deleted by this UI.
    }
  } finally {
    if (activeEntryRequest(request, requestedConnection)) {
      editorLoadingMore.value = false;
      if (editorDeferredRequested.value && editorDeferredAttributes.value.length > 0) void loadDeferredEditorAttributes();
      // Schema is useful for enhanced editors but is deliberately the lowest
      // priority task after visible entry data has been settled.
      void ensureDnAttributes();
    }
  }
}

async function loadDeferredEditorAttributes() {
  const dn = editorRequestedDn.value;
  const request = entryRequestSeq;
  const requestedConnection = connectionId.value;
  editorDeferredRequested.value = true;
  const names = [...editorDeferredAttributes.value];
  if (!dn || names.length === 0 || editorDeferredLoading.value || !activeEntryRequest(request, requestedConnection)) return;
  editorDeferredLoading.value = true;
  try {
    for (const batch of chunkEntryAttributes(names)) {
      const result = await ldapApi.entryGet(dn, batch);
      if (!activeEntryRequest(request, requestedConnection)) return;
      mergeEditorEntry(result.entry, requestedConnection, dn);
    }
    editorDeferredAttributes.value = [];
  } finally {
    if (activeEntryRequest(request, requestedConnection)) editorDeferredLoading.value = false;
  }
}

function openEntryFromDialog(dn: string) {
  const token = ++dialogOpenToken;
  void Promise.resolve().then(() => {
    // AssociationPanel emits the legacy openEntry event for compatibility and
    // the relation-specific event immediately after it. The latter cancels
    // this fallback so the source dialog remains the left/primary pane.
    if (token === dialogOpenToken) void openEntry(dn, "assoc");
  });
}

function closeReference() {
  referenceOpen.value = false;
  for (const tab of referenceTabs.value) tab.requestSeq++;
  referenceTabs.value = [];
  activeReferenceTabId.value = "";
}

async function openReferencedEntry(dn: string) {
  dialogOpenToken++;
  const existing = referenceTabs.value.find((tab) => tab.dn.toLowerCase() === dn.toLowerCase());
  if (existing) {
    activeReferenceTabId.value = existing.id;
    referenceOpen.value = true;
    return;
  }
  const tab: ReferenceTab = {
    id: `reference-${++nextReferenceTabId}`,
    dn,
    loading: true,
    loadError: "",
    loadErrorDetail: "",
    requestSeq: 0,
  };
  referenceTabs.value.push(tab);
  activeReferenceTabId.value = tab.id;
  referenceOpen.value = true;
  const request = ++tab.requestSeq;
  void ensureDnAttributes();
  try {
    const result = await ldapApi.entryGet(dn);
    if (!referenceTabs.value.includes(tab) || request !== tab.requestSeq) return;
    tab.entry = result.entry;
    recordRecentEntry(dn);
    uiIntent.reportSnapshot({ panel: "entry", anchor: dn });
  } catch (cause) {
    if (!referenceTabs.value.includes(tab) || request !== tab.requestSeq) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    tab.loadError = friendlyLdapError(message);
    tab.loadErrorDetail = tab.loadError === message ? "" : message;
  } finally {
    if (referenceTabs.value.includes(tab) && request === tab.requestSeq) tab.loading = false;
  }
}

function closeReferenceTab(id: string) {
  const index = referenceTabs.value.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  referenceTabs.value[index].requestSeq++;
  referenceTabs.value.splice(index, 1);
  if (referenceTabs.value.length === 0) {
    closeReference();
    return;
  }
  if (activeReferenceTabId.value === id) {
    activeReferenceTabId.value = referenceTabs.value[Math.max(0, index - 1)]?.id ?? referenceTabs.value[0].id;
  }
}

function selectReferenceTab(id: string) {
  if (referenceTabs.value.some((tab) => tab.id === id)) activeReferenceTabId.value = id;
}

function closeActiveReference() {
  if (activeReferenceTabId.value) closeReferenceTab(activeReferenceTabId.value);
  else closeReference();
}

function retryReference() {
  const dn = referenceRequestedDn.value;
  if (!dn) return;
  const tab = activeReferenceTab.value;
  if (!tab) return;
  tab.entry = undefined;
  tab.loadError = "";
  tab.loadErrorDetail = "";
  tab.loading = true;
  const request = ++tab.requestSeq;
  void ldapApi.entryGet(dn).then((result) => {
    if (!referenceTabs.value.includes(tab) || request !== tab.requestSeq) return;
    tab.entry = result.entry;
    tab.loading = false;
  }).catch((cause) => {
    if (!referenceTabs.value.includes(tab) || request !== tab.requestSeq) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    tab.loadError = friendlyLdapError(message);
    tab.loadErrorDetail = tab.loadError === message ? "" : message;
    tab.loading = false;
  });
}

// 左右详情属于一个复合会话：Esc 只关闭右侧引用，Tab 在两侧面板间循环。
useModalA11y(() => referenceOpen.value, {
  close: closeActiveReference,
  containerSelector: ".entry-relation-layout",
});

// 树右键「复制条目」（阶段3，ADS CopyEntriesRunnable 单条模式）：取源条目 →
// prepareCopyEntry 剔除密码/系统属性 → 编辑器 add 态预填（RDN 属性名保留、
// 值待填）；被剔除的属性经通知明示，不静默丢弃。
const editorAddPrefill = ref<{ rdn?: string; attributes: Record<string, string[]> }>();

async function onCopyEntry(dn: string) {
  const request = ++entryRequestSeq;
  ldapError.value = "";
  editorInitialTab.value = undefined;
  try {
    const result = await ldapApi.entryGet(dn);
    if (request !== entryRequestSeq) return;
    void ensureDnAttributes();
    const draft = prepareCopyEntry(
      { dn: result.entry.dn, attributes: result.entry.attributes },
      { attributeInfo: editorSchema.value?.attributeInfo },
    );
    editorEntry.value = undefined;
    editorRequestedDn.value = "";
    editorLoadError.value = "";
    editorLoading.value = false;
    editorAddPrefill.value = { rdn: draft.rdn, attributes: draft.attributes };
    editorParentDn.value = draft.parentDn;
    editorOpen.value = true;
    if (draft.skipped.length > 0) {
      showNotice(t("editor.copyEntrySkipped", { attributes: draft.skipped.join(", ") }));
    }
  } catch (cause) {
    if (request === entryRequestSeq) showError(cause, "entry");
  }
}

function closeEditor() {
  entryRequestSeq++;
  closeReference();
  editorOpen.value = false;
  editorLoading.value = false;
  editorLoadingMore.value = false;
  editorDeferredLoading.value = false;
  editorDeferredAttributes.value = [];
  editorDeferredRequested.value = false;
  editorLoadError.value = "";
}

// 树右键「成员」：立即以 (memberOf=<DN>) 在连接 Base 下子树搜索，
// 右侧结果表承接浏览（分页/排序/导出）；OpenLDAP 无 memberof overlay
// 时结果为空，组内成员仍可在条目编辑器「关联」页签直读 member 属性。
function searchMembersAt(dn: string) {
  searchRef.value?.runFilterAt(baseDn.value, `(memberOf=${escapeLdapFilterValue(dn)})`);
}

function openAddChild(parentDn: string) {
  wizardParentDn.value = parentDn || baseDn.value;
  wizardOpen.value = true;
  void wizardSchemaCache.ensureLoaded(connectionId.value);
}

// 向导提交 = 空白新增的模板化版本：payload 由向导铺好 must 属性。
async function onWizardCreate(payload: { dn: string; attributes: Record<string, string[]> }) {
  ldapError.value = "";
  try {
    await ldapApi.entryAdd(payload.dn, payload.attributes);
    wizardOpen.value = false;
    showNotice(t("editor.added"));
    treeRef.value?.invalidate(parentOf(payload.dn));
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
  invalidateEntryCache(dn);
  closeEditor();
  showNotice(mode_ === "add" ? t("editor.added") : t("editor.saved"));
  // 保存后 reopen 语义：保存动作本身也应把条目记入最近打开。
  recordRecentEntry(dn);
  treeRef.value?.invalidate(mode_ === "add" ? parentOf(dn) : dn);
  void openEntryRefresh(dn);
}

function onReferenceSaved(dn: string, mode_: "add" | "edit") {
  invalidateEntryCache(dn);
  const activeId = activeReferenceTabId.value;
  if (activeId) closeReferenceTab(activeId);
  showNotice(mode_ === "add" ? t("editor.added") : t("editor.saved"));
  recordRecentEntry(dn);
  treeRef.value?.invalidate(mode_ === "add" ? parentOf(dn) : dn);
}

async function openEntryRefresh(dn: string) {
  const request = entryRequestSeq;
  try {
    const result = await ldapApi.entryGet(dn);
    if (request !== entryRequestSeq || editorOpen.value) return;
    editorEntry.value = result.entry;
  } catch {
    // Entry may have been renamed/moved; keep the dialog closed.
  }
}

function parentOf(dn: string): string {
  const index = dn.indexOf(",");
  return index > 0 ? dn.slice(index + 1) : dn;
}

function askDelete(dn: string) {
  deleteDn.value = dn;
  deleteOpen.value = true;
}

async function confirmDelete(options?: { recursive?: boolean }) {
  if (!deleteDn.value || deleteSubmitting.value) return;
  deleteSubmitting.value = true;
  ldapError.value = "";
  try {
    // 递归标志由确认框勾选（有子条目才出现）；sidecar 优先走 Tree Delete
    // 控件、不支持时回退自底向上逐层删除（上限 1000 条）。
    const recursive = options?.recursive === true;
    await ldapApi.entryDelete(deleteDn.value, recursive);
    invalidateEntryCache(deleteDn.value, recursive);
    deleteOpen.value = false;
    showNotice(t("deleteDialog.deleted"));
    treeRef.value?.invalidate(parentOf(deleteDn.value));
    void refreshResultsAfterWrite((dn) => dn === deleteDn.value || dn.endsWith(`,${deleteDn.value}`));
  } catch (cause) {
    showError(cause);
  } finally {
    deleteSubmitting.value = false;
  }
}

function askRename(dn: string) {
  modifyDnSource.value = dn;
  modifyDnOpen.value = true;
}

async function confirmRename(newRdn: string, newParentDn: string | undefined, deleteOldRdn: boolean) {
  if (!modifyDnSource.value || modifyDnSubmitting.value) return;
  modifyDnSubmitting.value = true;
  ldapError.value = "";
  try {
    await ldapApi.entryModifyDn(modifyDnSource.value, newRdn, newParentDn, deleteOldRdn);
    invalidateEntryCache(modifyDnSource.value, true);
    invalidateEntryCache(`${newRdn},${newParentDn || parentOf(modifyDnSource.value)}`, true);
    modifyDnOpen.value = false;
    showNotice(t("modifyDn.moved"));
    treeRef.value?.invalidate();
    void refreshResultsAfterWrite((dn) => dn === modifyDnSource.value || dn.endsWith(`,${modifyDnSource.value}`));
  } catch (cause) {
    showError(cause);
  } finally {
    modifyDnSubmitting.value = false;
  }
}

// 导出子树单次抓取上限（条）：契约没有分页游标，前端无法逐页续拉；但
// pageSize>0 时 sidecar 会做服务端 paged search 聚合，聚合上限 = sizeLimit，
// 达上限截断并置 truncated=true。这里把导出上限提到契约计数上限量级
// （5000，与 ldap/count 一致，远大于此前硬编码 500），并消费 truncated：
// 仍被截断时通知明确告知"仅导出前 N 条"，不再静默残缺（UI 扫描 P1-3）。
const EXPORT_SIZE_LIMIT = 5000;
const EXPORT_PAGE_SIZE = 500;

async function exportSubtree(dn: string) {
  ldapError.value = "";
  try {
    const result = await ldapApi.search({ baseDn: dn, filter: "(objectClass=*)", scope: "sub", sizeLimit: EXPORT_SIZE_LIMIT, pageSize: EXPORT_PAGE_SIZE });
    const outcome = await saveTextFile({ name: `${rdnOf(dn) || "subtree"}.ldif`, contentType: "text/plain", text: serializeEntriesToLdifText(result.entries) });
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

function rdnOf(dn: string): string {
  const index = dn.indexOf(",");
  return index > 0 ? dn.slice(0, index) : dn;
}

async function showRootDse() {
  ldapError.value = "";
  try {
    const result = await ldapApi.rootDse();
    const attributes = result.attributes || {};
    const lines = Object.keys(attributes)
      .sort()
      .map((name) => `${name}: ${(attributes[name] ?? []).join(", ")}`);
    const outcome = await saveTextFile({ name: "root-dse.txt", contentType: "text/plain", text: lines.join("\n") });
    notifyExportSaved(outcome);
  } catch (cause) {
    showError(cause);
  }
}

async function copyDn(dn: string) {
  // 桥缺失或写入失败要如实反馈（此前 catch 也提示"已复制"）。
  showNotice((await writeClipboardText(dn)) ? t("copied") : t("copyFailed"));
}

function handleEvent(event: DbxPluginEvent) {
  if (event.type === "env") {
    if (typeof event.locale === "string") setWorkbenchLocale(event.locale || "zh-CN");
    return;
  }
  if (event.method === "ldap/audit") {
    const params = event.params || {};
    // 数据面：进入最近操作面板（denied/error 高亮）；即时反馈走横幅/通知。
    auditItems.value = pushAuditItem(auditItems.value, parseAuditEvent(params, auditSeq++, Date.now()));
    const result = String(params.result ?? "");
    if (result === "denied" || result === "error") {
      showError(`${params.action ?? "ldap"}: ${result}`);
    } else {
      showNotice(`${params.action ?? "ldap"} ✓`);
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
    cancelActiveSearchSession();
    closeEditor();
    editorAddPrefill.value = undefined;
    searchRequestSeq++;
    searching.value = false;
    searchError.value = "";
    deleteOpen.value = false;
    modifyDnOpen.value = false;
    batchMoveOpen.value = false;
    wizardOpen.value = false;
    // DN 属性名集合属于上一个连接的 schema，随连接切换一并失效重取。
    dnAttributes.value = [];
    editorSchema.value = undefined;
    dnAttributesReady = false;
    results.value = [];
    resultCount.value = 0;
    resultTruncated.value = false;
    resultsComplete.value = true;
    loadingMore.value = false;
    loadMoreError.value = "";
    loadMoreErrorDetail.value = "";
    resultAtLimit.value = false;
    hasSearched.value = false;
    searchModel.value = undefined;
    // 最近操作面板同属上一个连接（round-4）：残留会让新连接的写操作反馈
    // 与旧连接的 denied/ok 事件混在一起，误导排查。
    auditItems.value = [];
    // 最近打开条目同样是上一个连接的浏览状态（DN 只在原目录里有意义）。
    recentEntries.value = [];
    entryDetailCache.clear();
  }
  baseDn.value = contextBaseDn.value;
  void resolveAutoBaseDn();
  // Schema is intentionally not warmed here: a user-visible entry read must
  // always win over metadata.  The wizard and entry detail loaders request it
  // lazily after their own primary data is visible.
}

// 方言 → 显示名（vendor 缺失时兜底）。
const DIALECT_LABELS: Record<string, string> = {
  ad: "Active Directory",
  openldap: "OpenLDAP",
  "389ds": "389 Directory Server",
  freeipa: "FreeIPA",
  rfc4511: "LDAPv3",
};

const serverBadge = computed(() => {
  const info = wizardSchemaCache.serverInfo.value;
  if (!info) return "";
  const label = info.vendorName || DIALECT_LABELS[info.dialect ?? ""] || "";
  return label.trim();
});

// 协议/认证徽章（对标 ADS 连接标识）：字段来自 manifest binding: config 的
// external_config.tls_mode（none/starttls/ldaps）与 auth_type（anonymous/
// unauthenticated/simple/kerberos/ntlm/ntlm_hash/digest_md5/external），
// 端口取连接摘要（636 视为 LDAPS）。字段与端口全缺时无从推导，不显示徽章；
// 结构异常静默返回空串——徽章只是装饰，绝不能把工作台初始化弄挂。
const AUTH_BADGE_LABELS: Record<string, string> = {
  anonymous: "Anonymous",
  kerberos: "GSSAPI",
  ntlm: "NTLM",
  ntlm_hash: "NTLM",
  digest_md5: "DIGEST-MD5",
};

function normalizePort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

const protocolBadge = computed(() => {
  try {
    const external = connection.value.external_config;
    const config = external && typeof external === "object" ? (external as Record<string, unknown>) : undefined;
    const rawTlsMode = config?.tls_mode;
    const tlsMode = typeof rawTlsMode === "string" ? rawTlsMode.trim().toLowerCase() : "";
    const rawAuthType = config?.auth_type;
    const authType = typeof rawAuthType === "string" ? rawAuthType.trim().toLowerCase() : "";
    const port = normalizePort(connection.value.port);
    if (!tlsMode && !authType && port === undefined) return "";
    const segments: string[] = [];
    if (tlsMode === "ldaps" || port === 636) segments.push("LDAPS");
    else if (tlsMode === "starttls") segments.push("LDAP+TLS");
    else segments.push("LDAP");
    // 认证段：字段缺失省略；unauthenticated/external 等其余取值兜底 Simple。
    if (authType) segments.push(AUTH_BADGE_LABELS[authType] ?? "Simple");
    return segments.join(" · ");
  } catch {
    return "";
  }
});

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

// 最近条目下拉的关闭监听：延后到 setTimeout 0 再挂，避免注册瞬间的点击
// 事件立刻触发关闭（照 DnTree 右键菜单的注册/清理模式）。
window.setTimeout(() => {
  document.addEventListener("click", closeRecentMenuFromDocument);
  document.addEventListener("keydown", onRecentMenuKeydown);
}, 0);

onBeforeUnmount(() => {
  searchRequestSeq++;
  cancelActiveSearchSession();
  entryRequestSeq++;
  closeReference();
  window.clearTimeout(noticeTimer);
  uiIntent.stop();
  teardownTooltipLayer();
  document.removeEventListener("click", closeRecentMenuFromDocument);
  document.removeEventListener("keydown", onRecentMenuKeydown);
  for (const dispose of [...unsubscribeAppearance, ...unsubscribeLocale, ...unsubscribeContext, ...unsubscribeEvent]) dispose();
});
</script>

<template>
  <div class="workbench">
    <header class="toolbar" :style="toolbarStyle">
      <div class="identity">
        <span class="connection-color" :style="connection.color ? { background: connection.color } : undefined" />
        <strong :title="identityText">{{ identityText }}</strong>
        <span v-if="protocolBadge" class="badge mono identity-protocol" :title="t('protocol.badge')">{{ protocolBadge }}</span>
        <span v-if="!canWrite" class="read-only-badge">{{ t("readOnly") }}</span>
        <Loader2 v-if="!ready && !initError" class="icon-neutral spinning" aria-hidden="true" />
      </div>
      <div class="toolbar-actions">
        <button class="toolbar-button" :disabled="!ready" :title="t('rootDse.title')" @click="showRootDse">
          <Info aria-hidden="true" /><span>{{ t("rootDse.title") }}</span>
        </button>
        <button class="toolbar-button" :disabled="!ready" :title="t('schema.title')" @click="schemaOpen = true">
          <Database class="icon-violet" aria-hidden="true" /><span>{{ t("schema.title") }}</span>
        </button>
        <button class="toolbar-button" :disabled="!ready" :title="t('connections.title')" @click="connectionsOpen = true">
          <Network class="icon-cyan" aria-hidden="true" /><span>{{ t("connections.title") }}</span>
        </button>
        <button class="toolbar-button" :disabled="!ready" :title="t('ldap.importEntry.title')" @click="importOpen = true">
          <FileUp class="icon-cyan" aria-hidden="true" /><span>{{ t("ldap.importEntry.toolbar") }}</span>
        </button>
        <button
          ref="recentButtonEl"
          class="icon-button"
          :disabled="!ready || recentEntries.length === 0"
          :title="t('recent.title')"
          :aria-label="t('recent.title')"
          @click.stop="toggleRecentMenu"
        >
          <History aria-hidden="true" />
        </button>
        <span v-if="serverBadge" class="badge mono" :title="t('connections.title')">{{ serverBadge }}</span>
        <span class="toolbar-separator" />
        <button class="icon-button" :disabled="!ready" :title="t('refresh')" @click="refreshTree">
          <RefreshCw aria-hidden="true" />
        </button>
        <button class="icon-button" :disabled="!ready || results.length === 0 || !resultsComplete" :title="resultsComplete ? t('result.exportLdif') : t('result.exportIncomplete')" @click="exportResults('ldif')">
          <Download aria-hidden="true" />
        </button>
      </div>
    </header>

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
          @retry="retrySearch"
          @load-more="requestNextSearchPage"
          @retry-more="requestNextSearchPage"
          @open="openEntry"
          @export="exportResults"
          @notify="showNotice"
          @batch-delete="onBatchDelete"
          @batch-move="onBatchMove"
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
              <span :title="editorRequestedDn">{{ editorRequestedDn }}</span>
            </div>
            <button class="icon-button" :title="t('close')" :aria-label="t('close')" @click="closeEditor">
              <X aria-hidden="true" />
            </button>
          </header>
          <div class="entry-relation-pane">
            <div class="entry-relation-label">
              <strong>{{ t("editor.relationSource") }}</strong>
              <span :title="editorRequestedDn">{{ editorRequestedDn }}</span>
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
          <div class="entry-relation-connector" aria-hidden="true">→</div>
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
                >{{ splitFirstDnRdn(tab.dn).rdn || tab.dn }}</button>
                <button type="button" class="entry-relation-tab-close" :title="t('close')" :aria-label="t('close')" @click.stop="closeReferenceTab(tab.id)">
                  <X aria-hidden="true" />
                </button>
              </div>
            </div>
            <div class="entry-relation-label">
              <strong>{{ t("editor.relationTarget") }}</strong>
              <span :title="referenceRequestedDn">{{ referenceRequestedDn }}</span>
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
      @close="closeEditor"
      @retry="openEntry(editorRequestedDn, editorInitialTab)"
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
    <NewEntryWizard
      :open="wizardOpen"
      :parent-dn="wizardParentDn"
      :schema="wizardSchema"
      @submit="onWizardCreate"
      @cancel="wizardOpen = false"
    />
    <SchemaPanel :open="schemaOpen" :connection-id="getLdapConnectionId()" @close="schemaOpen = false" @error="showError" />
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

    <!-- 最近打开条目下拉：Teleport 到 body + 复用全局 .context-menu（fixed 定位），
         坐标由 toggleRecentMenu 按按钮 getBoundingClientRect 在打开时算一次；
         全部用既有 class + 内联样式，不新增全局 CSS。 -->
    <Teleport to="body">
      <div
        v-if="recentMenu"
        ref="recentMenuEl"
        class="context-menu context-menu--recent"
        role="menu"
        tabindex="-1"
        :style="{ left: `${recentMenu.x}px`, top: `${recentMenu.y}px`, width: '360px', maxWidth: 'calc(100vw - 16px)' }"
        @click.stop
        @keydown="onRecentMenuKeydown"
      >
        <div class="context-menu-heading">
          <History class="context-menu-heading-icon" aria-hidden="true" />
          <span>{{ t("recent.title") }}</span>
        </div>
        <button v-if="recentEntries.length === 0" disabled>
          <FileText class="context-menu-item-icon" aria-hidden="true" />
          <span>{{ t("recent.empty") }}</span>
        </button>
        <button v-for="dn in recentEntries" :key="dn" role="menuitem" :title="dn" @click="openRecent(dn)">
          <FileText class="context-menu-item-icon" aria-hidden="true" />
          <span class="context-menu-item-label">{{ recentLabel(dn) }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
