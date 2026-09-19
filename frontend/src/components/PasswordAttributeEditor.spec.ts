// @vitest-environment happy-dom
// PasswordAttributeEditor tests (M6 N2): scheme dropdown (default {SSHA}),
// show/hide toggle, random generation feeding the hash emit, apply emitting a
// parseable RFC 2307 value + one-shot plainGenerated, disabled gating and
// existing-value recognition. i18n keys are placeholders (merged later), and
// t() passes unknown keys through verbatim, so assertions match the raw keys.
// F3 追加：RFC 3062 扩展操作模式——切换显隐（dn/可写门禁）、开启后两个可选
// 字段、entryPasswdModify 参数契约（identity 缺省不传、oldPassword 透传）与
// 成功/失败反馈。ldapApi 在文件内 mock，不触达宿主桥。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ldapApi } from "../lib/api";

vi.mock("../lib/api", () => ({
  ldapApi: { entryPasswdModify: vi.fn() },
}));

// 兜底落地后本地哈希几乎不会失败(非安全上下文已由纯 JS 兜底覆盖),
// 失败路径只能通过模块 mock 注入拒绝来驱动(扩展路径同款做法)。
vi.mock("../lib/passwordHash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/passwordHash")>();
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});

import PasswordAttributeEditor from "./PasswordAttributeEditor.vue";
import { hashPassword, parsePasswordHash } from "../lib/passwordHash";
import { t } from "../lib/i18n";

const passwdModifyMock = vi.mocked(ldapApi.entryPasswdModify);
const hashMock = vi.mocked(hashPassword);

const SCHEME_SELECT = ".password-editor select";
const PLAIN_INPUT = ".password-editor input";
const TOGGLE_BUTTON = ".password-editor .icon-button";
const GENERATE_BUTTON = ".password-editor button:not(.icon-button):not(.primary-button)";
const APPLY_BUTTON = ".password-editor .primary-button";
// RFC 3062 扩展操作（F3）：切换复选框与可选字段组。
const EXTENDED_TOGGLE = ".password-editor input[type='checkbox']";
const EXTENDED_FIELDS = ".password-extended-fields";
const IDENTITY_INPUT = ".password-extended-fields input[type='text']";
const OLD_INPUT = ".password-extended-fields input[type='password']";

const mountEditor = (props: { modelValue?: string; disabled?: boolean; dn?: string } = {}) =>
  mount(PasswordAttributeEditor, { props: { modelValue: "", ...props } });

const tracked: Awaited<ReturnType<typeof mountEditor>>[] = [];

beforeEach(() => {
  passwdModifyMock.mockReset();
  hashMock.mockClear();
});

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = (props?: { modelValue?: string; disabled?: boolean; dn?: string }) => {
  const wrapper = mountEditor(props);
  tracked.push(wrapper);
  return wrapper;
};

const setScheme = async (wrapper: Awaited<ReturnType<typeof mountEditor>>, scheme: string) => {
  await wrapper.find(SCHEME_SELECT).setValue(scheme);
};

// apply 内部先 await Web Crypto digest 再 emit；subtle.digest 可能跨事件
// 循环轮次，单个 flushPromises 不保证等到，用 vi.waitFor 轮询 emit 落地。
const applyAndWait = async (wrapper: Awaited<ReturnType<typeof mountEditor>>) => {
  await wrapper.find(APPLY_BUTTON).trigger("click");
  await vi.waitFor(() => expect(wrapper.emitted("update:modelValue")).toBeDefined());
  await flushPromises();
};

describe("PasswordAttributeEditor", () => {
  it("defaults the scheme dropdown to {SSHA} and starts with an empty password", () => {
    const wrapper = track();
    expect((wrapper.find(SCHEME_SELECT).element as HTMLSelectElement).value).toBe("{SSHA}");
    expect(wrapper.find(SCHEME_SELECT).findAll("option")).toHaveLength(7);
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value).toBe("");
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).type).toBe("password");
    // 空存储值：不显示任何"现有值"提示。
    expect(wrapper.find(".hint").exists()).toBe(false);
    expect(wrapper.find(".form-error").exists()).toBe(false);
    expect(wrapper.find(".password-editor").attributes("data-scheme")).toBe("");
  });

  it("keeps the apply button disabled until a password is entered", async () => {
    const wrapper = track();
    expect((wrapper.find(APPLY_BUTTON).element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.find(PLAIN_INPUT).setValue("password");
    expect((wrapper.find(APPLY_BUTTON).element as HTMLButtonElement).disabled).toBe(false);
  });

  it("toggles the password input between hidden and visible", async () => {
    const wrapper = track();
    await wrapper.find(PLAIN_INPUT).setValue("password");
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).type).toBe("password");
    expect((wrapper.find(TOGGLE_BUTTON).element as HTMLButtonElement).disabled).toBe(false);
    await wrapper.find(TOGGLE_BUTTON).trigger("click");
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).type).toBe("text");
    await wrapper.find(TOGGLE_BUTTON).trigger("click");
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).type).toBe("password");
  });

  it("hashes on apply with the selected scheme and emits a parseable value", async () => {
    const wrapper = track();
    await setScheme(wrapper, "{SHA512}");
    await wrapper.find(PLAIN_INPUT).setValue("password");
    await applyAndWait(wrapper);
    const events = wrapper.emitted("update:modelValue");
    expect(events).toHaveLength(1);
    const stored = events![0][0] as string;
    expect(stored.startsWith("{SHA512}")).toBe(true);
    expect(parsePasswordHash(stored)?.scheme).toBe("{SHA512}");
    // 非随机生成路径：不发出一次性明文事件；输入框随即清空。
    expect(wrapper.emitted("plainGenerated")).toBeUndefined();
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value).toBe("");
  });

  it("reports a failed local hash through the error channel and keeps the input", async () => {
    hashMock.mockRejectedValueOnce(new Error("The operation is insecure."));
    const wrapper = track();
    await wrapper.find(PLAIN_INPUT).setValue("password");
    await wrapper.find(APPLY_BUTTON).trigger("click");
    await flushPromises();
    // 哈希失败走 error 通道(i18n:ldap.passwordEditor.hashFailed),不再裸抛。
    expect(wrapper.emitted("error")?.at(-1)).toEqual(["本地密码哈希失败"]);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.emitted("plainGenerated")).toBeUndefined();
    // 与扩展路径一致:失败不丢输入,便于修正后重试。
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value).toBe("password");
  });

  it("emits plainGenerated only when the password came from the random generator", async () => {
    const wrapper = track();
    await wrapper.find(GENERATE_BUTTON).trigger("click");
    const generated = (wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value;
    expect(generated).not.toBe("");
    // 随机生成后明文自动回显，便于管理员确认一次性密码。
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).type).toBe("text");
    await applyAndWait(wrapper);
    const events = wrapper.emitted("update:modelValue");
    expect(events).toHaveLength(1);
    const stored = events![0][0] as string;
    expect(stored.startsWith("{SSHA}")).toBe(true);
    expect(parsePasswordHash(stored)?.scheme).toBe("{SSHA}");
    expect(wrapper.emitted("plainGenerated")![0][0]).toBe(generated);
    // 提交后明文不再留在组件状态。
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value).toBe("");
  });

  it("regenerates a different password on every click of the random button", async () => {
    const wrapper = track();
    await wrapper.find(GENERATE_BUTTON).trigger("click");
    const first = (wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value;
    await wrapper.find(GENERATE_BUTTON).trigger("click");
    const second = (wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value;
    expect(first).toHaveLength(16);
    expect(second).toHaveLength(16);
    expect(first).not.toBe(second);
  });

  it("recognises an existing hash and surfaces its scheme without plaintext", () => {
    const stored = "{SSHA}bCvrAbvqRheNTx76n4jgXHj3a0MBAgMEBQYHCAkKCwwNDg8Q";
    const wrapper = track({ modelValue: stored });
    expect(wrapper.find(".password-editor").attributes("data-scheme")).toBe("{SSHA}");
    expect(wrapper.find(".hint").text()).toContain("{SSHA}");
    expect(wrapper.find(".hint").text()).not.toContain(stored);
    expect(wrapper.find(".form-error").exists()).toBe(false);
  });

  it("warns on plaintext storage and on unknown scheme labels instead of guessing", () => {
    const plaintext = track({ modelValue: "clear-secret" });
    expect(plaintext.find(".password-editor").attributes("data-scheme")).toBe("{CLEARTEXT}");
    expect(plaintext.find(".form-error").exists()).toBe(true);

    const unknown = track({ modelValue: "{MD5}abc=" });
    expect(unknown.find(".password-editor").attributes("data-scheme")).toBe("");
    expect(unknown.find(".form-error").exists()).toBe(true);
  });

  it("gates every control in the disabled state and swallows generate/apply", async () => {
    const wrapper = track({ modelValue: "{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=", disabled: true });
    expect((wrapper.find(SCHEME_SELECT).element as HTMLSelectElement).disabled).toBe(true);
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).disabled).toBe(true);
    for (const button of wrapper.findAll("button")) {
      expect((button.element as HTMLButtonElement).disabled).toBe(true);
    }
    await wrapper.find(GENERATE_BUTTON).trigger("click");
    await wrapper.find(APPLY_BUTTON).trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.emitted("plainGenerated")).toBeUndefined();
  });
});

// -- RFC 3062 扩展操作（F3）--------------------------------------------------

describe("PasswordAttributeEditor extended operation (RFC 3062)", () => {
  const DN = "uid=bob,dc=demo,dc=dbx";

  const toggleExtended = async (wrapper: Awaited<ReturnType<typeof mountEditor>>) => {
    await wrapper.find(EXTENDED_TOGGLE).setValue(true);
    await flushPromises();
  };

  it("shows the extended toggle only when a dn is wired and the editor is writable", () => {
    // 未接线 DN（缺省）或只读态：切换不显示（扩展是写路径）。
    expect(track().find(EXTENDED_TOGGLE).exists()).toBe(false);
    expect(track({ dn: DN, disabled: true }).find(EXTENDED_TOGGLE).exists()).toBe(false);
    const writable = track({ dn: DN });
    expect(writable.find(EXTENDED_TOGGLE).exists()).toBe(true);
    // 默认关闭：可选字段组不出现，沿用默认哈希路径（scheme 下拉在场）。
    expect((writable.find(EXTENDED_TOGGLE).element as HTMLInputElement).checked).toBe(false);
    expect(writable.find(EXTENDED_FIELDS).exists()).toBe(false);
    expect(writable.find(SCHEME_SELECT).exists()).toBe(true);
  });

  it("reveals the identity and old-password fields when the mode is switched on", async () => {
    const wrapper = track({ dn: DN });
    await toggleExtended(wrapper);
    const fields = wrapper.find(EXTENDED_FIELDS);
    expect(fields.exists()).toBe(true);
    // 目标身份：text 输入，占位展示当前条目 DN（留空即默认用 DN）。
    const identity = fields.find(IDENTITY_INPUT);
    expect(identity.exists()).toBe(true);
    expect(identity.attributes("placeholder")).toBe(DN);
    // 旧密码：password 型输入。
    expect((fields.find(OLD_INPUT).element as HTMLInputElement).type).toBe("password");
    // 切回默认模式：字段组隐藏、scheme 下拉恢复。
    await wrapper.find(EXTENDED_TOGGLE).setValue(false);
    expect(wrapper.find(EXTENDED_FIELDS).exists()).toBe(false);
    expect(wrapper.find(SCHEME_SELECT).exists()).toBe(true);
  });

  it("submits entryPasswdModify with only newPassword when identity/old are empty", async () => {
    passwdModifyMock.mockResolvedValue({ success: true });
    const wrapper = track({ dn: DN });
    await toggleExtended(wrapper);
    await wrapper.find(PLAIN_INPUT).setValue("new-secret");
    await wrapper.find(APPLY_BUTTON).trigger("click");
    await flushPromises();
    expect(passwdModifyMock).toHaveBeenCalledTimes(1);
    expect(passwdModifyMock).toHaveBeenCalledWith(DN, { newPassword: "new-secret" });
    // 「缺省不传」按参数形状断言：空 identity/oldPassword 不出现在对象里。
    const options = passwdModifyMock.mock.calls[0]![1];
    expect(Object.keys(options)).toEqual(["newPassword"]);
    // 成功反馈 + 「已应用」流程：清空输入，且不动表单存储值。
    expect(wrapper.emitted("notify")?.at(-1)).toEqual(["已通过扩展操作更新密码"]);
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value).toBe("");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("passes identity and oldPassword through when provided", async () => {
    passwdModifyMock.mockResolvedValue({ success: true });
    const wrapper = track({ dn: DN });
    await toggleExtended(wrapper);
    await wrapper.find(PLAIN_INPUT).setValue("new-secret");
    await wrapper.find(IDENTITY_INPUT).setValue("uid=admin,dc=demo,dc=dbx");
    await wrapper.find(OLD_INPUT).setValue("old-secret");
    await wrapper.find(APPLY_BUTTON).trigger("click");
    await flushPromises();
    expect(passwdModifyMock).toHaveBeenCalledWith(DN, {
      identity: "uid=admin,dc=demo,dc=dbx",
      oldPassword: "old-secret",
      newPassword: "new-secret",
    });
  });

  it("maps a rejected extended op through friendlyLdapError and keeps the inputs", async () => {
    passwdModifyMock.mockRejectedValue(new Error("result code 53 unwilling to perform"));
    const wrapper = track({ dn: DN });
    await toggleExtended(wrapper);
    await wrapper.find(PLAIN_INPUT).setValue("new-secret");
    await wrapper.find(APPLY_BUTTON).trigger("click");
    await flushPromises();
    // 已知结果码 53 → err.unwilling 的本地化文案（friendlyLdapError 映射）。
    const errors = wrapper.emitted("error");
    expect(errors).toHaveLength(1);
    expect(errors![0][0]).not.toContain("result code 53");
    // 失败不丢输入，便于修正后重试。
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value).toBe("new-secret");
    expect(wrapper.emitted("notify")).toBeUndefined();
  });

  it("reports extendedFailed when the call resolves without success", async () => {
    passwdModifyMock.mockResolvedValue({ success: false });
    const wrapper = track({ dn: DN });
    await toggleExtended(wrapper);
    await wrapper.find(PLAIN_INPUT).setValue("new-secret");
    await wrapper.find(APPLY_BUTTON).trigger("click");
    await flushPromises();
    expect(wrapper.emitted("error")?.at(-1)).toEqual(["扩展操作修改密码失败"]);
    expect(wrapper.emitted("notify")).toBeUndefined();
  });

  it("keeps the default hashed path untouched when the toggle stays off", async () => {
    const wrapper = track({ dn: DN });
    await wrapper.find(PLAIN_INPUT).setValue("password");
    await applyAndWait(wrapper);
    expect(passwdModifyMock).not.toHaveBeenCalled();
    expect(wrapper.emitted("update:modelValue")).toHaveLength(1);
  });
});

describe("PasswordAttributeEditor dialog UX (密码编辑器友好化)", () => {
  const CONFIRM_INPUT = ".password-editor .password-confirm-input";
  const STRENGTH_LABEL = ".password-strength";
  const LENGTH_SELECT = ".password-editor .password-length";

  it("blocks apply while the confirmation does not match and shows an inline error", async () => {
    const wrapper = track();
    await wrapper.find(PLAIN_INPUT).setValue("abc12345!@#");
    const confirmInput = wrapper.find(CONFIRM_INPUT);
    await confirmInput.setValue("different-value");
    expect((wrapper.find(APPLY_BUTTON).element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.find(".password-confirm-error").exists()).toBe(true);
    await confirmInput.setValue("abc12345!@#");
    expect((wrapper.find(APPLY_BUTTON).element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.find(".password-confirm-error").exists()).toBe(false);
  });

  it("keeps apply available when the confirmation is left empty (optional guard)", async () => {
    const wrapper = track();
    await wrapper.find(PLAIN_INPUT).setValue("abc12345!@#");
    expect((wrapper.find(APPLY_BUTTON).element as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the confirmation together with the new password after a successful apply", async () => {
    const wrapper = track();
    await wrapper.find(PLAIN_INPUT).setValue("abc12345!@#");
    await wrapper.find(CONFIRM_INPUT).setValue("abc12345!@#");
    await applyAndWait(wrapper);
    expect((wrapper.find(CONFIRM_INPUT).element as HTMLInputElement).value).toBe("");
  });

  it("rates the password strength live without blocking", async () => {
    const wrapper = track();
    expect(wrapper.find(STRENGTH_LABEL).exists()).toBe(false);
    await wrapper.find(PLAIN_INPUT).setValue("abc");
    const strength = wrapper.find(STRENGTH_LABEL);
    expect(strength.exists()).toBe(true);
    expect(strength.classes()).toContain("password-strength--weak");
    await wrapper.find(PLAIN_INPUT).setValue("Abcdefg1!@#$XYZ");
    expect(wrapper.find(STRENGTH_LABEL).classes()).toContain("password-strength--strong");
  });

  it("offers selectable generation lengths applied to the random generator", async () => {
    const wrapper = track();
    const lengthSelect = wrapper.find(LENGTH_SELECT);
    expect(lengthSelect.exists()).toBe(true);
    expect((lengthSelect.element as HTMLSelectElement).value).toBe("16");
    await lengthSelect.setValue("20");
    await wrapper.find(GENERATE_BUTTON).trigger("click");
    expect((wrapper.find(PLAIN_INPUT).element as HTMLInputElement).value).toHaveLength(20);
  });

  it("labels the apply button per mode (extended op vs local hash)", async () => {
    const wrapper = track({ dn: "uid=bob,dc=demo,dc=dbx" });
    expect(wrapper.find(APPLY_BUTTON).text()).toBe(t("ldap.passwordEditor.apply"));
    await wrapper.find(EXTENDED_TOGGLE).setValue(true);
    expect(wrapper.find(APPLY_BUTTON).text()).toBe(t("ldap.passwordEditor.applyExtended"));
  });

  it("renders scheme mentions without leaking i18n placeholder braces", () => {
    const cleartext = t("ldap.passwordEditor.cleartextWarning");
    expect(cleartext).toContain("CLEARTEXT");
    expect(cleartext).not.toContain("{CLEARTEXT}");
    const unknown = t("ldap.passwordEditor.existingUnknown");
    expect(unknown).toContain("MD5");
    expect(unknown).not.toContain("{MD5}");
  });
});
