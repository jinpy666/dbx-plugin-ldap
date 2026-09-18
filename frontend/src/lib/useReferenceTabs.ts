import { computed, ref } from "vue";
import { ldapApi } from "./api";
import { friendlyLdapError } from "./ldapErrors";
import { useModalA11y } from "./modal";

/**
 * 条目关联双栏会话（从 App.vue 抽出）：左侧保留发起引用的详情，右侧以标签页
 * 独立加载被引用条目。每个引用标签都有自己的请求序号，加载/失败/重试不会
 * 覆盖主条目或其他标签。打开引用时会递增共享 dialogToken，使编辑器侧的
 * 遗留 openEntry 兜底打开自然失效。页签数有上限（REFERENCE_TAB_LIMIT），
 * 超限自动淘汰最旧的非活跃页签，避免长会话无界增长。
 */
export interface ReferenceTab {
  id: string;
  dn: string;
  attribute?: string;
  entry?: import("./api").LdapEntry;
  loading: boolean;
  loadError: string;
  loadErrorDetail: string;
  requestSeq: number;
}

export interface UseReferenceTabsOptions {
  dialogToken: { value: number };
  onSnapshot: (payload: Record<string, unknown>) => void;
  onRecent: (dn: string) => void;
  ensureDnAttributes: () => void;
}

/** 引用页签上限：打开超限的新引用时自动淘汰最旧的非活跃页签（审计 K-4 同类）。 */
export const REFERENCE_TAB_LIMIT = 10;

export function useReferenceTabs(options: UseReferenceTabsOptions) {
  const { dialogToken, onSnapshot, onRecent, ensureDnAttributes } = options;

  const referenceOpen = ref(false);
  const referenceTabs = ref<ReferenceTab[]>([]);
  const activeReferenceTabId = ref("");
  let nextReferenceTabId = 0;
  const activeReferenceTab = computed(() => referenceTabs.value.find((tab) => tab.id === activeReferenceTabId.value));
  const referenceEntry = computed(() => activeReferenceTab.value?.entry);
  const referenceRequestedDn = computed(() => activeReferenceTab.value?.dn ?? "");
  const referenceAttribute = computed(() => activeReferenceTab.value?.attribute ?? "");
  const referenceLoading = computed(() => activeReferenceTab.value?.loading ?? false);
  const referenceLoadError = computed(() => activeReferenceTab.value?.loadError ?? "");
  const referenceLoadErrorDetail = computed(() => activeReferenceTab.value?.loadErrorDetail ?? "");

  function closeReference() {
    referenceOpen.value = false;
    for (const tab of referenceTabs.value) tab.requestSeq++;
    referenceTabs.value = [];
    activeReferenceTabId.value = "";
  }

  /**
   * 页签超限淘汰：仅在真正新增页签后调用（重开命中既有页签不触发）。从最旧
   * （数组序即创建序）找第一个非活跃页签关闭，直到回到上限；活跃页签永不
   * 参与淘汰。关闭复用 closeReferenceTab 的 requestSeq 序号守卫，被淘汰页签
   * 的在途加载结果会被守卫拦下，不会误写或复活。
   */
  function evictOverflowReferenceTabs() {
    while (referenceTabs.value.length > REFERENCE_TAB_LIMIT) {
      const oldest = referenceTabs.value.find((tab) => tab.id !== activeReferenceTabId.value);
      if (!oldest) return; // 防御性兜底：上限 ≥ 2 时必有非活跃页签，理论上不可达
      closeReferenceTab(oldest.id);
    }
  }

  async function openReferencedEntry(dn: string, attribute?: string) {
    dialogToken.value++;
    const existing = referenceTabs.value.find((tab) => tab.dn.toLowerCase() === dn.toLowerCase());
    if (existing) {
      if (attribute) existing.attribute = attribute;
      activeReferenceTabId.value = existing.id;
      referenceOpen.value = true;
      return;
    }
    const tab: ReferenceTab = {
      id: `reference-${++nextReferenceTabId}`,
      dn,
      attribute,
      loading: true,
      loadError: "",
      loadErrorDetail: "",
      requestSeq: 0,
    };
    referenceTabs.value.push(tab);
    // 先做超限淘汰、再把新页签置为活跃：此刻 activeReferenceTabId 仍指向
    // 用户打开前正在看的页签，evict 的非活跃过滤才能保证"活跃页签永不被逐"
    // 是用户视角（正在看的页签不会被本次打开顶掉）。
    evictOverflowReferenceTabs();
    activeReferenceTabId.value = tab.id;
    referenceOpen.value = true;
    const request = ++tab.requestSeq;
    ensureDnAttributes();
    try {
      const result = await ldapApi.entryGet(dn);
      const current = referenceTabs.value.find((item) => item.id === tab.id);
      if (!current || request !== current.requestSeq) return;
      current.entry = result.entry;
      onRecent(dn);
      onSnapshot({ panel: "entry", anchor: dn });
    } catch (cause) {
      const current = referenceTabs.value.find((item) => item.id === tab.id);
      if (!current || request !== current.requestSeq) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      current.loadError = friendlyLdapError(message);
      current.loadErrorDetail = current.loadError === message ? "" : message;
    } finally {
      const current = referenceTabs.value.find((item) => item.id === tab.id);
      if (current && request === current.requestSeq) current.loading = false;
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
      const current = referenceTabs.value.find((item) => item.id === tab.id);
      if (!current || request !== current.requestSeq) return;
      current.entry = result.entry;
      current.loading = false;
    }).catch((cause) => {
      const current = referenceTabs.value.find((item) => item.id === tab.id);
      if (!current || request !== current.requestSeq) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      current.loadError = friendlyLdapError(message);
      current.loadErrorDetail = current.loadError === message ? "" : message;
      current.loading = false;
    });
  }

  // 左右详情属于一个复合会话：Esc 只关闭右侧引用，Tab 在两侧面板间循环。
  useModalA11y(() => referenceOpen.value, {
    close: closeActiveReference,
    containerSelector: ".entry-relation-layout",
  });

  function dispose() {
    closeReference();
  }

  return {
    referenceOpen,
    referenceTabs,
    activeReferenceTabId,
    activeReferenceTab,
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
    dispose,
  };
}
