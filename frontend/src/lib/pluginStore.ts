// UI 持久化单点：宿主 host.storage（window.dbxPlugin.storage）保存工作台
// 非敏感 UI 状态，适配器实现与通道降级（宿主桥 → guarded localStorage →
// 内存）只在 shared/frontend/pluginStorage.ts 维护，这里只声明本插件的键
// 集合并建单例 store。工作台 iframe 是 opaque origin，直接读 localStorage
// 会抛 SecurityError（此前这些持久化在真机上全部静默失效）。
//
// 历史上的按连接/按表动态拼键已收敛为固定键 + JSON map（宿主 storage 没有
// 列键/前缀枚举能力，动态键无法声明进水合键集合）。旧动态键不做数据迁移：
// 工作台 iframe 下 localStorage 旧档在真机上从未写成功过，无可迁数据。

import { createPluginKvStore } from "../../../shared/frontend/pluginStorage";

/** 搜索快捷条折叠偏好："1" 折叠 / "0" 展开（缺省折叠）。 */
export const SEARCH_COLLAPSED_KEY = "dbx.ldap.ui.searchCollapsed";
/** 搜索过滤器历史：connectionId → 最近条目数组（原 dbx.ldap.ui.searchHistory.<conn> 动态键收敛）。 */
export const SEARCH_HISTORY_KEY = "dbx.ldap.ui.searchHistory";
/** 目录树侧栏宽度：像素数字符串。 */
export const TREE_WIDTH_KEY = "dbx.ldap.ui.treeWidth";
/** 分页页大小：tableKey → number（原 dbx-ldap-grid-pagesize-<tableKey> 动态键收敛）。 */
export const GRID_PAGE_SIZE_KEY = "dbx-ldap-grid-pagesizes";
/** ag-grid 列布局：tableKey → ColumnState[]（原 dbx-ldap-grid-colstate-<tableKey> 动态键收敛）。 */
export const GRID_COLUMN_STATE_KEY = "dbx-ldap-grid-colstates";
/** 书签（F7）：全量 BookmarkEntry 数组（最新在前）。 */
export const BOOKMARKS_KEY = "dbx-ldap-bookmarks-v1";

/** 本插件全部 UI 状态键（宿主 storage 无列键方法，水合需显式声明）。 */
export const PLUGIN_STORE_KEYS = [
  SEARCH_COLLAPSED_KEY,
  SEARCH_HISTORY_KEY,
  TREE_WIDTH_KEY,
  GRID_PAGE_SIZE_KEY,
  GRID_COLUMN_STATE_KEY,
  BOOKMARKS_KEY,
];

export const pluginStore = createPluginKvStore(PLUGIN_STORE_KEYS);
