/**
 * F9 条目多开页签的工作集顺序（App.vue watch 的纯函数抽取）。
 *
 * 页签按打开顺序稳定排列：激活已有页签不重排（此前每次激活都把 DN 插到
 * 最前，导致点击后整条页签跳动）；新开的页签追加到尾部；超出上限从最旧
 * 一端淘汰。DN 比较大小写不敏感（LDAP DN 语义），去重时保留原有书写。
 * 纯函数，无 Vue / DOM 依赖。
 */
export function appendOpenTab(tabs: readonly string[], dn: string, max: number): string[] {
  const key = dn.trim().toLowerCase();
  const exists = tabs.some((item) => item.trim().toLowerCase() === key);
  if (exists) return [...tabs]; // 激活已有页签：原位保留、顺序不动
  const next = [...tabs, dn];
  return next.length > max ? next.slice(next.length - max) : next;
}
