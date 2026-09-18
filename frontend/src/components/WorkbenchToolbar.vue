<script setup lang="ts">
// 工作台工具栏（从 App.vue 抽出）：连接身份 + 协议/认证徽章 + 全局动作按钮，
// 以及「最近打开条目」「书签」「跳转到 DN」三个下拉（Teleport + 全局
// .context-menu 复用，坐标按按钮位置在打开时算一次；点击外部/Escape/再点
// 按钮关闭；三个下拉共用文档级点击关闭，键盘处理各自独立且互不误伤）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Database, Download, FileText, FileUp, History, Info, Loader2, LocateFixed, Network, RefreshCw, Star, X } from "@lucide/vue";
import { t } from "../lib/i18n";
import { splitFirstDnRdn } from "../lib/dn";

const props = defineProps<{
  ready: boolean;
  /** 初始化失败时停转 spinner（UI 扫描 P2-2：不展示"看似就绪"的加载态）。 */
  showSpinner: boolean;
  identityText: string;
  protocolBadge: string;
  serverBadge: string;
  canWrite: boolean;
  connectionColor?: string;
  toolbarStyle?: Record<string, string>;
  recentEntries: string[];
  /** 书签（F7）：lib/bookmarks.ts 的按连接列表（最新在前）。 */
  bookmarks?: string[];
  /** 结果表当前有完整可导出的结果时才允许一键导出。 */
  exportable: boolean;
  exportTitle: string;
}>();

const emit = defineEmits<{
  rootDse: [];
  openSchema: [];
  openConnections: [];
  openImport: [];
  openRecent: [dn: string];
  openBookmark: [dn: string];
  removeBookmark: [dn: string];
  gotoDn: [dn: string];
  refresh: [];
  exportLdif: [];
}>();

const bookmarkList = computed(() => props.bookmarks ?? []);

// 下拉复用全局 .context-menu（fixed + z-50）：打开时按按钮位置算一次坐标即可
//（工具栏不滚动）；点击外部/Escape/再点按钮关闭，注册方式照抄 DnTree 右键菜单。
const recentButtonEl = ref<HTMLButtonElement>();
/** 菜单定位：以触发按钮左上对齐，但右缘不得超出视口（右侧按钮簇的
 * 下拉按 rect.left 打开时可能整体溢出——走查实测抓到）。 */
function clampedMenuPosition(rect: DOMRect): { x: number; y: number } {
  const x = Math.max(8, Math.min(rect.left, window.innerWidth - 376));
  return { x, y: rect.bottom + 4 };
}

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
  recentMenu.value = clampedMenuPosition(rect);
  void nextTick(() => recentMenuEl.value?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus({ preventScroll: true }));
}

function closeRecentMenu(restoreFocus = false) {
  recentMenu.value = undefined;
  if (restoreFocus) recentMenuTrigger?.focus({ preventScroll: true });
}

function openRecent(dn: string) {
  closeRecentMenu();
  emit("openRecent", dn);
}

// 行文本只显示首段 RDN，完整 DN 挂 title 悬停（长 DN 由行内 ellipsis 截断）。
function recentLabel(dn: string): string {
  return splitFirstDnRdn(dn).rdn || dn;
}

// 菜单内 ↑/↓ 循环移动焦点（仅 role=menuitem 且未禁用的项）。
function moveMenuFocus(menuEl: HTMLElement | undefined, event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  const items = Array.from(menuEl?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") ?? []);
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (items.length === 0) return;
  const next = event.key === "ArrowUp" ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
  items[next]?.focus({ preventScroll: true });
}

function onRecentMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    // 未打开时不误关/不抢焦点：与书签、跳转菜单并存时互不干扰。
    if (!recentMenu.value) return;
    event.preventDefault();
    event.stopPropagation();
    closeRecentMenu(true);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" || !recentMenu.value) return;
  moveMenuFocus(recentMenuEl.value, event);
}

// -- 书签下拉（F7）：与最近条目下拉同构；每行附一个小移除按钮 ------------------

const bookmarkButtonEl = ref<HTMLButtonElement>();
const bookmarkMenuEl = ref<HTMLElement>();
let bookmarkMenuTrigger: HTMLElement | null = null;
const bookmarkMenu = ref<{ x: number; y: number }>();

function toggleBookmarkMenu() {
  if (bookmarkMenu.value) {
    closeBookmarkMenu();
    bookmarkMenuTrigger?.focus({ preventScroll: true });
    return;
  }
  const rect = bookmarkButtonEl.value?.getBoundingClientRect();
  if (!rect) return;
  bookmarkMenuTrigger = bookmarkButtonEl.value ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  bookmarkMenu.value = clampedMenuPosition(rect);
  void nextTick(() => bookmarkMenuEl.value?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus({ preventScroll: true }));
}

function closeBookmarkMenu(restoreFocus = false) {
  bookmarkMenu.value = undefined;
  if (restoreFocus) bookmarkMenuTrigger?.focus({ preventScroll: true });
}

function openBookmark(dn: string) {
  closeBookmarkMenu();
  emit("openBookmark", dn);
}

// 行内小移除按钮：菜单保持打开便于连续清理；移除后焦点回到首个可用项
//（被移除的按钮随列表收缩消失，不能把焦点留在已卸载元素上）。
function removeBookmarkRow(dn: string) {
  emit("removeBookmark", dn);
  void nextTick(() => bookmarkMenuEl.value?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus({ preventScroll: true }));
}

function onBookmarkMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (!bookmarkMenu.value) return;
    event.preventDefault();
    event.stopPropagation();
    closeBookmarkMenu(true);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" || !bookmarkMenu.value) return;
  moveMenuFocus(bookmarkMenuEl.value, event);
}

// -- 跳转到 DN（F8）：按钮弹内联输入下拉，Enter/「跳转」提交 ------------------

const gotoButtonEl = ref<HTMLButtonElement>();
const gotoMenuEl = ref<HTMLElement>();
let gotoMenuTrigger: HTMLElement | null = null;
const gotoMenu = ref<{ x: number; y: number }>();
const gotoInput = ref("");
const gotoInputEl = ref<HTMLInputElement>();

function toggleGotoMenu() {
  if (gotoMenu.value) {
    closeGotoMenu();
    gotoMenuTrigger?.focus({ preventScroll: true });
    return;
  }
  const rect = gotoButtonEl.value?.getBoundingClientRect();
  if (!rect) return;
  gotoMenuTrigger = gotoButtonEl.value ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  gotoInput.value = "";
  gotoMenu.value = clampedMenuPosition(rect);
  void nextTick(() => gotoInputEl.value?.focus({ preventScroll: true }));
}

function closeGotoMenu(restoreFocus = false) {
  gotoMenu.value = undefined;
  if (restoreFocus) gotoMenuTrigger?.focus({ preventScroll: true });
}

// 提交只负责 emit：定位与结果反馈（成功=树内高亮；失败=notify）由控制方做。
function submitGoto() {
  const dn = gotoInput.value.trim();
  if (!dn) return;
  closeGotoMenu();
  gotoInput.value = "";
  emit("gotoDn", dn);
}

function onGotoMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (!gotoMenu.value) return;
    event.preventDefault();
    event.stopPropagation();
    closeGotoMenu(true);
  }
  // 输入框内方向键是光标移动，不做菜单导航；提交由 form 的 Enter 语义承担。
}

// 三个下拉共用的文档级兜底：Escape 只关已打开的书签/跳转菜单（焦点不在
// 菜单内时也能关）；各菜单元素自身已带 keydown 处理并 stopPropagation，
// 这里只兜"焦点散落在菜单外"的场景。
function onMenuDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (bookmarkMenu.value) {
    event.preventDefault();
    event.stopPropagation();
    closeBookmarkMenu(true);
  } else if (gotoMenu.value) {
    event.preventDefault();
    event.stopPropagation();
    closeGotoMenu(true);
  }
}

function onDocumentClick() {
  closeRecentMenu();
  closeBookmarkMenu();
  closeGotoMenu();
}

// 下拉的关闭监听：延后到 setTimeout 0 再挂，避免注册瞬间的点击事件立刻触发
// 关闭（照 DnTree 右键菜单的注册/清理模式）；timer 保存到变量并在卸载时清除
//（审计 K-8），防止挂载同 tick 卸载时监听器随回调"复活"泄漏。
let menuListenerTimer = 0;
onMounted(() => {
  menuListenerTimer = window.setTimeout(() => {
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onRecentMenuKeydown);
    document.addEventListener("keydown", onMenuDocumentKeydown);
  }, 0);
});

onBeforeUnmount(() => {
  window.clearTimeout(menuListenerTimer);
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onRecentMenuKeydown);
  document.removeEventListener("keydown", onMenuDocumentKeydown);
});
</script>

<template>
  <header class="toolbar" :style="props.toolbarStyle">
    <div class="identity">
      <span class="connection-color" :style="connectionColor ? { background: connectionColor } : undefined" />
      <strong :title="identityText">{{ identityText }}</strong>
      <span v-if="protocolBadge" class="badge mono identity-protocol" :title="t('protocol.badge')">{{ protocolBadge }}</span>
      <span v-if="!canWrite" class="read-only-badge">{{ t("readOnly") }}</span>
      <Loader2 v-if="showSpinner" class="icon-neutral spinning" aria-hidden="true" />
    </div>
    <div class="toolbar-actions">
      <button class="toolbar-button" :disabled="!ready" :title="t('rootDse.title')" @click="emit('rootDse')">
        <Info aria-hidden="true" /><span>{{ t("rootDse.title") }}</span>
      </button>
      <button class="toolbar-button" :disabled="!ready" :title="t('schema.title')" @click="emit('openSchema')">
        <Database class="icon-violet" aria-hidden="true" /><span>{{ t("schema.title") }}</span>
      </button>
      <button class="toolbar-button" :disabled="!ready" :title="t('connections.title')" @click="emit('openConnections')">
        <Network class="icon-cyan" aria-hidden="true" /><span>{{ t("connections.title") }}</span>
      </button>
      <!-- 导入是写入口：只读时禁用，title 与 ResultTable 批量条同一只读提示。 -->
      <button class="toolbar-button" :disabled="!ready || !canWrite" :title="!canWrite ? t('editor.readonlyHint') : t('ldap.importEntry.toolbar')" @click="emit('openImport')">
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
      <!-- 书签触发按钮：disabled 条件照最近条目按钮（!ready || 列表空）。 -->
      <button
        ref="bookmarkButtonEl"
        class="icon-button"
        :disabled="!ready || bookmarkList.length === 0"
        :title="t('bookmark.title')"
        :aria-label="t('bookmark.title')"
        @click.stop="toggleBookmarkMenu"
      >
        <Star aria-hidden="true" />
      </button>
      <!-- 跳转到 DN：只需连接就绪，不依赖任何列表。 -->
      <button
        ref="gotoButtonEl"
        class="icon-button"
        :disabled="!ready"
        :title="t('goto.title')"
        :aria-label="t('goto.title')"
        @click.stop="toggleGotoMenu"
      >
        <LocateFixed aria-hidden="true" />
      </button>
      <span v-if="serverBadge" class="badge mono" :title="t('connections.title')">{{ serverBadge }}</span>
      <span class="toolbar-separator" />
      <button class="icon-button" :disabled="!ready" :title="t('refresh')" @click="emit('refresh')">
        <RefreshCw aria-hidden="true" />
      </button>
      <button class="icon-button" :disabled="!ready || !exportable" :title="exportTitle" @click="emit('exportLdif')">
        <Download aria-hidden="true" />
      </button>
    </div>
  </header>

  <!-- 最近打开条目下拉：Teleport 到 body + 复用全局 .context-menu（fixed 定位），
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

  <!-- 书签下拉：结构与最近条目下拉一致；每行主按钮打开 + 小移除按钮（flex 行，
       全部内联样式，不新增全局 CSS）。 -->
  <Teleport to="body">
    <div
      v-if="bookmarkMenu"
      ref="bookmarkMenuEl"
      class="context-menu context-menu--recent"
      role="menu"
      tabindex="-1"
      :style="{ left: `${bookmarkMenu.x}px`, top: `${bookmarkMenu.y}px`, width: '360px', maxWidth: 'calc(100vw - 16px)' }"
      @click.stop
      @keydown="onBookmarkMenuKeydown"
    >
      <div class="context-menu-heading">
        <Star class="context-menu-heading-icon" aria-hidden="true" />
        <span>{{ t("bookmark.title") }}</span>
      </div>
      <button v-if="bookmarkList.length === 0" disabled>
        <Star class="context-menu-item-icon" aria-hidden="true" />
        <span>{{ t("bookmark.empty") }}</span>
      </button>
      <div v-for="dn in bookmarkList" :key="dn" role="none" style="display: flex; gap: 2px">
        <button role="menuitem" style="flex: 1 1 auto; min-width: 0" :title="dn" @click="openBookmark(dn)">
          <Star class="context-menu-item-icon" aria-hidden="true" />
          <span class="context-menu-item-label">{{ recentLabel(dn) }}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="icon-button"
          style="flex: 0 0 24px; width: 24px; padding: 0; justify-content: center"
          :title="t('bookmark.remove')"
          :aria-label="`${t('bookmark.remove')}：${dn}`"
          @click="removeBookmarkRow(dn)"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  </Teleport>

  <!-- 跳转到 DN 下拉：内联输入 + 提交按钮，Enter 提交（form 语义）。 -->
  <Teleport to="body">
    <div
      v-if="gotoMenu"
      ref="gotoMenuEl"
      class="context-menu context-menu--recent"
      role="menu"
      tabindex="-1"
      :style="{ left: `${gotoMenu.x}px`, top: `${gotoMenu.y}px`, width: '360px', maxWidth: 'calc(100vw - 16px)' }"
      @click.stop
      @keydown="onGotoMenuKeydown"
    >
      <div class="context-menu-heading">
        <LocateFixed class="context-menu-heading-icon" aria-hidden="true" />
        <span>{{ t("goto.title") }}</span>
      </div>
      <form style="display: flex; gap: 4px; padding: 2px 4px 4px" @submit.prevent="submitGoto">
        <input
          ref="gotoInputEl"
          v-model="gotoInput"
          type="text"
          :placeholder="t('goto.placeholder')"
          :aria-label="t('goto.placeholder')"
          style="min-width: 0; flex: 1 1 auto; height: 26px; border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; outline: none; background: color-mix(in srgb, var(--background) 95%, var(--foreground)); color: var(--foreground)"
        />
      <!-- width:auto 必须内联覆盖 .context-menu button 的 width:100%：
           按钮作为 flex 项 basis 会解析成整行宽且 flex:0 0 auto 不可收缩，
           把 min-width:0 的输入框挤到只剩内边距（走查实测 18px）。 -->
        <button type="submit" class="toolbar-button" style="flex: 0 0 auto; width: auto">
          <span>{{ t("goto.jump") }}</span>
        </button>
      </form>
    </div>
  </Teleport>
</template>
