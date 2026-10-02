import type { LdapEntry } from "./api";
import { looksBinaryAttribute } from "./binaryValue";

/**
 * A deliberately small first read.  These make the detail header useful on
 * AD, OpenLDAP and generic RFC4519 directories without pulling photos,
 * certificates or very large group memberships into the first response.
 */
export const ENTRY_PRIORITY_ATTRIBUTES = [
  "objectClass", "cn", "uid", "displayName", "description", "givenName",
  "sn", "mail", "createTimestamp", "modifyTimestamp",
] as const;

export const ENTRY_ATTRIBUTE_BATCH_SIZE = 20;

const ASSOCIATION_ATTRIBUTES = new Set([
  "member", "uniquemember", "memberuid", "memberof", "managedby", "manager",
  "owner", "seealso", "secretary", "roleoccupant",
]);

const priority = new Set(ENTRY_PRIORITY_ATTRIBUTES.map((name) => name.toLowerCase()));

export function isDeferredEntryAttribute(name: string): boolean {
  const bare = name.trim().toLowerCase().split(";")[0] ?? "";
  return ASSOCIATION_ATTRIBUTES.has(bare) || looksBinaryAttribute(bare);
}

export function partitionEntryAttributes(names: string[]): { regular: string[]; deferred: string[] } {
  const seen = new Set<string>();
  const regular: string[] = [];
  const deferred: string[] = [];
  for (const name of names) {
    const normalized = String(name ?? "").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key) || priority.has(key)) continue;
    seen.add(key);
    (isDeferredEntryAttribute(normalized) ? deferred : regular).push(normalized);
  }
  return { regular, deferred };
}

export function chunkEntryAttributes(names: string[], size = ENTRY_ATTRIBUTE_BATCH_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < names.length; offset += size) chunks.push(names.slice(offset, offset + size));
  return chunks;
}

/** Case-insensitive attribute union; keep the spelling from the newest read. */
export function mergeEntryAttributes(current: LdapEntry | undefined, next: LdapEntry): LdapEntry {
  if (!current) return { dn: next.dn, attributes: { ...next.attributes } };
  // 值数组逐键拷贝：浅拷 map 后未覆盖的数组与源条目共享引用，原地改会串数据。
  // 小写键索引替代每键全量线性扫（属性数上百的 staged read 逐批叠加变慢）。
  const attributes: Record<string, string[]> = {};
  const byLower = new Map<string, string>();
  for (const [key, values] of Object.entries(current.attributes)) {
    attributes[key] = [...values];
    if (!byLower.has(key.toLowerCase())) byLower.set(key.toLowerCase(), key);
  }
  for (const [name, values] of Object.entries(next.attributes)) {
    const oldName = byLower.get(name.toLowerCase());
    if (oldName && oldName !== name) {
      delete attributes[oldName];
      byLower.delete(oldName.toLowerCase());
    }
    attributes[name] = [...values];
    byLower.set(name.toLowerCase(), name);
  }
  return { dn: next.dn || current.dn, attributes };
}
