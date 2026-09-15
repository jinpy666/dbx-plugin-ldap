/**
 * 条目数据导入解析（ldapsearch LDIF 输出 / PowerShell Format-List 输出）。
 *
 * 支持"粘贴导入"的两类真实来源：
 * - `ldapsearch -LLL …` 的 LDIF 输出（复用 lib/ldif.ts 的 RFC 2849 解析，
 *   含 base64:: 值与多值属性）；
 * - `Get-ADUser/Get-ADObject/Get-QAD* … | Format-List` 的文本输出：
 *   `Prop : value` 行、空行分块（多对象）、`{v1, v2}` 多值集合、
 *   `{b0, b1, …}` 字节数组（→ base64）、PS 显示名 → LDAP 属性名映射
 *   （Surname→sn、EmailAddress→mail 等）、GUID/SID 显示串 → 二进制 base64。
 *
 * 行为约定（对齐 ldapSearchCommand.ts 的 notes 模式）：不识别/不可写入的
 * 属性剔除并记入 notes（PS 计算属性 Enabled/CanonicalName 等无法写回目录），
 * 不静默丢数据。纯函数，无 Vue / DOM 依赖。
 */

import { parseLdif } from "./ldif";
import { bytesToBase64 } from "./binaryValue";
import { formatObjectGuid, formatObjectSid } from "./adValues";

export type EntryFormat = "ldif" | "ps-format-list" | "unknown";

export interface ParsedEntryDraft {
  dn: string;
  attributes: Record<string, string[]>;
  /** 本条目级别的提示（缺 DN、丢弃的属性等）。 */
  warnings: string[];
}

export interface ParseEntriesResult {
  format: EntryFormat;
  entries: ParsedEntryDraft[];
  /** 全局级提示（LDIF 解析错误、格式识别说明等）。 */
  notes: string[];
}

/** 格式识别：LDIF 优先（`dn:` 行特征），其次 PS Format-List（`Prop : value`）。 */
export function detectEntryFormat(text: string): EntryFormat {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "unknown";
  if (/^dn(::|:)/im.test(trimmed) || /^version:\s*1\s*$/im.test(trimmed)) return "ldif";
  if (/^[A-Za-z][\w.-]*\s*:\s\S/m.test(trimmed)) return "ps-format-list";
  return "unknown";
}

export function parseEntriesFromText(text: string): ParseEntriesResult {
  const format = detectEntryFormat(text);
  if (format === "ldif") {
    const result = parseLdif(String(text ?? ""));
    const notes = result.errors.map((error) => `L${error.line}: ${error.message}`);
    const entries: ParsedEntryDraft[] = result.entries.map((entry) => ({
      dn: entry.dn,
      attributes: entry.attributes,
      warnings: [],
    }));
    return { format, entries, notes };
  }
  if (format === "ps-format-list") {
    const { entries, notes } = parsePowerShellFormatList(String(text ?? ""));
    return { format, entries, notes };
  }
  return { format: "unknown", entries: [], notes: [] };
}

// -- PowerShell Format-List ---------------------------------------------------

/** PS 显示名 → LDAP 属性名（小写键；same-name 属性无需映射）。 */
const PS_NAME_TO_LDAP: Record<string, string> = {
  distinguishedname: "", // → dn（特判）
  dn: "", // Quest Get-QAD → dn（特判）
  surname: "sn",
  emailaddress: "mail",
  samaccountname: "sAMAccountName",
  userprincipalname: "userPrincipalName",
  mobilephone: "mobile",
  officephone: "telephoneNumber",
  fax: "facsimileTelephoneNumber",
  city: "l",
  state: "st",
  country: "c",
  streetaddress: "street",
  office: "physicalDeliveryOfficeName",
  pobox: "postOfficeBox",
  postalcode: "postalCode",
  company: "company",
  department: "department",
  title: "title",
  displayname: "displayName",
  name: "name",
  givenname: "givenName",
  initials: "initials",
  description: "description",
  homepage: "wWWHomePage",
  scriptpath: "scriptPath",
  homedirectory: "homeDirectory",
  homedrive: "homeDrive",
  profilepath: "profilePath",
  userworkstations: "userWorkstations",
  logonworkstations: "userWorkstations",
  manager: "manager",
  employeeid: "employeeID",
  employeenumber: "employeeNumber",
  preferredlanguage: "preferredLanguage",
  serviceprincipalnames: "servicePrincipalName",
  // AD 标准大小写（PS 输出常为 ObjectGUID/ObjectSid）
  objectguid: "objectGUID",
  objectsid: "objectSID",
  sid: "objectSID",
  useraccountcontrol: "userAccountControl",
};

/** PS 计算属性（无对应可写 LDAP 属性）→ 剔除并记 notes。 */
const PS_COMPUTED_SKIP = new Set([
  "canonicalname",
  "created",
  "createdn",
  "modified",
  "deleted",
  "protectedfromaccidentaldeletion",
  "lastknownparent",
  "enabled",
  "lockedout",
  "cannotchangepassword",
  "passwordneverexpires",
  "passwordnotrequired",
  "passwordexpired",
  "accountneverexpires",
  "accountnotdelegated",
  "allowreversiblepasswordencryption",
  "smartcardlogonrequired",
  "trustedfordelegation",
  "trustedtoauthfordelegation",
  "usedeskeyonly",
  "doesnotrequirepreauth",
  "badlogoncount",
  "lastbadpasswordattempt",
  "primarygroup",
  "sidhistory",
  "dscorepropagationdata",
  "msds-user-account-control-computed",
  "msds-authenticatedatdc",
  "objectcategory",
  "ntsecuritydescriptor",
  "instancetype",
  "isdeleted",
  "sdrightseffective",
  "memberof",
  // Quest Get-QAD 专属
  "type",
  "ntaccountname",
  "parentcontainer",
  "owner",
  "directoryentry",
  // 系统维护（写入会被服务器拒绝）
  "whencreated",
  "whenchanged",
  "usncreated",
  "usnchanged",
  "showinadvancedviewonly",
]);

/** GUID 显示串（objectGUID 的 PS 输出）→ 二进制 base64。 */
function guidTextToBase64(text: string): string | null {
  const match = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.exec(text);
  if (!match) return null;
  const hex = text.replace(/-/gu, "");
  const raw = new Uint8Array(16);
  for (let i = 0; i < 16; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  // Windows 混合端序：Data1(4B)/Data2(2B)/Data3(2B) 小端存储
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 4; i++) bytes[i] = raw[3 - i];
  for (let i = 0; i < 2; i++) bytes[4 + i] = raw[7 - i - 2];
  for (let i = 0; i < 2; i++) bytes[6 + i] = raw[9 - i - 4];
  bytes.set(raw.slice(8), 8);
  return bytesToBase64(bytes);
}

/** S-1-… 串（objectSid 的 PS/SID 显示形态）→ 二进制 base64。 */
function sidTextToBase64(text: string): string | null {
  const parts = text.trim().split("-");
  if (parts.length < 3 || parts[0] !== "S") return null;
  const revision = Number(parts[1]);
  const authority = BigInt(parts[2]);
  const subAuthorities = parts.slice(3).map(Number);
  if (!Number.isInteger(revision) || revision < 0 || revision > 255) return null;
  if (subAuthorities.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) return null;
  if (subAuthorities.length > 15) return null;
  if (authority < 0n || authority > 0xffffffffffffn) return null;
  const bytes = new Uint8Array(8 + subAuthorities.length * 4);
  bytes[0] = revision;
  bytes[1] = subAuthorities.length;
  for (let i = 0; i < 6; i++) bytes[7 - i] = Number((authority >> BigInt(i * 8)) & 0xffn);
  subAuthorities.forEach((value, index) => {
    const offset = 8 + index * 4;
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  });
  return bytesToBase64(bytes);
}

interface PsProperty {
  name: string;
  /** 归一化后的原始值（多值已聚合，`{}` 集合已展开）。 */
  values: string[];
}

/** 单条目属性块解析：`Name : value` / 续行 / `{a, b}` 集合。 */
function parsePsBlock(block: string[]): PsProperty[] {
  const properties: PsProperty[] = [];
  const propertyRe = /^([A-Za-z][\w.-]*)\s*:\s?(.*)$/u;
  for (const line of block) {
    const match = propertyRe.exec(line);
    if (match) {
      properties.push({ name: match[1], values: [match[2]] });
      continue;
    }
    // 续行：无冒号缩进行归属上一属性。Format-List 的换行是同一值的折行显示
    //（真正的多值渲染为 `{a, b}` 集合），因此先按单值累积，由下方统一判定。
    if (properties.length > 0 && /^\s+\S/u.test(line)) {
      properties[properties.length - 1].values.push(line.trim());
    }
  }
  for (const property of properties) {
    const joined = property.values.map((value) => value.trim()).filter(Boolean).join(" ").trim();
    if (/^\{.*\}$/u.test(joined)) {
      const inner = joined.slice(1, -1).trim();
      property.values = inner === "" ? [] : inner.split(/,\s*/u).filter(Boolean);
    } else {
      property.values = joined === "" ? [] : [joined];
    }
  }
  return properties;
}

function convertPsValue(name: string, values: string[], warnings: string[]): string[] {
  const lower = name.toLowerCase();
  // 二进制特例：objectGUID / objectSid / SID 的显示串 → base64
  if (lower === "objectguid") {
    const encoded = guidTextToBase64(values[0] ?? "");
    if (encoded) return [encoded];
    warnings.push(`objectGUID: ${values[0] ?? ""}`);
    return [];
  }
  if (lower === "objectsid" || lower === "sid") {
    const encoded = sidTextToBase64(values[0] ?? "");
    if (encoded) return [encoded];
    warnings.push(`${name}: ${values[0] ?? ""}`);
    return [];
  }
  // 字节数组形态 {11, 22, 33, …}（全为 0-255 整数且足够长）→ base64
  if (values.length > 0 && values.every((value) => /^\d{1,3}$/u.test(value.trim()))) {
    const numbers = values.map((value) => Number(value.trim()));
    if (numbers.length >= 8 && numbers.every((value) => value >= 0 && value <= 255)) {
      return [bytesToBase64(new Uint8Array(numbers))];
    }
    return values;
  }
  return values.map((value) => (/^(true|false)$/u.test(value) ? value.toUpperCase() : value));
}

function ldapAttributeName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "distinguishedname" || lower === "dn") return null; // dn 走特判
  const mapped = PS_NAME_TO_LDAP[lower];
  return mapped ?? name;
}

/**
 * PowerShell Format-List 解析：空行分块（多对象），`Prop : value`，
 * PS 显示名映射 + 计算属性剔除（记 notes）。
 */
export function parsePowerShellFormatList(text: string): { entries: ParsedEntryDraft[]; notes: string[] } {
  const lines = String(text ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);

  const notes: string[] = [];
  const droppedProperties = new Set<string>();
  const entries: ParsedEntryDraft[] = blocks.map((block) => {
    const properties = parsePsBlock(block);
    const warnings: string[] = [];
    let dn = "";
    const attributes: Record<string, string[]> = {};
    for (const property of properties) {
      const lower = property.name.toLowerCase();
      if (lower === "distinguishedname" || lower === "dn") {
        dn = property.values[0]?.trim() ?? "";
        continue;
      }
      if (lower === "objectclass") {
        // Get-AD* 的 objectClass 是继承链数组；保留全部（服务器可接受子集），
        // PS 侧单值时同样成立。
        attributes["objectClass"] = property.values.filter(Boolean);
        continue;
      }
      if (PS_COMPUTED_SKIP.has(lower)) {
        droppedProperties.add(property.name);
        continue;
      }
      const target = ldapAttributeName(property.name);
      if (target == null) continue;
      const values = convertPsValue(property.name, property.values.filter((value) => value.trim() !== ""), warnings);
      if (values.length === 0) continue;
      attributes[target] = [...(attributes[target] ?? []), ...values];
    }
    if (!dn) warnings.push("dn");
    return { dn, attributes, warnings };
  });

  if (droppedProperties.size > 0) {
    notes.push(`skipped: ${[...droppedProperties].join(", ")}`);
  }
  const kept = entries.filter((entry) => entry.dn !== "" || Object.keys(entry.attributes).length > 0);
  return { entries: kept, notes };
}

// re-export 供 UI 侧预览 GUID/SID 解码复用（保持 adValues 单一来源）。
export { formatObjectGuid, formatObjectSid };
