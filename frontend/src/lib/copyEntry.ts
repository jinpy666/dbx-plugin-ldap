/**
 * 复制条目（copy entry）→ 新建预填。
 *
 * 对齐 Apache Directory Studio CopyEntriesRunnable 的单条模式：以源条目属性
 * 为模板创建新条目——
 * - DN 拆解：RDN 属性名保留、值标记待改（空串）；目标父 DN 由调用方给定
 *   （缺省同父）；
 * - 不可复制属性剔除：密码哈希（userPassword/unicodePwd 等）、系统/操作属性
 *   （objectSid、objectGUID、entryUUID、usn*、when*、nsUniqueId…），schema
 *   标记 NO-USER-MODIFICATION 的属性一并剔除（attributeInfo 缺失时用内置表）；
 * - 每个剔除的属性记入 notes，供 UI 提示（对齐 ldapSearchCommand 的 notes
 *   模式，不静默丢数据）。
 * 纯函数，无 Vue / DOM 依赖。
 */

import { splitFirstDnRdn } from "./dn";
import { builtinAttributeInfo } from "./builtinSchema";

/** 密码类属性：哈希不可复用（ADS PasswordValueEditor 亦不允许复制既有哈希）。 */
const NON_COPYABLE_PASSWORDS = new Set(["userpassword", "unicodepwd", "userpassword;binary"]);

/** 系统/操作属性名（小写）；RDN 属性即便命中也按 RDN 规则单独处理。 */
const NON_COPYABLE_SYSTEM = new Set([
  "objectsid",
  "objectguid",
  "entryuuid",
  "nsuniqueid",
  "ipauniqueid",
  "entrydn",
  "entrycsn",
  "creatorsname",
  "modifiersname",
  "createtimestamp",
  "modifytimestamp",
  "whencreated",
  "whenchanged",
  "usncreated",
  "usnchanged",
  "usnsource",
  "instancetype",
  "isdeleted",
  "lastknownparent",
  "replpropertymetadata",
  "structuralobjectclass",
]);

export interface CopyEntrySource {
  dn: string;
  attributes: Record<string, string[]>;
}

export interface CopyEntryOptions {
  /** 目标父 DN（缺省沿用源父 DN）。 */
  parentDn?: string;
  /** schema 属性语法信息（attributeInfo），用于 NO-USER-MODIFICATION 判定。 */
  attributeInfo?: Record<string, { noUserModification?: boolean }>;
}

export interface CopyEntryDraft {
  /** 新条目 RDN（属性名保留源 RDN 属性名，值置空待用户填写）。 */
  rdn: string;
  /** 新条目父 DN。 */
  parentDn: string;
  /** 剔除不可复制属性后的属性草稿。 */
  attributes: Record<string, string[]>;
  /** 被剔除的属性名（保序，去重），供 UI 提示。 */
  skipped: string[];
}

export function prepareCopyEntry(source: CopyEntrySource, options: CopyEntryOptions = {}): CopyEntryDraft {
  const { rdn } = splitFirstDnRdn(source.dn);
  const rdnAttributeName = (rdn.split("=")[0] ?? "").trim();
  const parentDn = options.parentDn?.trim() || splitFirstDnRdn(source.dn).parentDn;

  const attributes: Record<string, string[]> = {};
  const skipped: string[] = [];
  for (const name of Object.keys(source.attributes ?? {})) {
    const key = name.split(";")[0].trim().toLowerCase();
    if (key === "objectclass") {
      attributes[name] = [...(source.attributes[name] ?? [])];
      continue;
    }
    let reason = "";
    if (NON_COPYABLE_PASSWORDS.has(key)) reason = key;
    else if (NON_COPYABLE_SYSTEM.has(key)) reason = key;
    else if (options.attributeInfo?.[name]?.noUserModification || options.attributeInfo?.[key]?.noUserModification) reason = key;
    else if (builtinAttributeInfo(key)?.noUserModification) reason = key;
    if (reason) {
      if (!skipped.includes(name)) skipped.push(name);
      continue;
    }
    attributes[name] = [...(source.attributes[name] ?? [])];
  }

  // 新 RDN 属性：保留源 RDN 属性名；其旧值清空（避免与源条目同名冲突），
  // 交由向导必填校验兜底。
  if (rdnAttributeName) {
    const existingKey = Object.keys(attributes).find((name) => name.split(";")[0].trim().toLowerCase() === rdnAttributeName.toLowerCase());
    if (existingKey) attributes[existingKey] = [""];
    else attributes[rdnAttributeName] = [""];
  }

  return { rdn: `${rdnAttributeName}=`, parentDn, attributes, skipped };
}
