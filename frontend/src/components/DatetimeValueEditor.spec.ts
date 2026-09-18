// @vitest-environment happy-dom
// DatetimeValueEditor 组件测试：generalizedTime / FILETIME 双模式的原始值
// 编辑回写、日期选择器回写（原始格式落地）、step=1 时分秒字段、哨兵值与
// 非法值提示。走查定稿后行内只有原始值 + 选择器：无「现在」按钮、无预览行。
// t() 对未知键原样透传，断言匹配键名。
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

  it("renders only raw value and picker: no preview line, no 'now' button", () => {
    const wrapper = track({ modelValue: "20260102030405Z" });
    expect(wrapper.find(".datetime-preview").exists()).toBe(false);
    expect(wrapper.find(".datetime-now").exists()).toBe(false);
  });

  it("flags non-GeneralizedTime input via the error hint", () => {
    const wrapper = track({ modelValue: "not-a-time" });
    expect(wrapper.find(".form-error").exists()).toBe(true);
  });

  it("picker writes back a normalized GeneralizedTime raw string", async () => {
    const wrapper = track({ modelValue: "" });
    // step=1：原生选择器暴露时分秒字段，与 GeneralizedTime 秒级精度对齐。
    expect(wrapper.find(PICKER).attributes("step")).toBe("1");
    await wrapper.find(PICKER).setValue("2026-01-02T03:04:05");
    const emitted = wrapper.emitted("update:modelValue")!.at(-1)![0] as string;
    // 选择器按本地时区解释、落地 UTC 原始格式；断言形状 + 可解析往返
    expect(emitted).toMatch(/^\d{14}Z$/u);
    expect(parseGeneralizedTime(emitted)).not.toBeNull();
  });
});

describe("DatetimeValueEditor (filetime)", () => {
  it("keeps raw value + empty picker for sentinels, with no preview line", () => {
    for (const sentinel of ["0", "9223372036854775807"]) {
      const wrapper = track({ modelValue: sentinel, kind: "filetime" });
      expect((wrapper.find(PICKER).element as HTMLInputElement).value).toBe("");
      expect(wrapper.find(".datetime-preview").exists()).toBe(false);
      expect(wrapper.text()).not.toMatch(/20\d\d/u);
    }
  });

  it("keeps the picker empty for sentinels (0 is not a 1601 date)", () => {
    expect((track({ modelValue: "0", kind: "filetime" }).find(PICKER).element as HTMLInputElement).value).toBe("");
    expect((track({ modelValue: "9223372036854775807", kind: "filetime" }).find(PICKER).element as HTMLInputElement).value).toBe("");
    expect((track({ modelValue: "132223104000000000", kind: "filetime" }).find(PICKER).element as HTMLInputElement).value).not.toBe("");
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
});

describe("DatetimeValueEditor disabled gating", () => {
  it("disables raw input and picker", () => {
    const wrapper = track({ modelValue: "20260102030405Z", disabled: true });
    expect((wrapper.find(RAW_INPUT).element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find(PICKER).element as HTMLInputElement).disabled).toBe(true);
  });
});
