// @vitest-environment happy-dom
// CompareDialog workbench UI tests（对照 BatchModifyDialog.spec 的用例风格）：
// 关闭不渲染、DN 只读回显、属性/值必填校验（不发请求）、match/noMatch 内联
// 文案与色调、异常路径（friendlyLdapError 内联 + notify）、submitting 防重入
// 与 Esc 否决、各关闭通道、关闭重开重置表单与结果。
// 文案断言一律用 t() 动态取值（同 batch spec 约定，不硬编码语言串）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ldapApi } from "../lib/api";
import { friendlyLdapError } from "../lib/ldapErrors";
import { t } from "../lib/i18n";
import CompareDialog from "./CompareDialog.vue";

const DN = "cn=alice,dc=demo,dc=dbx";

const tracked: Array<ReturnType<typeof mount<typeof CompareDialog>>> = [];

function trackDialog(props: { open: boolean; dn?: string }) {
  const wrapper = mount(CompareDialog, { props: { dn: DN, ...props } });
  tracked.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
});

const runButton = (wrapper: ReturnType<typeof mount<typeof CompareDialog>>) =>
  wrapper.findAll("footer button").find((button) => button.classes().includes("primary-button"))!;
const cancelButton = (wrapper: ReturnType<typeof mount<typeof CompareDialog>>) =>
  wrapper.findAll("footer button").find((button) => button.text() === t("cancel"))!;

async function typeAttribute(wrapper: ReturnType<typeof mount<typeof CompareDialog>>, value: string) {
  await wrapper.find(".compare-attribute-input").setValue(value);
}

async function typeValue(wrapper: ReturnType<typeof mount<typeof CompareDialog>>, value: string) {
  await wrapper.find(".compare-value-input").setValue(value);
}

const pressEscape = () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

describe("CompareDialog", () => {
  it("renders nothing while closed", () => {
    const wrapper = trackDialog({ open: false });
    expect(wrapper.find(".modal-backdrop").exists()).toBe(false);
  });

  it("shows the title and the pre-filled read-only DN", () => {
    const wrapper = trackDialog({ open: true });
    expect(wrapper.find("h2").text()).toBe(t("compare.title"));
    const dn = wrapper.find(".compare-dn");
    expect((dn.element as HTMLInputElement).value).toBe(DN);
    expect(dn.attributes("readonly")).toBeDefined();
  });

  it("hides inline errors on open, reveals them after a submit attempt, and still blocks the run", async () => {
    const compare = vi.spyOn(ldapApi, "entryCompare");
    const wrapper = trackDialog({ open: true });
    // 打开瞬间：空字段不渲染行内红字/无效标记（视觉审计 UX-V8），按钮仍禁用。
    expect(wrapper.find(".compare-attribute-input").attributes("aria-invalid")).toBe("false");
    expect(wrapper.find(".compare-value-input").attributes("aria-invalid")).toBe("false");
    expect(wrapper.findAll(".form-error")).toHaveLength(0);
    expect(runButton(wrapper).attributes("disabled")).toBeDefined();
    // 提交尝试（输入框按 Enter）后：缺失项错误显现（aria-invalid + 行内红字）。
    await wrapper.find(".compare-attribute-input").trigger("keydown.enter");
    expect(wrapper.find(".compare-attribute-input").attributes("aria-invalid")).toBe("true");
    expect(wrapper.findAll(".form-error").map((error) => error.text())).toEqual([t("compare.needAttribute"), t("compare.needValue")]);
    // 属性名补上后仅剩值缺失错误；disabled 按钮被强点也不发请求。
    await typeAttribute(wrapper, "userPassword");
    expect(wrapper.findAll(".form-error").map((error) => error.text())).toEqual([t("compare.needValue")]);
    await runButton(wrapper).trigger("click");
    expect(compare).not.toHaveBeenCalled();
  });

  it("reveals an inline error for a field only after it has been edited", async () => {
    const wrapper = trackDialog({ open: true });
    // 属性名触碰过（编辑后清空）：属性行错误显示；值未触碰未提交，不显示。
    await typeAttribute(wrapper, "mail");
    await typeAttribute(wrapper, "");
    expect(wrapper.findAll(".form-error").map((error) => error.text())).toEqual([t("compare.needAttribute")]);
    // 值随后也被触碰：值缺失错误随之显现。
    await typeValue(wrapper, " ");
    expect(wrapper.findAll(".form-error").map((error) => error.text())).toEqual([t("compare.needAttribute"), t("compare.needValue")]);
  });

  it("shows the match verdict inline without notify on match=true", async () => {
    const compare = vi.spyOn(ldapApi, "entryCompare").mockResolvedValue({ match: true });
    const wrapper = trackDialog({ open: true });
    await typeAttribute(wrapper, " userPassword ");
    await typeValue(wrapper, "{SSHA}secret");
    await runButton(wrapper).trigger("click");
    await flushPromises();
    // 属性名 trim，值按原文发送（LDAP Compare 是精确断言）。
    expect(compare).toHaveBeenCalledWith(DN, "userPassword", "{SSHA}secret");
    const result = wrapper.find(".compare-result-match");
    expect(result.text()).toBe(t("compare.match"));
    expect(wrapper.emitted("notify")).toBeUndefined();
    expect(runButton(wrapper).attributes("disabled")).toBeUndefined();
    // 提交成功后再次编辑字段：旧断言对新输入不再成立，结果展示随之清除。
    await typeValue(wrapper, "{SSHA}other");
    expect(wrapper.find(".compare-result-match").exists()).toBe(false);
  });

  it("shows the no-match verdict inline on match=false", async () => {
    vi.spyOn(ldapApi, "entryCompare").mockResolvedValue({ match: false });
    const wrapper = trackDialog({ open: true });
    await typeAttribute(wrapper, "mail");
    await typeValue(wrapper, "a@demo.dbx");
    await runButton(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.find(".compare-result-nomatch").text()).toBe(t("compare.noMatch"));
    expect(wrapper.emitted("notify")).toBeUndefined();
  });

  it("maps request failures to a friendly inline message and emits notify once", async () => {
    const raw = 'ldap entry compare: LDAP Result Code 49 "Invalid Credentials"';
    vi.spyOn(ldapApi, "entryCompare").mockRejectedValue(new Error(raw));
    const wrapper = trackDialog({ open: true });
    await typeAttribute(wrapper, "userPassword");
    await typeValue(wrapper, "wrong");
    await runButton(wrapper).trigger("click");
    await flushPromises();
    const expected = t("compare.failed", { error: friendlyLdapError(raw) });
    expect(wrapper.find(".form-error").text()).toBe(expected);
    expect(wrapper.emitted("notify")).toEqual([[expected]]);
    // 失败后 submitting 复位，可再次比较。
    expect(runButton(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("guards against double submit while the compare request is in flight", async () => {
    let release!: (value: { match: boolean }) => void;
    vi.spyOn(ldapApi, "entryCompare").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const wrapper = trackDialog({ open: true });
    await typeAttribute(wrapper, "mail");
    await typeValue(wrapper, "a@demo.dbx");
    await runButton(wrapper).trigger("click");
    // 在途：按钮禁用显示省略号，重复点击不再发请求。
    expect(runButton(wrapper).text()).toBe("…");
    expect(runButton(wrapper).attributes("disabled")).toBeDefined();
    await runButton(wrapper).trigger("click");
    expect(ldapApi.entryCompare).toHaveBeenCalledOnce();
    release({ match: true });
    await flushPromises();
    expect(runButton(wrapper).text()).toBe(t("compare.run"));
  });

  it("closes via Escape, cancel and the header ✕ when idle", async () => {
    const wrapper = trackDialog({ open: false });
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

  it("closes via backdrop self-click while idle, not on inner clicks", async () => {
    const wrapper = trackDialog({ open: true });
    await wrapper.find(".modal").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.find(".modal-backdrop").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("vetoes Escape and backdrop while the request is in flight but keeps ✕ working", async () => {
    let release!: (value: { match: boolean }) => void;
    vi.spyOn(ldapApi, "entryCompare").mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const wrapper = trackDialog({ open: true });
    await typeAttribute(wrapper, "mail");
    await typeValue(wrapper, "a@demo.dbx");
    await runButton(wrapper).trigger("click");
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.find(".modal-backdrop").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    // 显式通道（✕）不受在途否决影响，与家族弹窗一致。
    await wrapper.find(".icon-button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    release({ match: false });
    await flushPromises();
  });

  it("resets the form and the verdict each time it opens", async () => {
    vi.spyOn(ldapApi, "entryCompare").mockResolvedValue({ match: true });
    const wrapper = trackDialog({ open: true });
    await typeAttribute(wrapper, "mail");
    await typeValue(wrapper, "a@demo.dbx");
    await runButton(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.find(".compare-result-match").exists()).toBe(true);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    expect((wrapper.find(".compare-attribute-input").element as HTMLInputElement).value).toBe("");
    expect((wrapper.find(".compare-value-input").element as HTMLInputElement).value).toBe("");
    expect(wrapper.find(".compare-result-match").exists()).toBe(false);
    expect(runButton(wrapper).attributes("disabled")).toBeDefined();
  });
});
