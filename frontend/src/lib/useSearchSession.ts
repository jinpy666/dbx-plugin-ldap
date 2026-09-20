import { computed, ref } from "vue";
import { ldapApi, type LdapEntry, type LdapSearchRequest, type LdapSortOrder } from "./api";
import { friendlyLdapError } from "./ldapErrors";
import { t } from "./i18n";
import type { UiIntentSummary } from "../../../shared/frontend/uiIntent";

/**
 * 搜索会话（从 App.vue 抽出）：start/next/cancel 游标生命周期、自动续拉、
 * 竞态守卫（requestSeq + connectionId 双闸）、空结果两态与"整页上限"提示态。
 * App.vue 只负责把 SearchForm/ResultTable 绑到这里的响应式状态上。
 */
export interface SearchFormModel {
  baseDn: string;
  filter: string;
  scope: "base" | "one" | "sub";
  attributes: string;
  sizeLimit: string;
  pageSize: string;
  typesOnly: boolean;
  derefAliases: "never" | "searching" | "finding" | "always";
  /** RFC 2891 服务器端排序属性（空 = 不请求排序，后端不注入排序控件）。 */
  sortBy: string;
  /** 排序方向；仅 sortBy 非空时随请求下发。 */
  sortOrder: LdapSortOrder;
}

export type SearchIntentSummary = UiIntentSummary;

export interface UseSearchSessionOptions {
  getConnectionId: () => string;
  /** 写操作前清横幅的既有语义（原 App.vue 各写路径先 ldapError.value = ""）。 */
  clearBanner: () => void;
  /** 搜索成功后的 MCP intent 快照回报。 */
  onSnapshot: (payload: Record<string, unknown>) => void;
  /** 搜索成功才入历史（SearchForm.recordSearch 的本地历史）。 */
  onHistory: (model: SearchFormModel) => void;
  /** 可选一次性通知（RFC 2891 排序降级提示；缺省不弹，旧调用方无感）。 */
  onNotice?: (message: string) => void;
}

/** 结果摘要：count + 前 5 行（每 cell 截 120 字符，DN 定位字段不截断）。 */
const INTENT_CELL_WIDTH = 120;

export function useSearchSession(options: UseSearchSessionOptions) {
  const { getConnectionId, clearBanner, onSnapshot, onHistory, onNotice } = options;

  const searchModel = ref<SearchFormModel>();
  const results = ref<LdapEntry[]>([]);
  const resultCount = ref(0);
  const resultTruncated = ref(false);
  // 延续引用 URI（referral report 语义）：后端每页响应都带会话级累计列表，
  // 这里以最新响应为准（referral 不追随，仅提示目录树延伸到其他服务器）。
  const resultReferrals = ref<string[]>([]);
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
  // 空结果两态（UI 扫描 P2-3）：执行过搜索后的 0 条 ≠ "请先执行搜索"。
  const hasSearched = ref(false);
  // 恰好等于 sizeLimit 的"整页结果"信号（UI 扫描 P2-15）：契约 truncated 只在
  // 后端真实截断时为 true，夹具/真机都可能出现"count===上限但 truncated=false"
  // 的巧合态——此时给"可能不完整"提示而不是假装完整。
  const resultAtLimit = ref(false);
  // 最近一次搜索的 sizeLimit（P2-15 提示文案需要展示上限值）。
  const lastSizeLimit = ref<number>();

  function cancelActiveSearchSession() {
    const session = activeSearchSession;
    activeSearchSession = undefined;
    if (session) void ldapApi.searchCancel(session.id, session.connectionId).catch(() => {});
  }

  // 游标排空的提交节奏（审计 K-2）：每页全量重提交会让 ResultTable 每页重建
  // 全部行 VM 并触发 ag-grid 整表重排序。这里先累积到局部数组，每 2 页或
  // 250ms 才提交一次；结束/失败/中断路径保证最终提交一次，不丢已拉取的页。
  const DRAIN_COMMIT_PAGES = 2;
  const DRAIN_COMMIT_INTERVAL_MS = 250;

  async function loadNextSearchPage() {
    const session = activeSearchSession;
    const request = searchRequestSeq;
    if (!session || loadingMore.value) return;
    loadingMore.value = true;
    loadMoreError.value = "";
    loadMoreErrorDetail.value = "";
    const pending: LdapEntry[] = [];
    let pagesSinceCommit = 0;
    let lastCommitAt = Date.now();
    const commitPending = () => {
      if (pending.length === 0) return;
      // Keep every page in server cursor order. Do not re-query with a larger
      // limit or de-duplicate locally: either would risk skipping real entries.
      results.value = [...results.value, ...pending];
      pending.length = 0;
      resultCount.value = results.value.length;
      pagesSinceCommit = 0;
      lastCommitAt = Date.now();
    };
    try {
      // Consume the cursor continuously. The grid may still render its own
      // local pages, but users should never have to click once per server page.
      while (request === searchRequestSeq && activeSearchSession?.id === session.id) {
        const page = await ldapApi.searchNext(session.id, session.connectionId);
        if (request !== searchRequestSeq || activeSearchSession?.id !== session.id) return;
        pending.push(...(Array.isArray(page.entries) ? page.entries : []));
        if (Array.isArray(page.referrals)) resultReferrals.value = page.referrals;
        resultsComplete.value = page.hasMore !== true;
        if (resultsComplete.value) {
          activeSearchSession = undefined;
          commitPending();
          break;
        }
        if (++pagesSinceCommit >= DRAIN_COMMIT_PAGES || Date.now() - lastCommitAt >= DRAIN_COMMIT_INTERVAL_MS) commitPending();
      }
    } catch (cause) {
      if (request === searchRequestSeq && activeSearchSession?.id === session.id) {
        // 中途失败也先把已拉到的页提交出来（部分结果保持可见），再给重试入口。
        commitPending();
        const message = cause instanceof Error ? cause.message : String(cause);
        loadMoreError.value = friendlyLdapError(message);
        loadMoreErrorDetail.value = message;
      }
    } finally {
      if (request === searchRequestSeq) loadingMore.value = false;
    }
  }

  function requestNextSearchPage() {
    // Normally the cursor is drained automatically. This remains as a recovery
    // path when a later page failed and the user explicitly retries it.
    void loadNextSearchPage();
  }

  function toRequest(model: SearchFormModel): LdapSearchRequest {
    const attributes = model.attributes
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const requestedPageSize = positiveInt(model.pageSize) ?? 500;
    // RFC 2891 服务器端排序：sortBy 空缺省不发排序字段（后端不注入排序控件）；
    // sortOrder 仅在排序生效时随请求下发（asc|desc）。
    const sortBy = model.sortBy.trim();
    return {
      baseDn: model.baseDn.trim() || undefined,
      filter: model.filter.trim() || "(objectClass=*)",
      scope: model.scope,
      ...(attributes.length > 0 ? { attributes } : {}),
      sizeLimit: positiveInt(model.sizeLimit),
      // This is the LDAP transport page size, independent from the grid's local
      // display pagination. The cursor is drained automatically after the first
      // page, so a default search of 500 entries does not become ten clicks.
      pageSize: requestedPageSize,
      typesOnly: model.typesOnly,
      derefAliases: model.derefAliases,
      ...(sortBy ? { sortBy, sortOrder: model.sortOrder } : {}),
    };
  }

  async function runSearch(model: SearchFormModel) {
    const request = ++searchRequestSeq;
    const requestedConnectionId = getConnectionId();
    cancelActiveSearchSession();
    searching.value = true;
    loadingMore.value = false;
    searchModel.value = { ...model };
    searchError.value = "";
    loadMoreError.value = "";
    loadMoreErrorDetail.value = "";
    clearBanner();
    results.value = [];
    resultCount.value = 0;
    resultReferrals.value = [];
    resultsComplete.value = false;
    try {
      const requestParams = toRequest(model);
      const result = await ldapApi.searchStart(requestParams);
      if (request !== searchRequestSeq) {
        if (result.searchId) void ldapApi.searchCancel(result.searchId, requestedConnectionId).catch(() => {});
        return;
      }
      hasSearched.value = true;
      results.value = Array.isArray(result.entries) ? result.entries : [];
      resultCount.value = results.value.length;
      resultReferrals.value = Array.isArray(result.referrals) ? result.referrals : [];
      resultTruncated.value = false;
      resultsComplete.value = result.hasMore !== true;
      resultAtLimit.value = requestParams.sizeLimit !== undefined && resultCount.value === requestParams.sizeLimit;
      lastSizeLimit.value = requestParams.sizeLimit;
      // RFC 2891 优雅降级一次性提示：服务器回非零 SortResult 时结果未按请求
      // 排序（属性不支持/服务器拒绝），条目照常展示，只提示不报错。0/缺省
      // 字段（旧 sidecar）不触发。
      const sortResult = typeof result.sortResult === "number" ? result.sortResult : 0;
      if (sortResult !== 0) onNotice?.(t("result.sortDegraded", { code: sortResult }));
      activeSearchSession = !resultsComplete.value && result.searchId ? { id: result.searchId, connectionId: requestedConnectionId } : undefined;
      // 搜索成功才入历史（失败/竞态不记）：recordSearch 是 SearchForm 暴露的
      // 本地历史入队（去重 + localStorage），与 presets 的 sidecar 持久化互补。
      onHistory(model);
      const anchorDn = results.value[0]?.dn;
      onSnapshot({
        panel: "search",
        baseDn: model.baseDn,
        filter: model.filter,
        count: resultCount.value,
        truncated: resultTruncated.value,
        ...(anchorDn ? { anchor: anchorDn } : {}),
      });
      if (activeSearchSession) void loadNextSearchPage();
    } catch (cause) {
      if (request === searchRequestSeq) {
        resultsComplete.value = true;
        const message = cause instanceof Error ? cause.message : String(cause);
        searchError.value = friendlyLdapError(message);
        searchErrorDetail.value = message;
      }
    } finally {
      if (request === searchRequestSeq) searching.value = false;
    }
  }

  function retrySearch() {
    if (searchModel.value) void runSearch(searchModel.value);
  }

  // 写操作后的结果表联动（UI 扫描 P2-25）：被删/改名条目仍在当前结果里时
  // 重放最近一次搜索，避免残留行双击报 entry not found。无搜索史则跳过。
  async function refreshAfterWrite(affected: (dn: string) => boolean) {
    if (!hasSearched.value || !searchModel.value) return;
    if (!results.value.some((entry) => affected(entry.dn))) return;
    await runSearch(searchModel.value);
  }

  /** MCP intent 搜索摘要：count + 前 5 行摘要行（cell 截断见常量）。 */
  const summarize = computed<SearchIntentSummary>(() => {
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
  });

  /** 连接切换时的会话隔离（UI 扫描 P2-24）：结果/游标/错误态全部归零。 */
  function reset() {
    cancelActiveSearchSession();
    searchRequestSeq++;
    searching.value = false;
    searchError.value = "";
    loadingMore.value = false;
    loadMoreError.value = "";
    loadMoreErrorDetail.value = "";
    results.value = [];
    resultCount.value = 0;
    resultReferrals.value = [];
    resultTruncated.value = false;
    resultsComplete.value = true;
    resultAtLimit.value = false;
    hasSearched.value = false;
    searchModel.value = undefined;
  }

  function dispose() {
    searchRequestSeq++;
    cancelActiveSearchSession();
  }

  return {
    searchModel,
    results,
    resultCount,
    resultTruncated,
    resultReferrals,
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
    reset,
    dispose,
  };
}

function positiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
