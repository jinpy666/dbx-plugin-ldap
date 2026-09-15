/**
 * Active Directory 二进制标识值的显示解码（纯函数）。
 *
 * 行为对齐 Apache Directory Studio MSAD in-place 编辑器：
 * - objectGUID → 标准 UUID 文本（Windows 混合端序：前 3 个字段小端）；
 * - objectSid → S-1-{revision}-{authority}-{subAuthority…}（authority 6 字节
 *   大端，subAuthority 4 字节小端；MSDN CC230371 布局）；
 * - **仅显示解码，不回编码**——编辑走原始值（BinaryValueEditor 的 base64），
 *   与 ADS "Currently only getDisplayValue() is implemented" 一致。
 * 输入为 BinaryValueEditor 同款 base64 值文本；解码失败返回空串（UI 回退
 * hex/base64 视图，不伪装成功）。
 */

import { base64ToBytes } from "./binaryValue";

/** Windows GUID 混合端序：Data1/Data2/Data3 小端，Data4 原序。 */
export function formatObjectGuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) return "";
  const hex = (values: Uint8Array) => [...values].map((b) => b.toString(16).padStart(2, "0")).join("");
  const data1 = hex(bytes.slice(0, 4).reverse());
  const data2 = hex(bytes.slice(4, 6).reverse());
  const data3 = hex(bytes.slice(6, 8).reverse());
  const data4 = hex(bytes.slice(8, 10));
  const data5 = hex(bytes.slice(10, 16));
  return `${data1}-${data2}-${data3}-${data4}-${data5}`.toLowerCase();
}

/** SID 二进制 → S-1-… 文本；结构非法（revision≠1、长度不符、count>15）返回空串。 */
export function formatObjectSid(bytes: Uint8Array): string {
  if (bytes.length < 8 || bytes[0] !== 1) return "";
  const subAuthorityCount = bytes[1];
  if (subAuthorityCount > 15 || bytes.length !== 8 + subAuthorityCount * 4) return "";
  // IdentifierAuthority：6 字节大端（48-bit）
  let authority = 0n;
  for (let i = 2; i < 8; i++) authority = (authority << 8n) | BigInt(bytes[i]);
  const parts: string[] = [`S-1-${authority}`];
  for (let i = 0; i < subAuthorityCount; i++) {
    const offset = 8 + i * 4;
    // SubAuthority：4 字节小端
    const value =
      bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
    parts.push(String(value >>> 0));
  }
  return parts.join("-");
}

/** base64 值文本 → GUID 显示；失败返回空串。 */
export function objectGuidDisplay(base64Value: string): string {
  try {
    return formatObjectGuid(base64ToBytes(base64Value));
  } catch {
    return "";
  }
}

/** base64 值文本 → S-1-… 显示；失败返回空串。 */
export function objectSidDisplay(base64Value: string): string {
  try {
    return formatObjectSid(base64ToBytes(base64Value));
  } catch {
    return "";
  }
}
