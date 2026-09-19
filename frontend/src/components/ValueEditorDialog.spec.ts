// @vitest-environment happy-dom
// ValueEditorDialog：特殊类型值的弹窗编辑壳（ADS 交互）。职责边界：打开
// 瞬间把 modelValue 拷进草稿，OK 才 emit confirm 写回，Cancel 只 close 不落值；
// binary 按数组进出（一行一值），弹窗统一字符串语义按 \n 切分/合并。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ValueEditorDialog from "./ValueEditorDialog.vue";
import type { ValueDialogKind } from "./ValueEditorDialog.vue";

interface DialogProps {
  open: boolean;
  kind: ValueDialogKind;
  attributeName?: string;
  modelValue: string;
  disabled?: boolean;
  baseDn?: string;
  dn?: string;
}

const mountDialog = (props: DialogProps) => mount(ValueEditorDialog, { props });

describe("ValueEditorDialog", () => {
  it("copies the value into the inner editor draft on open and confirms the edited value", async () => {
    const wrapper = mountDialog({ open: false, kind: "datetime", attributeName: "seen", modelValue: "20260102030405Z" });
    await wrapper.setProps({ open: true });
    const raw = wrapper.find(".datetime-raw");
    expect((raw.element as HTMLInputElement).value).toBe("20260102030405Z");
    await raw.setValue("20270101000000Z");
    await wrapper.find(".value-editor-confirm").trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual(["20270101000000Z"]);
  });

  it("does not confirm on cancel and resets the draft from modelValue on reopen", async () => {
    const wrapper = mountDialog({ open: false, kind: "datetime", attributeName: "seen", modelValue: "20260102030405Z" });
    await wrapper.setProps({ open: true });
    await wrapper.find(".datetime-raw").setValue("9999");
    await wrapper.find(".value-editor-cancel").trigger("click");
    expect(wrapper.emitted("confirm")).toBeUndefined();
    expect(wrapper.emitted("close")?.length).toBe(1);
    // 重开：草稿回到 modelValue，上次的编辑不残留。
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    expect((wrapper.find(".datetime-raw").element as HTMLInputElement).value).toBe("20260102030405Z");
  });

  it("bridges the binary editor's array values through the string draft", async () => {
    const wrapper = mountDialog({ open: true, kind: "binary", attributeName: "photo", modelValue: "abc\ndef" });
    const editor = wrapper.findComponent({ name: "BinaryValueEditor" });
    expect(editor.exists()).toBe(true);
    expect(editor.props("modelValue")).toEqual(["abc", "def"]);
    editor.vm.$emit("update:modelValue", ["xy"]);
    await wrapper.vm.$nextTick();
    await wrapper.find(".value-editor-confirm").trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual(["xy"]);
  });

  it("shows the format label as dialog title", () => {
    const wrapper = mountDialog({ open: true, kind: "dn", attributeName: "manager", modelValue: "cn=bob,dc=demo,dc=dbx" });
    expect(wrapper.find("[role='dialog']").attributes("aria-label")).toBe("DN");
    expect(wrapper.text()).toContain("manager");
  });

  it("relays the binary editor's notify events (copy decoded, upload errors)", async () => {
    const wrapper = mountDialog({ open: true, kind: "binary", attributeName: "objectGUID", modelValue: "abc" });
    wrapper.findComponent({ name: "BinaryValueEditor" }).vm.$emit("notify", "已复制");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("notify")?.[0]).toEqual(["已复制"]);
  });
});
