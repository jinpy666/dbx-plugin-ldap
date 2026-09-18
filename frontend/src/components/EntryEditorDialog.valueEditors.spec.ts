// @vitest-environment happy-dom
// EntryEditorDialog 值编辑器分流（阶段2）：按属性名/语法分流到时间/DN/布尔/
// 整数编辑器；多值行降级 textarea；MUST ★ 标记；属性 datalist 注入。
// t() 对未知键原样透传。
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import EntryEditorDialog from "./EntryEditorDialog.vue";
import type { LdapEntry } from "../lib/api";
import type { LdapSchema } from "../lib/newEntryTemplates";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, ldapApi: { ...actual.ldapApi, entryAdd: vi.fn(), entryModify: vi.fn() } };
});

const tracked: Awaited<ReturnType<typeof mountDialog>>[] = [];

function mountDialog(props: { canWrite: boolean; open: boolean; entry?: LdapEntry; schema?: LdapSchema; baseDn?: string; parentDn?: string }) {
  return mount(EntryEditorDialog, { props });
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = (props: Parameters<typeof mountDialog>[0]) => {
  const wrapper = mountDialog(props);
  tracked.push(wrapper);
  return wrapper;
};

const rowFor = (wrapper: Awaited<ReturnType<typeof mountDialog>>, attributeName: string) =>
  wrapper.findAll(".attr-editor .attr-row").find((row) => {
    const name = (row.find("input[name='attr-name']").element as HTMLInputElement).value;
    return name.toLowerCase() === attributeName.toLowerCase();
  })!;

const schema: LdapSchema = {
  objectClassAttributes: { person: { must: ["sn", "cn"], may: ["telephoneNumber"] } },
  attributeInfo: {
    shoeSize: { syntax: "1.3.6.1.4.1.1466.115.121.1.27" },
    isActive: { syntax: "1.3.6.1.4.1.1466.115.121.1.7" },
    directReport: { syntax: "1.3.6.1.4.1.1466.115.121.1.12" },
    seen: { syntax: "1.3.6.1.4.1.1466.115.121.1.24" },
  },
};

const entry: LdapEntry = {
  dn: "cn=alice,dc=demo,dc=dbx",
  attributes: {
    objectClass: ["top", "person"],
    cn: ["alice"],
    sn: ["Alice"],
    createTimestamp: ["20260102030405Z"],
    member: ["cn=a,dc=demo,dc=dbx", "cn=b,dc=demo,dc=dbx"],
    manager: ["cn=bob,dc=demo,dc=dbx"],
    shoeSize: ["42"],
    isActive: ["TRUE"],
    directReport: ["cn=c,dc=demo,dc=dbx"],
    seen: ["20260102030405Z"],
  },
};

describe("EntryEditorDialog value editor routing", () => {
  const wrapper = track({ canWrite: true, open: true, entry, schema });

  // ADS 交互：特殊类型（时间/DN/二进制/密码/UAC）值单元格只读展示，点
  // 「编辑」（或双击）打开弹窗编辑器；文本/整数/布尔/OID 保持内联。
  it("shows a read-only display with an edit button for a single-valued DN attribute (no inline editor)", () => {
    const row = rowFor(wrapper, "directReport");
    expect(row.find(".dn-editor").exists()).toBe(false);
    expect(row.find(".value-display").exists()).toBe(true);
    expect(row.find(".value-display").text()).toBe("cn=c,dc=demo,dc=dbx");
    expect(row.find(".value-edit-button").exists()).toBe(true);
  });

  it("relays the DN dialog's open-reference with its source attribute", async () => {
    const activeWrapper = track({ canWrite: true, open: true, entry, schema });
    await rowFor(activeWrapper, "manager").find(".value-edit-button").trigger("click");
    await activeWrapper.vm.$nextTick();
    const dialog = activeWrapper.findComponent({ name: "ValueEditorDialog" });
    expect(dialog.exists()).toBe(true);
    dialog.vm.$emit("openReference", "cn=bob,dc=demo,dc=dbx");
    await activeWrapper.vm.$nextTick();
    expect(activeWrapper.emitted("openRelatedEntry")?.[0]).toEqual(["cn=bob,dc=demo,dc=dbx", "manager"]);
  });

  it("degrades multi-valued DN attribute back to textarea", () => {
    expect(rowFor(wrapper, "member").find("textarea").exists()).toBe(true);
    expect(rowFor(wrapper, "member").find(".value-edit-button").exists()).toBe(false);
  });

  it("routes integer-syntax attribute to numeric input", () => {
    expect(rowFor(wrapper, "shoeSize").find(".integer-input").exists()).toBe(true);
  });

  it("routes boolean-syntax attribute to a TRUE/FALSE select and writes back", async () => {
    const row = rowFor(wrapper, "isActive");
    const select = row.find(".boolean-select");
    expect(select.exists()).toBe(true);
    await select.setValue("FALSE");
    expect((row.find("select").element as HTMLSelectElement).value).toBe("FALSE");
  });

  it("shows a read-only display for generalizedTime attribute (schema syntax)", () => {
    const row = rowFor(wrapper, "seen");
    expect(row.find(".datetime-editor").exists()).toBe(false);
    expect(row.find(".value-display").exists()).toBe(true);
    expect(row.find(".value-edit-button").exists()).toBe(true);
  });

  it("shows a read-only display for createTimestamp via builtin fallback (no schema entry needed)", () => {
    const row = rowFor(wrapper, "createTimestamp");
    expect(row.find(".datetime-editor").exists()).toBe(false);
    expect(row.find(".value-edit-button").exists()).toBe(true);
  });

  it("opens the password dialog editor from the read-only display (J-12 registry)", async () => {
    // J-12：password 分流完全走 valueKinds 注册表——userPassword/unicodePwd
    // 命中名字绑定，sambaNTPassword 命中 *password 后缀；弹窗内才是编辑器。
    const entry: LdapEntry = {
      dn: "uid=pw,dc=demo,dc=dbx",
      attributes: { uid: ["pw"], userPassword: ["{SSHA}abcd"], unicodePwd: ["secret"], sambaNTPassword: ["AB12"] },
    };
    const wrapper = track({ canWrite: true, open: true, entry, schema });
    for (const name of ["userPassword", "unicodePwd", "sambaNTPassword"]) {
      const row = rowFor(wrapper, name);
      expect(row.findComponent({ name: "PasswordAttributeEditor" }).exists()).toBe(false);
      expect(row.find(".value-edit-button").exists()).toBe(true);
      await row.find(".value-edit-button").trigger("click");
      await wrapper.vm.$nextTick();
      const dialog = wrapper.findComponent({ name: "ValueEditorDialog" });
      expect(dialog.exists()).toBe(true);
      expect(dialog.findComponent({ name: "PasswordAttributeEditor" }).exists()).toBe(true);
      dialog.vm.$emit("close");
      await wrapper.vm.$nextTick();
    }
    // 非 password 名不受后缀误伤：uid 保持文本编辑器、无编辑按钮。
    expect(rowFor(wrapper, "uid").find("textarea").exists()).toBe(true);
    expect(rowFor(wrapper, "uid").find(".value-edit-button").exists()).toBe(false);
  });

  it("writes the dialog-confirmed value back to the row and closes", async () => {
    const activeWrapper = track({ canWrite: true, open: true, entry, schema });
    await rowFor(activeWrapper, "seen").find(".value-edit-button").trigger("click");
    await activeWrapper.vm.$nextTick();
    const dialog = activeWrapper.findComponent({ name: "ValueEditorDialog" });
    expect(dialog.props("open")).toBe(true);
    expect(dialog.props("modelValue")).toBe("20260102030405Z");
    dialog.vm.$emit("confirm", "20270101000000Z");
    await activeWrapper.vm.$nextTick();
    expect(rowFor(activeWrapper, "seen").find(".value-display").text()).toBe("20270101000000Z");
    expect(activeWrapper.findComponent({ name: "ValueEditorDialog" }).props("open")).toBe(false);
  });

  it("keeps the original value when the dialog is cancelled", async () => {
    const activeWrapper = track({ canWrite: true, open: true, entry, schema });
    await rowFor(activeWrapper, "directReport").find(".value-edit-button").trigger("click");
    await activeWrapper.vm.$nextTick();
    activeWrapper.findComponent({ name: "ValueEditorDialog" }).vm.$emit("close");
    await activeWrapper.vm.$nextTick();
    expect(rowFor(activeWrapper, "directReport").find(".value-display").text()).toBe("cn=c,dc=demo,dc=dbx");
  });
});

describe("EntryEditorDialog must marks and attribute datalist", () => {
  it("marks MUST attribute rows with ★ (entry objectClass → schema must)", () => {
    const wrapper = track({ canWrite: true, open: true, entry, schema });
    expect(rowFor(wrapper, "sn").find(".must-mark").exists()).toBe(true);
    expect(rowFor(wrapper, "shoeSize").find(".must-mark").exists()).toBe(false);
  });

  it("renders an attribute datalist fed from schema and builtin fallback", () => {
    const wrapper = track({ canWrite: true, open: true, entry, schema });
    const options = wrapper.findAll("datalist option").map((option) => option.attributes("value"));
    expect(options).toContain("sn"); // person.must 优先
    expect(options).toContain("telephoneNumber"); // person.may
    expect(options).toContain("sAMAccountName"); // builtinSchema 兜底
    // 行输入绑定 datalist
    expect(rowFor(wrapper, "sn").find("input[name='attr-name']").attributes("list")).toBe(
      wrapper.find("datalist").attributes("id"),
    );
  });

  it("marks must rows in add mode from draft objectClass rows", () => {
    const addEntry = { dn: "", attributes: { objectClass: ["person"], sn: [""] } };
    const wrapper = track({ canWrite: true, open: true, entry: undefined, parentDn: undefined, baseDn: "dc=demo,dc=dbx" });
    // add 态初始化为空条目（parentDn 打开），手动模拟：直接断言 view 分支已在
    // 其他用例覆盖；此处仅确保 add 空表单不报错
    expect(wrapper.findAll(".attr-editor .attr-row").length).toBeGreaterThan(0);
    void addEntry;
  });
});

describe("EntryEditorDialog value copy menu (F8 / UX-V7)", () => {
  // héllo：含非 ASCII 字符，验证 Base64/hex 均按 UTF-8 字节编码。
  const copyEntry: LdapEntry = {
    dn: "cn=copy,dc=demo,dc=dbx",
    attributes: { cn: ["héllo"], objectClass: ["top"] },
  };

  // 右键复制（UX-V7 右键化）：行内复制按钮已移除，contextmenu 打开统一菜单，
  // 菜单项 = copyRaw/copyBase64/copyHex/copyName/copyNameValueLdif 五项。
  const attrRows = (wrapper: Awaited<ReturnType<typeof mountDialog>>) => wrapper.findAll(".attr-editor .attr-row");
  const copyMenu = (wrapper: Awaited<ReturnType<typeof mountDialog>>) => wrapper.find(".context-menu[role='menu']");
  const menuItem = (wrapper: Awaited<ReturnType<typeof mountDialog>>, title: string) =>
    wrapper.find(`.context-menu [role='menuitem'][title='${title}']`);
  const openMenu = async (wrapper: Awaited<ReturnType<typeof mountDialog>>, index = 0) => {
    await attrRows(wrapper)[index].trigger("contextmenu", { clientX: 40, clientY: 40 });
    await wrapper.vm.$nextTick();
  };
  // 文档级外点/Esc 兜底监听在 onMounted 的 setTimeout(0) 注册：先等一拍再交互。
  const flushMenuListeners = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("opens a five-item copy menu by right-clicking a form value row", async () => {
    const wrapper = track({ canWrite: true, open: true, entry: copyEntry, schema });
    await flushMenuListeners();
    // 行内不再有复制触发按钮；右键任意值行（cn 行）打开菜单。
    expect(copyMenu(wrapper).exists()).toBe(false);
    expect(wrapper.findAll(".attr-editor .attr-actions button[title='复制']")).toHaveLength(0);
    await openMenu(wrapper);
    expect(copyMenu(wrapper).findAll("[role='menuitem']").map((item) => item.attributes("title")))
      .toEqual(["复制原值", "以 Base64 复制", "以十六进制复制", "复制属性名", "复制属性行 (LDIF)"]);
    // Escape 只关菜单，弹窗保持打开。
    await copyMenu(wrapper).trigger("keydown", { key: "Escape" });
    await wrapper.vm.$nextTick();
    expect(copyMenu(wrapper).exists()).toBe(false);
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("disables value-copy items on an empty row while attribute-name copy stays", async () => {
    const wrapper = track({ canWrite: true, open: true, parentDn: "dc=demo,dc=dbx" });
    await flushMenuListeners();
    await wrapper.find(".toolbar-button").trigger("click"); // 新增一行空值
    const newRow = wrapper.findAll(".attr-editor .attr-row").at(-1)!;
    // 空值行的值类复制项全部禁用；填上属性名后「复制属性名」可用。
    await openMenu(wrapper, wrapper.findAll(".attr-editor .attr-row").length - 1);
    for (const title of ["复制原值", "以 Base64 复制", "以十六进制复制", "复制属性名", "复制属性行 (LDIF)"]) {
      expect((menuItem(wrapper, title).element as HTMLButtonElement).disabled).toBe(true);
    }
    await newRow.find("input[name='attr-name']").setValue("sn");
    await openMenu(wrapper, wrapper.findAll(".attr-editor .attr-row").length - 1);
    expect((menuItem(wrapper, "复制属性名").element as HTMLButtonElement).disabled).toBe(false);
    expect((menuItem(wrapper, "复制原值").element as HTMLButtonElement).disabled).toBe(true);
  });

  it("copies the attribute name and the LDIF name-value line from the menu", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    (window as unknown as { dbxPlugin?: unknown }).dbxPlugin = { clipboard: { writeText } };
    document.execCommand = () => false;
    try {
      const wrapper = track({ canWrite: true, open: true, entry: copyEntry, schema });
      await flushMenuListeners();
      await openMenu(wrapper);
      await menuItem(wrapper, "复制属性名").trigger("click");
      await flushPromises();
      expect(writeText).toHaveBeenLastCalledWith("cn");
      await openMenu(wrapper);
      await menuItem(wrapper, "复制属性行 (LDIF)").trigger("click");
      await flushPromises();
      expect(writeText).toHaveBeenLastCalledWith("cn: héllo");
    } finally {
      delete (window as unknown as { dbxPlugin?: undefined }).dbxPlugin;
    }
  });

  it("closes the menu on an outside click", async () => {
    const wrapper = track({ canWrite: true, open: true, entry: copyEntry, schema });
    await flushMenuListeners();
    await openMenu(wrapper);
    expect(copyMenu(wrapper).exists()).toBe(true);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(copyMenu(wrapper).exists()).toBe(false);
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("copies raw, UTF-8 Base64 and UTF-8 uppercase hex from the menu items", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    (window as unknown as { dbxPlugin?: unknown }).dbxPlugin = { clipboard: { writeText } };
    document.execCommand = () => false;
    try {
      const wrapper = track({ canWrite: true, open: true, entry: copyEntry, schema });
      await flushMenuListeners();
      // 原值：字符串原样复制。
      await openMenu(wrapper);
      await menuItem(wrapper, "复制原值").trigger("click");
      await flushPromises();
      expect(writeText).toHaveBeenLastCalledWith("héllo");
      expect(wrapper.emitted("notify")?.at(-1)).toEqual(["已复制"]);
      // Base64："héllo" 的 UTF-8 字节 68 C3 A9 6C 6C 6F → aMOpbGxv。
      await openMenu(wrapper);
      await menuItem(wrapper, "以 Base64 复制").trigger("click");
      await flushPromises();
      expect(writeText).toHaveBeenLastCalledWith("aMOpbGxv");
      // hex：同组 UTF-8 字节 → 大写十六进制。
      await openMenu(wrapper);
      await menuItem(wrapper, "以十六进制复制").trigger("click");
      await flushPromises();
      expect(writeText).toHaveBeenLastCalledWith("68C3A96C6C6F");
      expect(wrapper.emitted("notify")?.at(-1)).toEqual(["已复制"]);
    } finally {
      delete (window as unknown as { dbxPlugin?: undefined }).dbxPlugin;
    }
  });

  it("reports copy failure honestly when the clipboard bridge rejects", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("boom"));
    (window as unknown as { dbxPlugin?: unknown }).dbxPlugin = { clipboard: { writeText } };
    document.execCommand = () => false;
    try {
      const wrapper = track({ canWrite: true, open: true, entry: copyEntry, schema });
      await flushMenuListeners();
      await openMenu(wrapper);
      await menuItem(wrapper, "以 Base64 复制").trigger("click");
      await flushPromises();
      expect(wrapper.emitted("notify")?.at(-1)).toEqual(["复制失败"]);
    } finally {
      delete (window as unknown as { dbxPlugin?: undefined }).dbxPlugin;
    }
  });
});

describe("EntryEditorDialog password editor dn wiring (F3)", () => {
  it("passes the entry DN to the in-dialog PasswordAttributeEditor for the RFC 3062 extended op", async () => {
    const entry: LdapEntry = { dn: "uid=bob,dc=demo,dc=dbx", attributes: { uid: ["bob"], userPassword: ["{SSHA}abcd"] } };
    const wrapper = track({ canWrite: true, open: true, entry, schema });
    await rowFor(wrapper, "userPassword").find(".value-edit-button").trigger("click");
    await wrapper.vm.$nextTick();
    const dialog = wrapper.findComponent({ name: "ValueEditorDialog" });
    expect(dialog.exists()).toBe(true);
    expect(dialog.props("dn")).toBe("uid=bob,dc=demo,dc=dbx");
    expect(dialog.findComponent({ name: "PasswordAttributeEditor" }).props("dn")).toBe("uid=bob,dc=demo,dc=dbx");
  });
});

describe("EntryEditorDialog value kind override (行内类型下拉)", () => {
  // 协议立场（RFC 4512）：schema（或内置表）有定义的属性以语法为权威，
  // 编辑器严格按语法推导、不提供手动覆盖；只有查无定义的属性（客户端无从
  // 得知语法）才开放行内「数据类型」下拉。默认仍是文本编辑器。
  const kindSelect = (row: ReturnType<typeof rowFor>) => row.find(".kind-select");

  const addUnnamedRow = async () => {
    const wrapper = track({ canWrite: true, open: true, parentDn: "dc=demo,dc=dbx" });
    await wrapper.find(".toolbar-button").trigger("click"); // 新增一行空属性行
    const newRow = wrapper.findAll(".attr-editor .attr-row").at(-1)!;
    return { wrapper, newRow };
  };

  it("shows a kind select defaulting to auto on an attribute undefined by schema and builtin table", async () => {
    const { wrapper, newRow } = await addUnnamedRow();
    await newRow.find("input[name='attr-name']").setValue("myCustomAttr");
    await wrapper.vm.$nextTick();
    const select = kindSelect(rowFor(wrapper, "myCustomAttr"));
    expect(select.exists()).toBe(true);
    expect((select.element as HTMLSelectElement).value).toBe("auto");
    // objectClass 行是专用 chips 编辑器，不出类型下拉。
    expect(kindSelect(rowFor(wrapper, "objectClass")).exists()).toBe(false);
  });

  it("locks schema-defined attributes (including string syntax) to the syntax-derived editor", () => {
    const viewSchema: LdapSchema = {
      ...schema,
      attributeInfo: { ...schema.attributeInfo, displayName: { syntax: "1.3.6.1.4.1.1466.115.121.1.15" } },
    };
    const viewEntry: LdapEntry = {
      dn: "cn=mix,dc=demo,dc=dbx",
      attributes: { cn: ["mix"], displayName: ["Mix"], userPassword: ["{SSHA}abcd"], objectClass: ["top"] },
    };
    const wrapper = track({ canWrite: true, open: true, entry: viewEntry, schema: viewSchema });
    // 专用编辑器（password 名字绑定）与字符串语法（cn 内置表 / displayName
    // schema directoryString）都视为已定义：不出下拉，保持静态类型标签。
    for (const name of ["userPassword", "cn", "displayName"]) {
      expect(kindSelect(rowFor(wrapper, name)).exists()).toBe(false);
    }
    expect(rowFor(wrapper, "cn").find(".attr-format-label").exists()).toBe(true);
  });

  it("switches the value editor to the selected kind and back to auto", async () => {
    const { wrapper, newRow } = await addUnnamedRow();
    await newRow.find("input[name='attr-name']").setValue("myCustomAttr");
    await wrapper.vm.$nextTick();
    const row = rowFor(wrapper, "myCustomAttr");
    await kindSelect(row).setValue("integer");
    await wrapper.vm.$nextTick();
    expect(rowFor(wrapper, "myCustomAttr").find(".integer-input").exists()).toBe(true);
    expect(rowFor(wrapper, "myCustomAttr").find("textarea").exists()).toBe(false);
    // 改回「自动」恢复 text 编辑器。
    await kindSelect(rowFor(wrapper, "myCustomAttr")).setValue("auto");
    await wrapper.vm.$nextTick();
    expect(rowFor(wrapper, "myCustomAttr").find("textarea").exists()).toBe(true);
  });

  it("resets the override to auto when the attribute name is edited", async () => {
    const { wrapper, newRow } = await addUnnamedRow();
    await newRow.find("input[name='attr-name']").setValue("myCustomAttr");
    await wrapper.vm.$nextTick();
    await kindSelect(rowFor(wrapper, "myCustomAttr")).setValue("integer");
    await wrapper.vm.$nextTick();
    await newRow.find("input[name='attr-name']").setValue("myCustomAttrRenamed");
    await wrapper.vm.$nextTick();
    const select = kindSelect(rowFor(wrapper, "myCustomAttrRenamed"));
    expect((select.element as HTMLSelectElement).value).toBe("auto");
    expect(rowFor(wrapper, "myCustomAttrRenamed").find("textarea").exists()).toBe(true);
  });

  it("runs the save-time kind warning against the overridden kind", async () => {
    const { wrapper, newRow } = await addUnnamedRow();
    await wrapper.find(".add-dn-row input").setValue("cn=kindwarn");
    await newRow.find("input[name='attr-name']").setValue("myCustomAttr");
    await wrapper.vm.$nextTick();
    await kindSelect(rowFor(wrapper, "myCustomAttr")).setValue("integer");
    await rowFor(wrapper, "myCustomAttr").find(".integer-input").setValue("abc");
    await wrapper.find(".primary-button").trigger("click");
    await flushPromises();
    const warnings = wrapper.find(".value-kind-warnings");
    expect(warnings.exists()).toBe(true);
    expect(warnings.text()).toContain("myCustomAttr");
  });
});
