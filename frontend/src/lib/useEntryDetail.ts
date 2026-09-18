import { nextTick, ref } from "vue";
import { ldapApi, type LdapEntry } from "./api";
import { friendlyLdapError } from "./ldapErrors";
import { prepareCopyEntry } from "./copyEntry";
import { t } from "./i18n";
import type { LdapSchema } from "./newEntryTemplates";
import { chunkEntryAttributes, ENTRY_PRIORITY_ATTRIBUTES, mergeEntryAttributes, partitionEntryAttributes } from "./stagedEntry";

/**
 * 条目编辑器会话（从 App.vue 抽出）：详情读取的三段式渐进加载（核心字段 →
 * 常规字段分批 → 关联/二进制按需），连接级详情缓存（LRU 上限 50，审计 K-4），
 * 复制条目预填与关闭守卫。保存/删除/移动后的缓存失效统一走 `invalidate`
 * （F5 事件总线驱动）。
 */

/** `dialogToken` 由 App.vue 持有并与关联视图共享：引用视图打开时递增，
 * 使 AssociationPanel 遗留 openEntry 事件的兜底打开自然失效。 */
export interface UseEntryDetailOptions {
  getConnectionId: () => string;
  dialogToken: { value: number };
  clearBanner: () => void;
  onBannerError: (cause: unknown) => void;
  onSnapshot: (payload: Record<string, unknown>) => void;
  onRecent: (dn: string) => void;
  onNotice: (message: string) => void;
  getEditorSchema: () => LdapSchema | undefined;
  ensureDnAttributes: () => void;
}

interface CacheSlot {
  entry: LdapEntry;
  fetchedAt: number;
}

/** 详情缓存上限（条，审计 K-4）：无限增长会在长会话里驻留整本目录的条目。 */
export const ENTRY_DETAIL_CACHE_LIMIT = 50;

/** LRU 写入（Map 插入序实现）：命中先删再插保持最新位，超限淘汰最旧；导出仅供单测。 */
export function lruSet<V>(cache: Map<string, V>, key: string, value: V, limit: number): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

/** LRU 命中触碰：把既有键移到最新位，避免活跃条目被后续写入挤出；导出仅供单测。 */
export function lruTouch<V>(cache: Map<string, V>, key: string): void {
  const value = cache.get(key);
  if (value === undefined) return;
  cache.delete(key);
  cache.set(key, value);
}

export function useEntryDetail(options: UseEntryDetailOptions) {
  const {
    getConnectionId,
    dialogToken,
    clearBanner,
    onBannerError,
    onSnapshot,
    onRecent,
    onNotice,
    getEditorSchema,
    ensureDnAttributes,
  } = options;

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
  const entryDetailCache = new Map<string, CacheSlot>();
  const editorAddPrefill = ref<{ rdn?: string; attributes: Record<string, string[]> }>();
  // 关联页签保持（round-4）：关联视图内点击成员/被引用条目 → openEntry 带
  // "assoc" 打开新条目时保持关联页签，不再回落表单打断浏览流；树/结果表等
  // 常规入口不传参，维持默认表单页签。
  const editorInitialTab = ref<"ldif" | "assoc">();

  function entryCacheKey(connection: string, dn: string): string {
    return `${connection}\u0000${dn.trim().toLowerCase()}`;
  }

  /** 写操作后的缓存失效（原本散落在各写路径的手工调用收口于此）。 */
  function invalidate(dn: string, descendants = false) {
    const connection = getConnectionId();
    const normalized = dn.trim().toLowerCase();
    for (const key of entryDetailCache.keys()) {
      const [cachedConnection, cachedDn] = key.split("\u0000", 2);
      if (cachedConnection === connection && (cachedDn === normalized || (descendants && cachedDn.endsWith(`,${normalized}`)))) {
        entryDetailCache.delete(key);
      }
    }
  }

  function clear() {
    entryDetailCache.clear();
  }

  async function openEntry(dn: string, initialTab?: "ldif" | "assoc") {
    const request = ++entryRequestSeq;
    const requestedConnection = getConnectionId();
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
    clearBanner();
    // A connection-scoped cache makes reopening a detail instantaneous, while
    // the following core read still refreshes it before any write is enabled.
    const cacheKey = entryCacheKey(requestedConnection, dn);
    const cached = entryDetailCache.get(cacheKey);
    if (cached) {
      // LRU 触碰：命中即移到最新位（审计 K-4）。
      lruTouch(entryDetailCache, cacheKey);
      editorEntry.value = cached.entry;
      editorLoading.value = false;
    }
    try {
      // Render this response as soon as it arrives.  Never put schema or a full
      // entry request in front of this user-visible round trip.
      const result = await ldapApi.entryGet(dn, [...ENTRY_PRIORITY_ATTRIBUTES]);
      if (request !== entryRequestSeq || requestedConnection !== getConnectionId()) return;
      editorEntry.value = result.entry;
      lruSet(entryDetailCache, entryCacheKey(requestedConnection, dn), { entry: result.entry, fetchedAt: Date.now() }, ENTRY_DETAIL_CACHE_LIMIT);
      onRecent(dn);
      editorParentDn.value = "";
      editorOpen.value = true;
      onSnapshot({ panel: "entry", anchor: dn });
      editorLoading.value = false;
      // Let Vue commit the core fields before issuing background work.  Besides
      // making the first paint observable, this prevents a slow schema request
      // from competing with the primary entry request.
      await nextTick();
      if (request !== entryRequestSeq || requestedConnection !== getConnectionId()) return;
      void loadRegularEntryAttributes(dn, request, requestedConnection);
    } catch (cause) {
      if (request === entryRequestSeq && requestedConnection === getConnectionId()) {
        const message = cause instanceof Error ? cause.message : String(cause);
        editorLoadError.value = friendlyLdapError(message);
        editorLoadErrorDetail.value = message;
      }
    } finally {
      if (request === entryRequestSeq && requestedConnection === getConnectionId()) editorLoading.value = false;
    }
  }

  function activeEntryRequest(request: number, requestedConnection: string): boolean {
    return request === entryRequestSeq && requestedConnection === getConnectionId() && editorOpen.value;
  }

  function mergeEditorEntry(entry: LdapEntry, requestedConnection: string, dn: string) {
    const merged = mergeEntryAttributes(editorEntry.value, entry);
    editorEntry.value = merged;
    lruSet(entryDetailCache, entryCacheKey(requestedConnection, dn), { entry: merged, fetchedAt: Date.now() }, ENTRY_DETAIL_CACHE_LIMIT);
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
        ensureDnAttributes();
      }
    }
  }

  async function loadDeferredEditorAttributes() {
    const dn = editorRequestedDn.value;
    const request = entryRequestSeq;
    const requestedConnection = getConnectionId();
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
    const token = ++dialogToken.value;
    void Promise.resolve().then(() => {
      // AssociationPanel emits the legacy openEntry event for compatibility and
      // the relation-specific event immediately after it. The latter cancels
      // this fallback so the source dialog remains the left/primary pane.
      if (token === dialogToken.value) void openEntry(dn, "assoc");
    });
  }

  // 树右键「复制条目」（阶段3，ADS CopyEntriesRunnable 单条模式）：取源条目 →
  // prepareCopyEntry 剔除密码/系统属性 → 编辑器 add 态预填（RDN 属性名保留、
  // 值待填）；被剔除的属性经通知明示，不静默丢弃。
  async function openCopyEntry(dn: string) {
    const request = ++entryRequestSeq;
    clearBanner();
    editorInitialTab.value = undefined;
    try {
      const result = await ldapApi.entryGet(dn);
      if (request !== entryRequestSeq) return;
      ensureDnAttributes();
      const draft = prepareCopyEntry(
        { dn: result.entry.dn, attributes: result.entry.attributes },
        { attributeInfo: getEditorSchema()?.attributeInfo },
      );
      editorEntry.value = undefined;
      editorRequestedDn.value = "";
      editorLoadError.value = "";
      editorLoading.value = false;
      editorAddPrefill.value = { rdn: draft.rdn, attributes: draft.attributes };
      editorParentDn.value = draft.parentDn;
      editorOpen.value = true;
      if (draft.skipped.length > 0) {
        onNotice(t("editor.copyEntrySkipped", { attributes: draft.skipped.join(", ") }));
      }
    } catch (cause) {
      if (request === entryRequestSeq) onBannerError(cause);
    }
  }

  function closeEditor() {
    entryRequestSeq++;
    editorOpen.value = false;
    editorLoading.value = false;
    editorLoadingMore.value = false;
    editorDeferredLoading.value = false;
    editorDeferredAttributes.value = [];
    editorDeferredRequested.value = false;
    editorLoadError.value = "";
  }

  function dispose() {
    entryRequestSeq++;
  }

  return {
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
    closeEditor,
    invalidate,
    clear,
    dispose,
  };
}
