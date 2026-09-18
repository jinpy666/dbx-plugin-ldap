import { ref } from "vue";

/**
 * 最近打开条目（工具栏 History 下拉的数据面，从 App.vue 抽出）：
 * 最新在前、大小写不敏感去重、上限 10 条。记录点 = 条目详情读取成功路径、
 * 关联标签加载成功与保存后 reopen；属于单个连接的浏览状态，连接切换时清空。
 * 下拉的定位/键盘交互在 WorkbenchToolbar.vue 内实现，这里只管数据。
 */
const RECENT_ENTRIES_MAX = 10;

export function useRecentEntries() {
  const recentEntries = ref<string[]>([]);

  function record(dn: string) {
    const trimmed = dn.trim();
    if (!trimmed) return;
    const next = recentEntries.value.filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
    next.unshift(trimmed);
    recentEntries.value = next.slice(0, RECENT_ENTRIES_MAX);
  }

  function clear() {
    recentEntries.value = [];
  }

  return { recentEntries, record, clear };
}
