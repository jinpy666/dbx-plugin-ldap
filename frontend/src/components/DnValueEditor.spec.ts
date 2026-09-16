// @vitest-environment happy-dom
// DnValueEditor 组件测试：值回写、非法 DN 形态提示（非阻断）、树选择弹窗
// 打开/回填、无 baseDn 时选择入口禁用。DnPickerDialog 打 stub。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import DnValueEditor from "./DnValueEditor.vue";

vi.mock("./DnPickerDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "DnPickerDialog",
      props: { open: { type: Boolean, default: false }, baseDn: { type: String, default: "" } },
      emits: ["close", "select"],
      setup(props, { emit }) {
        return () =>
          props.open
            ? h("div", { class: "dn-picker-stub" }, [
                h("button", { class: "picker-pick", onClick: () => emit("select", "cn=picked,dc=demo,dc=dbx") }),
              ])
            : null;
      },
    }),
  };
});

const tracked: Awaited<ReturnType<typeof mountEditor>>[] = [];

function mountEditor(props: { modelValue?: string; disabled?: boolean; baseDn?: string } = {}) {
  return mount(DnValueEditor, { props: { modelValue: "", baseDn: "dc=demo,dc=dbx", ...props } });
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = (props?: Parameters<typeof mountEditor>[0]) => {
  const wrapper = mountEditor(props);
  tracked.push(wrapper);
  return wrapper;
};

const INPUT = ".dn-input";
const PICK_BUTTON = ".dn-controls .toolbar-button:not(.dn-open-reference)";
const OPEN_BUTTON = ".dn-open-reference";

describe("DnValueEditor", () => {
  it("renders the value and writes edits back verbatim", async () => {
    const wrapper = track({ modelValue: "cn=a,dc=demo,dc=dbx" });
    expect((wrapper.find(INPUT).element as HTMLInputElement).value).toBe("cn=a,dc=demo,dc=dbx");
    await wrapper.find(INPUT).setValue("cn=b,dc=demo,dc=dbx");
    expect(wrapper.emitted("update:modelValue")![0]).toEqual(["cn=b,dc=demo,dc=dbx"]);
  });

  it("shows a non-blocking shape hint for DN-looking garbage", () => {
    expect(track({ modelValue: "not a dn" }).find(".form-error").exists()).toBe(true);
    expect(track({ modelValue: "cn=a,dc=demo,dc=dbx" }).find(".form-error").exists()).toBe(false);
    expect(track({ modelValue: "" }).find(".form-error").exists()).toBe(false);
  });

  it("opens the picker and fills the picked DN", async () => {
    const wrapper = track({ modelValue: "" });
    expect(wrapper.find(".dn-picker-stub").exists()).toBe(false);
    await wrapper.find(PICK_BUTTON).trigger("click");
    expect(wrapper.find(".dn-picker-stub").exists()).toBe(true);
    await wrapper.find(".picker-pick").trigger("click");
    expect(wrapper.emitted("update:modelValue")![0]).toEqual(["cn=picked,dc=demo,dc=dbx"]);
    // 选择后弹窗关闭（stub 收到 open=false）
    expect(wrapper.find(".dn-picker-stub").exists()).toBe(false);
  });

  it("disables the picker entry without a base DN or when disabled", () => {
    expect((track({ baseDn: "" }).find(PICK_BUTTON).element as HTMLButtonElement).disabled).toBe(true);
    expect((track({ disabled: true }).find(PICK_BUTTON).element as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the text input in disabled mode", () => {
    expect((track({ disabled: true }).find(INPUT).element as HTMLInputElement).disabled).toBe(true);
  });

  it("opens a valid reference even when value editing is disabled", async () => {
    const dn = "cn=a,dc=demo,dc=dbx";
    const wrapper = track({ modelValue: dn, disabled: true });
    expect((wrapper.find(OPEN_BUTTON).element as HTMLButtonElement).disabled).toBe(false);
    await wrapper.find(OPEN_BUTTON).trigger("click");
    expect(wrapper.emitted("openReference")?.[0]).toEqual([dn]);
  });

  it("does not open an empty or malformed reference", () => {
    expect((track({ modelValue: "" }).find(OPEN_BUTTON).element as HTMLButtonElement).disabled).toBe(true);
    expect((track({ modelValue: "not a dn" }).find(OPEN_BUTTON).element as HTMLButtonElement).disabled).toBe(true);
  });
});
