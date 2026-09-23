// 书签（F7）：按连接隔离的收藏 DN 列表，pluginStore 持久化（键
// "dbx-ldap-bookmarks-v1"），最新在前、大小写不敏感去重、每连接上限 20。
// 存储通道与降级（宿主 host.storage → guarded localStorage → 内存，node/
// 无桥环境天然内存态）由 shared/frontend/pluginStorage.ts 提供，这里只管
// 数据形状。工具栏下拉的定位/键盘交互在 WorkbenchToolbar.vue 内实现。
import { BOOKMARKS_KEY, pluginStore } from "./pluginStore";
import { dnWithinBase, splitFirstDnRdn } from "./dn";

export interface BookmarkEntry {
  connectionId: string;
  dn: string;
}

const BOOKMARKS_MAX = 20;

/** 读取全量书签（跨连接）；坏数据（非 JSON/非数组/形状不符）一律回落为空。 */
function readAll(): BookmarkEntry[] {
  try {
    const parsed: unknown = JSON.parse(pluginStore.getItem(BOOKMARKS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is BookmarkEntry =>
        typeof item === "object" && item !== null &&
        typeof (item as BookmarkEntry).connectionId === "string" &&
        typeof (item as BookmarkEntry).dn === "string",
    );
  } catch {
    return [];
  }
}

/** 写回全量书签；写入失败（配额/禁存储）静默保留内存语义，不向调用方抛错。 */
function writeAll(entries: BookmarkEntry[]) {
  try {
    pluginStore.setItem(BOOKMARKS_KEY, JSON.stringify(entries));
  } catch {
    /* 存储不可用（隐私模式等）：仅内存态 */
  }
}

/** 读取单个连接的书签（最新在前）；对存储中的脏数据做防御性去重。 */
function readList(connectionId: string): string[] {
  const dns: string[] = [];
  const seen = new Set<string>();
  for (const entry of readAll()) {
    if (entry.connectionId !== connectionId) continue;
    const dn = entry.dn.trim();
    const key = dn.toLowerCase();
    if (!dn || seen.has(key)) continue;
    seen.add(key);
    dns.push(dn);
  }
  return dns;
}

/** 用新列表整体替换某连接的书签（其余连接条目保持原相对顺序）。 */
function writeList(connectionId: string, dns: string[]) {
  const others = readAll().filter((entry) => entry.connectionId !== connectionId);
  writeAll([...dns.map((dn) => ({ connectionId, dn })), ...others]);
}

/** 某连接的书签 DN 列表（最新在前）。 */
export function loadBookmarks(connectionId: string): string[] {
  return readList(connectionId);
}

/** 新增书签；重复（大小写不敏感）或 DN/连接为空返回 false 且不改动现有列表。 */
export function addBookmark(connectionId: string, dn: string): boolean {
  const trimmed = String(dn ?? "").trim();
  if (!connectionId || !trimmed) return false;
  const current = readList(connectionId);
  if (current.some((item) => item.toLowerCase() === trimmed.toLowerCase())) return false;
  current.unshift(trimmed);
  writeList(connectionId, current.slice(0, BOOKMARKS_MAX));
  return true;
}

/** 移除书签（大小写不敏感匹配）；不存在返回 false。 */
export function removeBookmark(connectionId: string, dn: string): boolean {
  const trimmed = String(dn ?? "").trim();
  if (!trimmed) return false;
  const current = readList(connectionId);
  const next = current.filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
  if (next.length === current.length) return false;
  writeList(connectionId, next);
  return true;
}

// -- F8 revealDn 的纯函数部分：DN 路径切分 -----------------------------------
// 树内定位从 baseDn 起逐级展开，这里只计算"从根到目标的祖先链"，不发请求、
// 不碰组件状态（组件测试成本高，纯函数在 bookmarks.spec 内直接覆盖）。

/**
 * 从 baseDn 到 targetDn 的逐级 DN 链（含两端，[根, …, 目标]）。
 * targetDn 不在 baseDn 之下、或任一端为空时返回 []，调用方直接判失败。
 * 大小写不敏感对齐 base（服务器/用户输入的大小写不可控）。
 */
export function dnPathChain(targetDn: string, baseDn: string): string[] {
  const base = String(baseDn ?? "").trim();
  const target = String(targetDn ?? "").trim();
  if (!target || !base) return [];
  if (target.toLowerCase() === base.toLowerCase()) return [base];
  if (!dnWithinBase(target, base)) return [];
  // 从目标向上逐级收集祖先（不含 base 本身），再反转拼回根起点。
  const ancestors: string[] = [];
  let current = target;
  while (current && current.toLowerCase() !== base.toLowerCase()) {
    ancestors.push(current);
    current = splitFirstDnRdn(current).parentDn;
  }
  if (!current) return []; // 防御：祖先链耗尽仍未回到 base（dnWithinBase 已挡，理论不可达）
  return [base, ...ancestors.reverse()];
}
