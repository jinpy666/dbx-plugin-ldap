// lib/generalizedTime 纯函数单测：RFC 4517 解析（完整/省秒/偏移/容错）、
// 格式化、形态判断、datetime-local 双向转换。
import { describe, expect, it } from "vitest";
import {
  formatGeneralizedTime,
  generalTimeDisplay,
  isGeneralizedTimeShape,
  parseDatetimeLocalValue,
  parseGeneralizedTime,
  toDatetimeLocalValue,
} from "./generalizedTime";

describe("parseGeneralizedTime", () => {
  it("parses full UTC form", () => {
    const date = parseGeneralizedTime("20260102030405Z");
    expect(date).not.toBeNull();
    expect(date!.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("parses minute-precision and fractional seconds", () => {
    expect(parseGeneralizedTime("202601020304Z")!.toISOString()).toBe("2026-01-02T03:04:00.000Z");
    expect(parseGeneralizedTime("20260102030405.5Z")!.getUTCMilliseconds()).toBe(500);
    expect(parseGeneralizedTime("20260102030405.123456Z")!.getUTCMilliseconds()).toBe(123);
  });

  it("parses +/-HHMM offsets into UTC", () => {
    expect(parseGeneralizedTime("20260102030405+0800")!.toISOString()).toBe("2026-01-01T19:04:05.000Z");
    expect(parseGeneralizedTime("20260102030405-0500")!.toISOString()).toBe("2026-01-02T08:04:05.000Z");
    expect(parseGeneralizedTime("20260102030405+08")!.toISOString()).toBe("2026-01-01T19:04:05.000Z");
  });

  it("treats a missing timezone as UTC (lenient)", () => {
    expect(parseGeneralizedTime("20260102030405")!.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("rejects impossible calendar dates (Feb 30 gets normalized by Date)", () => {
    expect(parseGeneralizedTime("20260230000000Z")).toBeNull();
    expect(parseGeneralizedTime("20261301000000Z")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseGeneralizedTime("")).toBeNull();
    expect(parseGeneralizedTime("not-a-time")).toBeNull();
    expect(parseGeneralizedTime("2026-01-02T03:04:05Z")).toBeNull();
  });
});

describe("formatGeneralizedTime", () => {
  it("round-trips through UTC with second precision", () => {
    expect(formatGeneralizedTime(parseGeneralizedTime("20260102030405Z")!)).toBe("20260102030405Z");
  });

  it("normalizes offsets to Z", () => {
    expect(formatGeneralizedTime(parseGeneralizedTime("20260102030405+0800")!)).toBe("20260101190405Z");
  });

  it("pads single-digit components", () => {
    expect(formatGeneralizedTime(new Date(Date.UTC(2026, 0, 3, 4, 5, 6)))).toBe("20260103040506Z");
  });
});

describe("isGeneralizedTimeShape", () => {
  it("accepts shape-valid strings including invalid calendar dates", () => {
    expect(isGeneralizedTimeShape("20260102030405Z")).toBe(true);
    expect(isGeneralizedTimeShape("20260230000000Z")).toBe(true);
    expect(isGeneralizedTimeShape("hello")).toBe(false);
    expect(isGeneralizedTimeShape("20260102")).toBe(true);
  });
});

describe("display helpers", () => {
  it("generalTimeDisplay renders non-empty for valid and empty for invalid", () => {
    expect(generalTimeDisplay("20260102030405Z")).not.toBe("");
    expect(generalTimeDisplay("nope")).toBe("");
  });
});

describe("datetime-local conversions", () => {
  it("round-trips local wall clock with seconds at field level", () => {
    const local = "2026-01-02T03:04:05";
    const date = parseDatetimeLocalValue(local)!;
    expect(toDatetimeLocalValue(date)).toBe(local);
  });

  it("still parses minute-only datetime-local values (seconds default 0)", () => {
    const date = parseDatetimeLocalValue("2026-01-02T03:04")!;
    expect(toDatetimeLocalValue(date)).toBe("2026-01-02T03:04:00");
  });

  it("maps UTC-based generalized time through local zone both ways", () => {
    const date = parseGeneralizedTime("20260102030405Z")!;
    const localValue = toDatetimeLocalValue(date);
    expect(parseDatetimeLocalValue(localValue)).not.toBeNull();
  });

  it("rejects garbage datetime-local input", () => {
    expect(parseDatetimeLocalValue("nope")).toBeNull();
    expect(parseDatetimeLocalValue("2026-13-02T03:04")).toBeNull();
  });
});
