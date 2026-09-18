import { mustAttributesFor, type LdapSchema } from "./newEntryTemplates";
import type { AttributeValueKind } from "./valueKinds";
import { parseGeneralizedTime } from "./generalizedTime";
import { isLikelyDn } from "./dn";

type Attributes = Record<string, string[]>;
const keyOf = (name: string) => name.split(";")[0].trim().toLowerCase();

/**
 * 值类型轻校验警告（保存前提示、不阻断）。key 为 i18n 文案键，params 为
 * 插值参数；kind 是 valueKinds 注册表的原始标识，展示层自行映射显示名
 *（如 EntryEditorDialog 的 formatXxx 文案）。
 */
export interface ValueKindWarning {
  key: "editor.valueKindWarning";
  params: { kind: string };
}

// RFC 4122 UUID：版本位 1-5、variant 位 10x，大小写不敏感。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// 点分数字 OID（RFC 4512 dottedDecimal，与编辑器行内校验同形）。
const OID_RE = /^\d+(?:\.\d+)+$/u;

function warn(kind: AttributeValueKind): ValueKindWarning {
  return { key: "editor.valueKindWarning", params: { kind } };
}

/**
 * 保存前的值类型轻校验（宁缺毋滥）：只对有明确形状的 kind 做单值判断，
 * 命中失败返回警告（不阻断保存，服务器才是权威）；无形状约束的 kind
 *（text/binary/password/uac/guid/sid）恒通过。空值等价删除值，视为通过。
 */
export function validateValueKind(kind: AttributeValueKind, value: string): ValueKindWarning | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  switch (kind) {
    case "integer":
      return /^-?\d+$/u.test(text) ? null : warn(kind);
    case "boolean":
      return text === "TRUE" || text === "FALSE" ? null : warn(kind);
    case "datetime":
      return parseGeneralizedTime(text) ? null : warn(kind);
    case "dn":
      return isLikelyDn(text) ? null : warn(kind);
    case "filetime":
      return /^\d+$/u.test(text) ? null : warn(kind);
    case "uuid":
      return UUID_RE.test(text) ? null : warn(kind);
    case "oid":
      return OID_RE.test(text) ? null : warn(kind);
    default:
      return null;
  }
}

function valuesFor(attributes: Attributes, name: string): string[] {
  const key = keyOf(name);
  return Object.entries(attributes)
    .filter(([attribute]) => keyOf(attribute) === key)
    .flatMap(([, values]) => values)
    .filter((value) => value.trim() !== "");
}

/**
 * Preflight only requirements affected by this edit. Existing entries may omit
 * MUST attributes because of ACLs/policy; their absence alone must not force a
 * replacement value. Adding an objectClass can introduce new requirements.
 */
export function missingRequiredAttributes(current: Attributes, original?: Attributes, schema?: LdapSchema): string[] {
  const required = ["objectClass", ...mustAttributesFor(valuesFor(current, "objectClass"), schema)];
  const previouslyRequired = new Set([
    "objectclass",
    ...mustAttributesFor(valuesFor(original ?? {}, "objectClass"), schema).map(keyOf),
  ]);
  return required.filter((name) => {
    const previouslyVisible = original !== undefined && valuesFor(original, name).length > 0;
    // An objectClass edit must never force replacement of an unreadable secret.
    if (original && !previouslyVisible && /password|unicodepwd/iu.test(keyOf(name))) return false;
    return valuesFor(current, name).length === 0 && (
      original === undefined || previouslyVisible || !previouslyRequired.has(keyOf(name))
    );
  });
}
