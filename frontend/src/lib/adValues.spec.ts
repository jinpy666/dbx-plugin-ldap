// lib/adValues 纯函数单测：objectGUID 混合端序 UUID、objectSid 结构解码
//（大端 authority + 小端 subAuthority）、非法输入降级。
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "./binaryValue";
import { formatObjectGuid, formatObjectSid, objectGuidDisplay, objectSidDisplay } from "./adValues";

const bytes = (...values: number[]) => Uint8Array.from(values);
const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{2}/gu)!.map((h) => parseInt(h, 16)));
/** 按部件构造 SID 二进制（authority 固定 5，subAuthority 小端）。 */
const buildSid = (subAuthorities: number[]) =>
  bytes(
    1,
    subAuthorities.length,
    0, 0, 0, 0, 0, 5,
    ...subAuthorities.flatMap((value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]),
  );

describe("formatObjectGuid", () => {
  it("applies Windows mixed-endian layout (Data1..Data3 little-endian)", () => {
    // GUID 12345678-1234-1234-1234-123456789abc 的 AD 二进制形态：
    // Data1/Data2/Data3 各自小端，Data4/Data5 原序
    const guid = formatObjectGuid(hexToBytes("78563412341234121234123456789abc"));
    expect(guid).toBe("12345678-1234-1234-1234-123456789abc");
  });

  it("rejects wrong lengths", () => {
    expect(formatObjectGuid(bytes(1, 2, 3))).toBe("");
    expect(formatObjectGuid(bytes(...Array(17).fill(0)))).toBe("");
  });
});

describe("formatObjectSid", () => {
  it("decodes the canonical S-1-5-21 domain SID structure", () => {
    const sid = formatObjectSid(buildSid([21, 2127521184, 1604012920, 1887927527]));
    expect(sid).toBe("S-1-5-21-2127521184-1604012920-1887927527");
  });

  it("decodes a hand-built SID byte-exactly", () => {
    // S-1-5-32-544 (BUILTIN\Administrators)
    const sid = formatObjectSid(bytes(1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0));
    expect(sid).toBe("S-1-5-32-544");
  });

  it("rejects bad revision / truncated buffers / count overflow", () => {
    expect(formatObjectSid(bytes(2, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0))).toBe("");
    expect(formatObjectSid(bytes(1, 2, 0, 0, 0, 0, 0, 5, 32))).toBe("");
    expect(formatObjectSid(bytes(1, 16, 0, 0, 0, 0, 0, 5))).toBe("");
    expect(formatObjectSid(bytes())).toBe("");
  });
});

describe("base64 display wrappers", () => {
  it("decodes base64 input and degrades to empty on invalid base64", () => {
    expect(objectGuidDisplay(bytesToBase64(hexToBytes("78563412341234121234123456789abc")))).toBe(
      "12345678-1234-1234-1234-123456789abc",
    );
    expect(objectSidDisplay(bytesToBase64(buildSid([21, 2127521184, 1604012920, 1887927527])))).toBe(
      "S-1-5-21-2127521184-1604012920-1887927527",
    );
    expect(objectGuidDisplay("!!not-base64!!")).toBe("");
    expect(objectSidDisplay("c3R1ZmY=")).toBe(""); // "stuff" — 5 字节非 SID 结构
  });
});
