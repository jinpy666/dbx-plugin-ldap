// 整条目 DN 对比的纯函数：两侧 LdapEntry 按属性名取并集逐属性比对，给出
// equal / different / onlyLeft / onlyRight 状态与两侧值。LDAP 属性名语义上
// 大小写无关（同名不同写法按同一属性合并，展示名优先取左侧原写法）；属性值
// 集合无序，比较前各取排序副本，展示时也按排序输出保证两列可逐行对照。
import type { LdapEntry } from "./api";

export type EntryDiffStatus = "equal" | "different" | "onlyLeft" | "onlyRight";

export interface EntryDiffRow {
  /** 展示用属性名（左侧原大小写优先，缺失时用右侧）。 */
  name: string;
  status: EntryDiffStatus;
  leftValues: string[];
  rightValues: string[];
}

interface EntryAttributeSide {
  name: string;
  values: string[];
}

function attributeSide(entry: LdapEntry): Map<string, EntryAttributeSide> {
  const map = new Map<string, EntryAttributeSide>();
  for (const [name, values] of Object.entries(entry.attributes)) {
    const lower = name.toLowerCase();
    const existing = map.get(lower);
    if (existing) existing.values.push(...values);
    else map.set(lower, { name, values: [...values] });
  }
  return map;
}

function valuesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function diffLdapEntries(left: LdapEntry, right: LdapEntry): EntryDiffRow[] {
  const leftMap = attributeSide(left);
  const rightMap = attributeSide(right);
  const names = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
  const rows: EntryDiffRow[] = [];
  for (const lower of names) {
    const l = leftMap.get(lower);
    const r = rightMap.get(lower);
    const leftValues = (l?.values ?? []).slice().sort();
    const rightValues = (r?.values ?? []).slice().sort();
    const status: EntryDiffStatus = !l
      ? "onlyRight"
      : !r
        ? "onlyLeft"
        : valuesEqual(leftValues, rightValues)
          ? "equal"
          : "different";
    rows.push({ name: l?.name ?? r?.name ?? lower, status, leftValues, rightValues });
  }
  return rows;
}

export function countEntryDiff(rows: EntryDiffRow[]): { total: number; differences: number } {
  return { total: rows.length, differences: rows.filter((row) => row.status !== "equal").length };
}
