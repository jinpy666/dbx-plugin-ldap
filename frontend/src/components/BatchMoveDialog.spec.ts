// @vitest-environment happy-dom
// BatchMoveDialog workbench UI tests：关闭不渲染、目标 DN 校验（空/非法禁确认）、
// confirm payload、submitting 在途禁用与 Esc 否决、各关闭通道（✕ / 取消 / Esc）。
import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import BatchMoveDialog from "./BatchMoveDialog.vue";

const TARGET = "ou=people,dc=demo,dc=dbx";
const DNS = ["cn=alice,dc=demo,dc=dbx", "cn=bob,dc=demo,dc=dbx"];

const tracked: Array<ReturnType<typeof mount<typeof BatchMoveDialog>>> = [];

function trackDialog(props: { open: boolean; dns?: string[]; submitting?: boolean }) {
  const wrapper = mount(BatchMoveDialog, { props: { dns: [], ...props } });
  tracked.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const confirmButton = (wrapper: ReturnType<typeof mount<typeof BatchMoveDialog>>) =>
  wrapper.findAll("footer button").find((button) => button.classes().includes("primary-button"))!;
const cancelButton = (wrapper: ReturnType<typeof mount<typeof BatchMoveDialog>>) =>
  wrapper.findAll("footer button").find((button) => button.text() === "取消")!;

async function typeTarget(wrapper: ReturnType<typeof mount<typeof BatchMoveDialog>>, value: string) {
  await wrapper.find(".target-input").setValue(value);
}

const pressEscape = () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

describe("BatchMoveDialog", () => {
  it("renders nothing while closed", () => {
    const wrapper = trackDialog({ open: false, dns: DNS });
    expect(wrapper.find(".modal-backdrop").exists()).toBe(false);
  });

  it("shows title, confirm copy with count/target and the pending entries by RDN", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    expect(wrapper.find("h2").text()).toBe("批量移动");
    // 空输入时文案的目标段为空串，确认句仍带条目数。
    expect(wrapper.find(".confirm-copy").text()).toBe("将把 2 个条目移动到  下(保留 RDN)。");
    const items = wrapper.findAll(".move-list li");
    expect(items).toHaveLength(2);
    expect(items[0].text()).toBe("cn=alice");
    expect(items[0].attributes("title")).toBe("cn=alice,dc=demo,dc=dbx");
  });

  it("keeps the confirm button disabled for an empty or invalid target DN", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    // 空：禁确认（错误提示按契约同款展示）。
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
    expect(wrapper.find(".form-error").text()).toBe("目标不是合法的 DN");
    // 非法 DN：行内错误 + 仍禁确认。
    await typeTarget(wrapper, "not a dn");
    expect(wrapper.find(".target-input").attributes("aria-invalid")).toBe("true");
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
    expect(wrapper.find(".form-error").text()).toBe("目标不是合法的 DN");
  });

  it("emits confirm with the trimmed target parent DN for a valid input", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    await typeTarget(wrapper, ` ${TARGET} `);
    expect(wrapper.find(".target-input").attributes("aria-invalid")).toBe("false");
    expect(confirmButton(wrapper).attributes("disabled")).toBeUndefined();
    // 确认文案实时取输入值。
    expect(wrapper.find(".confirm-copy").text()).toBe(`将把 2 个条目移动到 ${TARGET} 下(保留 RDN)。`);
    await confirmButton(wrapper).trigger("click");
    expect(wrapper.emitted("confirm")).toHaveLength(1);
    expect(wrapper.emitted("confirm")![0]).toEqual([TARGET]);
  });

  it("truncates the entry list at 20 rows with a +N overflow marker", async () => {
    const dns = Array.from({ length: 23 }, (_, index) => `cn=user${index},dc=demo,dc=dbx`);
    const wrapper = trackDialog({ open: true, dns });
    const items = wrapper.findAll(".move-list li");
    expect(items).toHaveLength(21);
    expect(items.at(-1)!.classes()).toContain("move-overflow");
    expect(items.at(-1)!.text()).toBe("… +3");
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
    // 显式关闭通道（✕ / 取消）在提交在途时仍可用，与 DeleteEntryDialog 一致。
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

  it("closes via backdrop self-click while closable", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    await wrapper.find(".modal").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.find(".modal-backdrop").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("resets the target draft each time it opens", async () => {
    const wrapper = trackDialog({ open: true, dns: DNS });
    await typeTarget(wrapper, TARGET);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    expect((wrapper.find(".target-input").element as HTMLInputElement).value).toBe("");
    expect(confirmButton(wrapper).attributes("disabled")).toBeDefined();
  });
});
