// @vitest-environment happy-dom
// DatetimeValueEditor 组件测试：generalizedTime / FILETIME 双模式的原始值
// 编辑回写、日期选择器回写（原始格式落地）、「现在」按钮、哨兵值与非法值
// 预览。t() 对未知键原样透传，断言匹配键名。
import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DatetimeValueEditor from "./DatetimeValueEditor.vue";
import { parseGeneralizedTime } from "../lib/generalizedTime";

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
const PICKER = ".datetime-picker";

describe("DatetimeValueEditor (generalizedTime)", () => {
  it("renders the raw value and writes edits back verbatim", async () => {
    const wrapper = track({ modelValue: "20260102030405Z" });
    expect((wrapper.find(RAW_INPUT).element as HTMLInputElement).value).toBe("20260102030405Z");
    await wrapper.find(RAW_INPUT).setValue("20260102030406Z");
    expect(wrapper.emitted("update:modelValue")![0]).toEqual(["20260102030406Z"]);
  });

  it("shows a human-readable preview for valid values and none for empty", () => {
    expect(track({ modelValue: "20260102030405Z" }).find(".datetime-preview").exists()).toBe(true);
    expect(track({ modelValue: "" }).find(".datetime-preview").exists()).toBe(false);
  });

  it("flags non-GeneralizedTime input via the error hint", () => {
    const wrapper = track({ modelValue: "not-a-time" });
    expect(wrapper.find(".form-error").exists()).toBe(true);
  });

  it("picker writes back a normalized GeneralizedTime raw string", async () => {
    const wrapper = track({ modelValue: "" });
    await wrapper.find(PICKER).setValue("2026-01-02T03:04");
    const emitted = wrapper.emitted("update:modelValue")!.at(-1)![0] as string;
    // 选择器按本地时区解释、落地 UTC 原始格式；断言形状 + 可解析往返
    expect(emitted).toMatch(/^\d{14}Z$/u);
    expect(parseGeneralizedTime(emitted)).not.toBeNull();
  });

  it("'now' button emits the current time in raw format", async () => {
    const wrapper = track({ modelValue: "" });
    await wrapper.find(".datetime-controls button").trigger("click");
    const emitted = wrapper.emitted("update:modelValue")![0][0] as string;
    expect(emitted).toMatch(/^\d{14}Z$/u);
  });
});

describe("DatetimeValueEditor (filetime)", () => {
  it("renders the sentinel label for 0 without a date", () => {
    const wrapper = track({ modelValue: "0", kind: "filetime" });
    expect(wrapper.find(".datetime-preview").text()).toContain("0");
    expect(wrapper.text()).not.toMatch(/20\d\d/u);
  });

  it("renders the never sentinel for INT64_MAX", () => {
    const wrapper = track({ modelValue: "9223372036854775807", kind: "filetime" });
    expect(wrapper.find(".datetime-preview").exists()).toBe(true);
  });

  it("picker writes back a FILETIME raw string", async () => {
    const wrapper = track({ modelValue: "", kind: "filetime" });
    await wrapper.find(PICKER).setValue("2026-01-02T03:04");
    const emitted = wrapper.emitted("update:modelValue")!.at(-1)![0] as string;
    expect(emitted).toMatch(/^\d{17,19}$/u);
  });

  it("flags non-integer filetime input", () => {
    const wrapper = track({ modelValue: "abc", kind: "filetime" });
    expect(wrapper.find(".form-error").exists()).toBe(true);
  });

  it("'now' button emits a FILETIME integer string", async () => {
    const wrapper = track({ modelValue: "", kind: "filetime" });
    await wrapper.find(".datetime-controls button").trigger("click");
    const emitted = wrapper.emitted("update:modelValue")![0][0] as string;
    expect(emitted).toMatch(/^\d+$/u);
    expect(Number(emitted)).toBeGreaterThan(130_000_000_000_000_000);
  });
});

describe("DatetimeValueEditor disabled gating", () => {
  it("disables raw input, picker and now-button", () => {
    const wrapper = track({ modelValue: "20260102030405Z", disabled: true });
    expect((wrapper.find(RAW_INPUT).element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find(PICKER).element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find(".datetime-controls button").element as HTMLButtonElement).disabled).toBe(true);
  });
});
