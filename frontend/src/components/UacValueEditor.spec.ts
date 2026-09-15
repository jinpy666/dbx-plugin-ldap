// @vitest-environment happy-dom
// UacValueEditor 组件测试（阶段5）：位标志渲染与勾选合成、原始值回写、
// 未知残余位显示、PASSWD_CANT_CHANGE 写入提示、非法输入报错。
import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import UacValueEditor from "./UacValueEditor.vue";

const tracked: Awaited<ReturnType<typeof mountEditor>>[] = [];

function mountEditor(props: { modelValue?: string; disabled?: boolean } = {}) {
  return mount(UacValueEditor, { props: { modelValue: "512", ...props } });
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = (props?: Parameters<typeof mountEditor>[0]) => {
  const wrapper = mountEditor(props);
  tracked.push(wrapper);
  return wrapper;
};

const flagLabel = (wrapper: Awaited<ReturnType<typeof mountEditor>>, name: string) =>
  wrapper.findAll(".uac-flag").find((label) => label.text() === name)!;
const isChecked = (wrapper: Awaited<ReturnType<typeof mountEditor>>, name: string) =>
  (flagLabel(wrapper, name).find("input").element as HTMLInputElement).checked;

describe("UacValueEditor", () => {
  it("renders the known flag set and reflects bits of the raw value", () => {
    // 512 = NORMAL_ACCOUNT, 66048 = NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD
    const wrapper = track({ modelValue: "66048" });
    expect(isChecked(wrapper, "NORMAL_ACCOUNT")).toBe(true);
    expect(isChecked(wrapper, "DONT_EXPIRE_PASSWORD")).toBe(true);
    expect(isChecked(wrapper, "ACCOUNTDISABLE")).toBe(false);
  });

  it("toggling a flag rewrites the raw decimal string", async () => {
    const wrapper = track({ modelValue: "512" });
    await flagLabel(wrapper, "ACCOUNTDISABLE").find("input").setValue(true);
    expect(wrapper.emitted("update:modelValue")![0]).toEqual(["514"]);
  });

  it("clearing a flag clears only that bit", async () => {
    const wrapper = track({ modelValue: "66048" });
    await flagLabel(wrapper, "DONT_EXPIRE_PASSWORD").find("input").setValue(false);
    expect(wrapper.emitted("update:modelValue")![0]).toEqual(["512"]);
  });

  it("preserves unknown bits as a displayed remainder", () => {
    // 512 + 0x04000000 (PARTIAL_SECRETS_ACCOUNT 已知) 之外再加 0x20000000（未知）
    const wrapper = track({ modelValue: String(0x200 | 0x20000000) });
    expect(wrapper.find(".uac-raw").text()).toContain("+0x20000000");
  });

  it("shows the PASSWD_CANT_CHANGE write hint when the bit is set", () => {
    const wrapper = track({ modelValue: String(0x200 | 0x40) });
    expect(wrapper.find(".hint").exists()).toBe(true);
    expect(track({ modelValue: "512" }).find(".hint").exists()).toBe(false);
  });

  it("flags non-integer raw input", () => {
    const wrapper = track({ modelValue: "abc" });
    expect(wrapper.find(".form-error").exists()).toBe(true);
    expect(track({ modelValue: "" }).find(".form-error").exists()).toBe(false);
  });

  it("disables checkboxes in disabled mode", () => {
    const wrapper = track({ modelValue: "512", disabled: true });
    expect((flagLabel(wrapper, "NORMAL_ACCOUNT").find("input").element as HTMLInputElement).disabled).toBe(true);
  });

  it("disables checkboxes for a non-integer raw value (no silent 512 reset)", async () => {
    const wrapper = track({ modelValue: "abc" });
    const checkbox = flagLabel(wrapper, "NORMAL_ACCOUNT").find("input");
    expect((checkbox.element as HTMLInputElement).disabled).toBe(true);
    await checkbox.setValue(true);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("keeps checkboxes usable for an empty value (starts from NORMAL_ACCOUNT)", async () => {
    const wrapper = track({ modelValue: "" });
    const checkbox = flagLabel(wrapper, "ACCOUNTDISABLE").find("input");
    expect((checkbox.element as HTMLInputElement).disabled).toBe(false);
    await checkbox.setValue(true);
    expect(wrapper.emitted("update:modelValue")![0]).toEqual(["514"]);
  });
});
