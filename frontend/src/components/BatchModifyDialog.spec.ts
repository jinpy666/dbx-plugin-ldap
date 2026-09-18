// @vitest-environment happy-dom
// BatchModifyDialog workbench UI tests：关闭不渲染、affected 计数、属性名/值校验
// （缺属性/缺值禁确认且不发 confirm、delete 允许空值）、confirm payload 形状
// （值按行拆分、空行剔除、属性名 trim、delete 固定 values=[]）、submitting 在途
// 禁用与 Esc 否决、各关闭通道、打开时重置表单。
// 文案断言一律用 t() 动态取值：i18n.ts 里 batchModify.* 七语段落值存在跨语言
// 错位（预置数据问题，另行修复），硬编码 zh-CN 字符串会随数据修复而失效。
import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import BatchModifyDialog from "./BatchModifyDialog.vue";
import { t } from "../lib/i18n";

const DNS = ["cn=alice,dc=demo,dc=dbx", "cn=Bob,dc=demo,dc=dbx"];

const tracked: Array<ReturnType<typeof mount<typeof BatchModifyDialog>>> = [];

function trackDialog(props: { open: boolean; dns?: string[]; submitting?: boolean }) {
  const wrapper = mount(BatchModifyDialog, { props: { dns: [], ...props } });
  tracked.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const confirmButton = (wrapper: ReturnType<typeof mount<typeof BatchModifyDialog>>) =>
  wrapper.findAll("footer button").find((button) => button.classes().includes("primary-button"))!;
const cancelButton = (wrapper: ReturnType<typeof mount<typeof BatchModifyDialog>>) =>
  wrapper.findAll("footer button").find((button) => button.text() === "取消")!;

async function typeAttribute(wrapper: ReturnType<typeof mount<typeof BatchModifyDialog>>, value: string) {
  await wrapper.find(".attribute-input").setValue(value);
}

async function typeValues(wrapper: ReturnType<typeof mount<typeof BatchModifyDialog>>, value: string) {
  await wrapper.find(".values-input").setValue(value);
}

async function pickOperation(
  wrapper: ReturnType<typeof mount<typeof BatchModifyDialog>>,
  value: "add" | "replace" | "delete",
) {
  await wrapper.find(".operation-select").setValue(value);
}

const pressEscape = () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

describe("BatchModifyDialog", () => {
  it("renders nothing while closed", () => {
    const wrapper = trackDialog({ open: false, dns: DNS });
    expect(wrapper.find(".modal-backdrop").exists()).toBe(false);
  });

  it("shows the title and the affected-entry count", () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    expect(wrapper.find("h2").text()).toBe(t("batchModify.title"));
    expect(wrapper.find(".confirm-copy").text()).toBe(t("batchModify.affected", { count: 2 }));
  });

  it("keeps the confirm button disabled without an attribute name and shows the inline error", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    expect(wrapper.find(".attribute-input").attributes("aria-invalid")).toBe("true");
    expect(wrapper.find(".form-error").text()).toBe(t("batchModify.needAttribute"));
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
    await typeAttribute(wrapper, "mail");
    expect(wrapper.find(".attribute-input").attributes("aria-invalid")).toBe("false");
    // 属性名补上后（add 仍无值），剩余的行内错误切换为 needValue。
    expect(wrapper.find(".form-error").text()).toBe(t("batchModify.needValue"));
  });

  it("requires at least one value for add/replace but not for delete", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    await typeAttribute(wrapper, "mail");
    // add 且无值：行内错误 + 禁确认。
    expect(wrapper.find(".form-error").text()).toBe(t("batchModify.needValue"));
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
    // delete 可空：错误消失、确认可用。
    await pickOperation(wrapper, "delete");
    expect(wrapper.find(".form-error").exists()).toBe(false);
    expect(confirmButton(wrapper).attributes("disabled")).toBeUndefined();
    // 换回 replace 且仍无值：重新出现错误并禁确认。
    await pickOperation(wrapper, "replace");
    expect(wrapper.find(".form-error").text()).toBe(t("batchModify.needValue"));
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
  });

  it("emits confirm with values split per line and blank lines dropped for add", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    await pickOperation(wrapper, "add");
    await typeAttribute(wrapper, " mail ");
    await typeValues(wrapper, "a@demo.dbx\n\n  \nb@demo.dbx\n\n");
    await confirmButton(wrapper).trigger("click");
    expect(wrapper.emitted("confirm")).toHaveLength(1);
    expect(wrapper.emitted("confirm")![0]).toEqual([
      { operation: "add", attribute: "mail", values: ["a@demo.dbx", "b@demo.dbx"] },
    ]);
  });

  it("emits confirm with operation replace", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    await pickOperation(wrapper, "replace");
    await typeAttribute(wrapper, "description");
    await typeValues(wrapper, "updated");
    await confirmButton(wrapper).trigger("click");
    expect(wrapper.emitted("confirm")![0]).toEqual([
      { operation: "replace", attribute: "description", values: ["updated"] },
    ]);
  });

  it("emits confirm with an empty values array for delete (whole-attribute delete contract)", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    await pickOperation(wrapper, "delete");
    await typeAttribute(wrapper, "description");
    // 即使误填了值，delete 契约也固定 values=[]（删除整个属性，不提供按值删除）。
    await typeValues(wrapper, "ignored");
    await confirmButton(wrapper).trigger("click");
    expect(wrapper.emitted("confirm")![0]).toEqual([
      { operation: "delete", attribute: "description", values: [] },
    ]);
    expect(wrapper.find(".hint").text()).toBe(t("batchModify.valuesHint"));
  });

  it("does not emit confirm while validation fails", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    // 无属性名：点击确认按钮（disabled 也尝试触发）不发 confirm。
    await confirmButton(wrapper).trigger("click");
    // 只有属性名、add 无值：同样不发。
    await typeAttribute(wrapper, "mail");
    await confirmButton(wrapper).trigger("click");
    expect(wrapper.emitted("confirm")).toBeUndefined();
  });

  it("disables the confirm button with an ellipsis while submitting and vetoes Esc", async () => {
    const wrapper = trackDialog({ open: false, dns: DNS, submitting: true });
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    const button = confirmButton(wrapper);
    expect(button.text()).toBe("…");
    expect(button.attributes("disabled")).toBeDefined();
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toBeUndefined();
    // 显式关闭通道（✕ / 取消）在提交在途时仍可用，与 BatchMoveDialog 一致。
    await wrapper.find(".icon-button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("closes via Escape, cancel and the header ✕ when not submitting", async () => {
    const wrapper = trackDialog({ open: false, dns: DNS });
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toHaveLength(1);
    await cancelButton(wrapper).trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(2);
    await wrapper.find(".icon-button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(3);
  });

  it("closes via backdrop self-click while closable, not on inner clicks", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    await wrapper.find(".modal").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.find(".modal-backdrop").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("resets the form each time it opens", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    await pickOperation(wrapper, "replace");
    await typeAttribute(wrapper, "mail");
    await typeValues(wrapper, "a@demo.dbx");
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    expect((wrapper.find(".operation-select").element as HTMLSelectElement).value).toBe("add");
    expect((wrapper.find(".attribute-input").element as HTMLInputElement).value).toBe("");
    expect((wrapper.find(".values-input").element as HTMLTextAreaElement).value).toBe("");
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
  });
});
