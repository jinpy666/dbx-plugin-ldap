// lib/filetime 纯函数单测：FILETIME ↔ Date 换算（1601 纪元）、哨兵值语义
//（0 = 未设置 / INT64_MAX = 永不，ADS 行为对齐）、形态判断、展示文本。
import { describe, expect, it } from "vitest";
import { FILETIME_MAX, dateToFiletime, filetimeDisplay, filetimeSentinelLabel, filetimeToDate, isFiletimeShape } from "./filetime";

const LABELS = { notSet: "Not set (0)", never: "Never (max)" };

describe("filetimeToDate", () => {
  it("converts the known reference value (2020-01-01T00:00:00Z)", () => {
    // 2020-01-01T00:00:00Z = 132223104000000000 (FILETIME)
    expect(filetimeToDate("132223104000000000")!.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("round-trips a Date (ms 精度无损)", () => {
    const now = new Date("2026-09-15T08:30:00.123Z");
    expect(filetimeToDate(dateToFiletime(now))!.getTime()).toBe(now.getTime());
  });

  it("accepts negative intervals (pre-1601) and whitespace", () => {
    expect(filetimeToDate(" 0 ")).not.toBeNull();
    expect(filetimeToDate("-1")).not.toBeNull();
  });

  it("rejects non-integer garbage", () => {
    expect(filetimeToDate("abc")).toBeNull();
    expect(filetimeToDate("")).toBeNull();
    expect(filetimeToDate("12.5")).toBeNull();
  });

  it("returns null beyond the Date range instead of lying", () => {
    // 远超 INT64 与 ±8.64e15 ms（±10 万年量级）的病态值
    expect(filetimeToDate("-999999999999999999999")).toBeNull();
    expect(filetimeToDate("999999999999999999999")).toBeNull();
  });
});

describe("dateToFiletime", () => {
  it("produces the epoch reference value", () => {
    // Unix epoch (1970-01-01) = 116444736000000000 FILETIME
    expect(dateToFiletime(new Date(0))).toBe("116444736000000000");
  });
});

describe("sentinels", () => {
  it("labels 0 as not-set and INT64_MAX/-1 as never (ADS convention)", () => {
    expect(filetimeSentinelLabel("0", LABELS)).toBe(LABELS.notSet);
    expect(filetimeSentinelLabel(FILETIME_MAX, LABELS)).toBe(LABELS.never);
    expect(filetimeSentinelLabel("-1", LABELS)).toBe(LABELS.never);
    expect(filetimeSentinelLabel("132223104000000000", LABELS)).toBeNull();
  });

  it("filetimeDisplay renders sentinel without a date (ADS: '0' shows no date)", () => {
    expect(filetimeDisplay("0", LABELS)).toBe(LABELS.notSet);
    expect(filetimeDisplay(FILETIME_MAX, LABELS)).toBe(LABELS.never);
  });

  it("filetimeDisplay appends the raw value for ordinary timestamps", () => {
    const display = filetimeDisplay("132223104000000000", LABELS);
    expect(display).toContain("132223104000000000");
    expect(display).not.toBe("");
  });

  it("filetimeDisplay returns empty for garbage", () => {
    expect(filetimeDisplay("xyz", LABELS)).toBe("");
    expect(filetimeDisplay("", LABELS)).toBe("");
  });
});

describe("isFiletimeShape", () => {
  it("accepts decimal integer strings only", () => {
    expect(isFiletimeShape("132223104000000000")).toBe(true);
    expect(isFiletimeShape("-5")).toBe(true);
    expect(isFiletimeShape("0x10")).toBe(false);
    expect(isFiletimeShape("")).toBe(false);
  });
});
