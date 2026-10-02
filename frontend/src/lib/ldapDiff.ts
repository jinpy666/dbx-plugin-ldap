/** Diff two LDAP attribute maps into an RFC 4511 modify change list. */
export interface LdapModifyChange {
  operation: "add" | "replace" | "delete";
  attribute: string;
  values: string[];
}

export function diffChanges(
  before: Record<string, string[]>,
  after: Record<string, string[]>,
): LdapModifyChange[] {
  const changes: LdapModifyChange[] = [];
  // 属性名按 RFC 4512 大小写不敏感匹配：用户重打属性名大小写不应产生
  // delete+add 抖动（值相同 → 无变更；值不同 → replace，避免先删后加的
  // 中间空窗）。键的枚举顺序保持原样（before 键先于 after 键）。
  const beforeByLower = new Map<string, string[]>();
  for (const [name, values] of Object.entries(before || {})) {
    if (!beforeByLower.has(name.toLowerCase())) beforeByLower.set(name.toLowerCase(), values);
  }
  const afterByLower = new Map<string, { name: string; values: string[] }>();
  for (const [name, values] of Object.entries(after || {})) {
    if (!afterByLower.has(name.toLowerCase())) afterByLower.set(name.toLowerCase(), { name, values });
  }
  const seenLower = new Set<string>();
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    const beforeValues = beforeByLower.get(lower);
    const afterEntry = afterByLower.get(lower);
    if (!beforeValues && afterEntry) changes.push({ operation: "add", attribute: afterEntry.name, values: afterEntry.values });
    else if (beforeValues && !afterEntry) changes.push({ operation: "delete", attribute: key, values: [] });
    else if (beforeValues && afterEntry && beforeValues.join("\n") !== afterEntry.values.join("\n")) {
      changes.push({ operation: "replace", attribute: afterEntry.name, values: afterEntry.values });
    }
  }
  return changes;
}

/**
 * Editor row draft → attribute map. A single attribute value may itself contain
 * "\n", which is indistinguishable from the row textarea's value separator
 * after a join/split round-trip. Rows whose text is untouched therefore keep
 * their original values verbatim (`sourceValues`); only edited rows are split
 * on "\n" (empty segments dropped, duplicates collapsed).
 *
 * Repeated rows with the same attribute name merge into one multi-valued
 * attribute (values concatenated in row order, duplicates dropped) instead of
 * the later row silently overwriting the earlier one (UI 扫描 P2-14).
 */
export interface AttrRowDraftSource {
  name: string;
  valuesText: string;
  sourceValues?: string[];
}

export function attrRowsToAttributes(rows: readonly AttrRowDraftSource[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  // 小写键 → 合并中的值集合（Set 查重）：重复行按大小写不敏感合并（与
  // mergeEntryAttributes 语义一致），去重 O(1)，大多值粘贴不再 O(n²)。
  const merging = new Map<string, { values: string[]; seen: Set<string> }>();
  for (const row of rows || []) {
    const name = row.name.trim();
    if (!name) continue;
    let values: string[];
    if (row.sourceValues && row.valuesText === row.sourceValues.join("\n")) {
      values = [...row.sourceValues];
    } else {
      values = row.valuesText.split("\n").filter((value) => value !== "");
      values = [...new Set(values)];
    }
    if (values.length === 0) continue;
    const key = name.toLowerCase();
    const existing = merging.get(key);
    if (!existing) {
      result[name] = values;
      merging.set(key, { values, seen: new Set(values) });
      continue;
    }
    for (const value of values) {
      if (!existing.seen.has(value)) {
        existing.values.push(value);
        existing.seen.add(value);
      }
    }
  }
  return result;
}
