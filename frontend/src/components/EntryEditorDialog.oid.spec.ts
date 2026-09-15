// @vitest-environment happy-dom
// OID 值校验(功能 3):valueKinds 已返回 "oid" 但 editorKind 此前未映射、
// 落回 text。这里覆盖:single 值 OID 行渲染 mono 单行输入(带行内格式校验),
// 多值行降级 textarea(单行 input 会吞换行丢多值)。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { LdapEntry } from "../lib/api";
import type { LdapSchema } from "../lib/newEntryTemplates";

vi.mock("../lib/api", () => ({
  ldapApi: {
    entryAdd: vi.fn(),
    entryModify: vi.fn(),
  },
}));

import EntryEditorDialog from "./EntryEditorDialog.vue";

const tracked: Awaited<ReturnType<typeof mountEditor>>[] = [];

function mountEditor(props: { canWrite?: boolean; open?: boolean; entry?: LdapEntry; schema?: LdapSchema } = {}) {
  return mount(EntryEditorDialog, {
    props: { canWrite: true, open: true, ...props },
  });
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = (props?: Parameters<typeof mountEditor>[0]) => {
  const wrapper = mountEditor(props);
  tracked.push(wrapper);
  return wrapper;
};

const schema: LdapSchema = {
  attributeInfo: {
    // 1.3.6.1.4.1.1466.115.121.1.38 = OID 语法(supportedControl 同族)
    myOid: { syntax: "1.3.6.1.4.1.1466.115.121.1.38" },
  },
};

const entry: LdapEntry = {
  dn: "cn=alice,dc=demo,dc=dbx",
  attributes: {
    cn: ["alice"],
    objectClass: ["top", "person"],
    myOid: ["2.16.840.1.113730.3.4.2"],
    multiOid: ["1.2.3", "2.16.840.1.113730.3.4.2"],
  },
};

const rowFor = (wrapper: Awaited<ReturnType<typeof mountEditor>>, attributeName: string) =>
  wrapper.findAll(".attr-editor .attr-row").find((row) => {
    const name = (row.find("input[name='attr-name']").element as HTMLInputElement).value;
    return name.toLowerCase() === attributeName.toLowerCase();
  })!;

describe("OID value editor", () => {
  it("routes single-valued OID-syntax rows to a mono input and validates the dotted shape", async () => {
    const wrapper = track({ entry, schema });
    const row = rowFor(wrapper, "myOid");
    const input = row.find(".oid-input");
    expect(input.exists()).toBe(true);
    // 合法 OID:无行内错误(aria-invalid 渲染为字符串 "false")。
    expect(input.attributes("aria-invalid")).toBe("false");
    expect(row.find(".form-error").exists()).toBe(false);
    // 非法值:aria-invalid + 行内提示(样式参照 integerInvalid)。
    await input.setValue("not-an-oid");
    expect(row.find(".oid-input").attributes("aria-invalid")).toBe("true");
    expect(row.find(".form-error").text()).toBe("不是合法的 OID(点分数字)");
    // 空值合法(留白等价删除,不标错)。
    await row.find(".oid-input").setValue("");
    expect(row.find(".oid-input").attributes("aria-invalid")).toBe("false");
    // 单段数字不构成 OID(至少两段点分)。
    await row.find(".oid-input").setValue("42");
    expect(row.find(".oid-input").attributes("aria-invalid")).toBe("true");
    await row.find(".oid-input").setValue("1.2.3");
    expect(row.find(".oid-input").attributes("aria-invalid")).toBe("false");
    expect(row.find(".form-error").exists()).toBe(false);
  });

  it("degrades multi-valued OID rows back to the textarea (no value loss)", () => {
    const wrapper = track({ entry, schema });
    const row = rowFor(wrapper, "multiOid");
    expect(row.find(".oid-input").exists()).toBe(false);
    expect(row.find("textarea").exists()).toBe(true);
  });

  it("routes OID by builtin name table (supportedControl) without schema", () => {
    const wrapper = track({ entry: { dn: entry.dn, attributes: { cn: ["alice"], objectClass: ["top", "person"], supportedControl: ["1.2.840.113556.1.4.319"] } } });
    expect(rowFor(wrapper, "supportedControl").find(".oid-input").exists()).toBe(true);
  });
});
