// @vitest-environment happy-dom
// DatetimeValueEditor 组件测试：generalizedTime / FILETIME 双模式的原始值
// 编辑回写、日期选择（type=date 原生日历）+ 时/分/秒数字输入（WebKit 的
// datetime-local 弹窗没有时段编辑，不能依赖）、时区后缀选择器、哨兵值与
// 非法值提示。t() 对未知键原样透传，断言匹配键名。
import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DatetimeValueEditor from "./DatetimeValueEditor.vue";
import { dateToFiletime } from "../lib/filetime";

const tracked: Awaited<ReturnType<typeof mountEditor>>[] = [];

type EditorProps = { modelValue?: string; kind?: "datetime" | "filetime"; disabled?: boolean };

const mountEditor = (props: EditorProps = {}) => mount(DatetimeValueEditor, { props: { modelValue: "", kind: "datetime", ...props } });

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = (props?: EditorProps) => {
  const wrapper = mountEditor(props);
  tracked.push(wrapper);
  return wrapper;
};

const RAW_INPUT = ".datetime-raw";
const DATE = ".datetime-date";
const HOUR = ".datetime-hour";
const MINUTE = ".datetime-minute";
const SECOND = ".datetime-second";
const ZONE = ".datetime-zone";

const lastEmit = (wrapper: Awaited<ReturnType<typeof mountEditor>>) => wrapper.emitted("update:modelValue")?.at(-1)?.[0] as string | undefined;

describe("DatetimeValueEditor (generalizedTime)", () => {
  it("renders the raw value and writes edits back verbatim", async () => {
    const wrapper = track({ modelValue: "20260924093000Z" });
    expect((wrapper.find(RAW_INPUT).element as HTMLInputElement).value).toBe("20260924093000Z");
    await wrapper.find(RAW_INPUT).setValue("20260924093001Z");
    expect(lastEmit(wrapper)).toBe("20260924093001Z");
  });

  it("renders only raw value and pickers: no preview line, no 'now' button", () => {
    const wrapper = track({ modelValue: "20260924093000Z" });
    expect(wrapper.find(".datetime-preview").exists()).toBe(false);
    expect(wrapper.find(".datetime-now").exists()).toBe(false);
  });

  it("flags non-GeneralizedTime input via the error hint", () => {
    const wrapper = track({ modelValue: "not-a-time" });
    expect(wrapper.find(".form-error").exists()).toBe(true);
  });

  // 墙上时钟语义：控件显示原值自身字段（所见即存储，不做时区换算）。
  it("renders date and h/m/s fields from the value's own wall clock", () => {
    const wrapper = track({ modelValue: "20260924093000+0800" });
    expect((wrapper.find(DATE).element as HTMLInputElement).value).toBe("2026-09-24");
    expect(Number((wrapper.find(HOUR).element as HTMLInputElement).value)).toBe(9);
    expect(Number((wrapper.find(MINUTE).element as HTMLInputElement).value)).toBe(30);
    expect(Number((wrapper.find(SECOND).element as HTMLInputElement).value)).toBe(0);
  });

  it("date edit keeps the wall time and the value's zone suffix", async () => {
    const wrapper = track({ modelValue: "20260924093000+0800" });
    await wrapper.find(DATE).setValue("2026-09-25");
    expect(lastEmit(wrapper)).toBe("20260925093000+0800");
  });

  it("hour/minute/second edits write back with the zone suffix preserved", async () => {
    const hourWrapper = track({ modelValue: "20260924093000+0800" });
    await hourWrapper.find(HOUR).setValue("1");
    expect(lastEmit(hourWrapper)).toBe("20260924013000+0800");
    const minuteWrapper = track({ modelValue: "20260924093000+0800" });
    await minuteWrapper.find(MINUTE).setValue("31");
    expect(lastEmit(minuteWrapper)).toBe("20260924093100+0800");
    const secondWrapper = track({ modelValue: "20260924093000+0800" });
    await secondWrapper.find(SECOND).setValue("7");
    expect(lastEmit(secondWrapper)).toBe("20260924093007+0800");
  });

  it("keeps a suffix-less value suffix-less on edit", async () => {
    const wrapper = track({ modelValue: "20260102030405" });
    await wrapper.find(SECOND).setValue("6");
    expect(lastEmit(wrapper)).toBe("20260102030406");
  });

  it("ignores out-of-range or empty time fields (no emit)", async () => {
    const wrapper = track({ modelValue: "20260924093000Z" });
    await wrapper.find(HOUR).setValue("24");
    await wrapper.find(MINUTE).setValue("60");
    await wrapper.find(SECOND).setValue("");
    await wrapper.find(HOUR).setValue("abc");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("seeding from an empty value defaults the wall time to 00:00:00 and zone to UTC", async () => {
    const wrapper = track({ modelValue: "" });
    await wrapper.find(DATE).setValue("2026-09-24");
    expect(lastEmit(wrapper)).toBe("20260924000000Z");
  });

  it("timezone selector defaults to the value's suffix and rewrites only the suffix", async () => {
    const wrapper = track({ modelValue: "20260924093000+0800" });
    expect((wrapper.find(ZONE).element as HTMLSelectElement).value).toBe("+0800");
    await wrapper.find(ZONE).setValue("Z");
    expect(lastEmit(wrapper)).toBe("20260924093000Z");
  });
});

describe("DatetimeValueEditor (filetime)", () => {
  it("keeps date and time fields empty for sentinels (0 / INT64_MAX)", () => {
    for (const sentinel of ["0", "9223372036854775807"]) {
      const wrapper = track({ modelValue: sentinel, kind: "filetime" });
      expect((wrapper.find(DATE).element as HTMLInputElement).value).toBe("");
      expect((wrapper.find(HOUR).element as HTMLInputElement).value).toBe("");
      expect(wrapper.text()).not.toMatch(/20\d\d/u);
    }
  });

  it("renders local wall fields for real ticks and hides the timezone selector", () => {
    const wrapper = track({ modelValue: "132223104000000000", kind: "filetime" });
    expect((wrapper.find(DATE).element as HTMLInputElement).value).not.toBe("");
    expect(wrapper.find(ZONE).exists()).toBe(false);
  });

  it("date + time edits write back a FILETIME raw string", async () => {
    const wrapper = track({ modelValue: "", kind: "filetime" });
    await wrapper.find(DATE).setValue("2026-09-24");
    const ticks = lastEmit(wrapper)!;
    expect(ticks).toMatch(/^\d{17,19}$/u);
    expect(BigInt(ticks)).toBe(BigInt(dateToFiletime(new Date(2026, 8, 24, 0, 0, 0))));
  });

  it("flags non-integer filetime input", () => {
    const wrapper = track({ modelValue: "abc", kind: "filetime" });
    expect(wrapper.find(".form-error").exists()).toBe(true);
  });
});

describe("DatetimeValueEditor disabled gating", () => {
  it("disables raw input, date, time fields and zone selector", () => {
    const wrapper = track({ modelValue: "20260924093000+0800", disabled: true });
    expect((wrapper.find(RAW_INPUT).element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find(DATE).element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find(HOUR).element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find(MINUTE).element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find(SECOND).element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find(ZONE).element as HTMLSelectElement).disabled).toBe(true);
  });
});
