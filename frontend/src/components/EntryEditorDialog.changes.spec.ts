// @vitest-environment happy-dom
// 保存前变更预览(仅 edit 态):edit 保存先出预览(modify 未发),确认后
// modify 发出且 changes 正确;取消留在编辑器不丢编辑;add 态不出现预览;
// 变更按 op(add/replace/delete)分组、delete 徽章 destructive、多值截断。
// ldapApi mock 方式照抄既有 EntryEditorDialog spec。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ldapApi, type LdapEntry } from "../lib/api";

vi.mock("../lib/api", () => ({
  ldapApi: {
    entryAdd: vi.fn(),
    entryModify: vi.fn(),
  },
}));

import EntryEditorDialog from "./EntryEditorDialog.vue";

const entryModifyMock = vi.mocked(ldapApi.entryModify);
const entryAddMock = vi.mocked(ldapApi.entryAdd);

beforeEach(() => {
  entryAddMock.mockReset();
  entryModifyMock.mockReset();
});

const tracked: Awaited<ReturnType<typeof mountEditor>>[] = [];

function mountEditor(props: { canWrite?: boolean; open?: boolean; entry?: LdapEntry; parentDn?: string } = {}) {
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

// 键序兼顾 LDIF 展示与行排序;sn/title 保持 person 的 MUST(cn/sn)恒满足。
const entry: LdapEntry = {
  dn: "cn=alice,dc=demo,dc=dbx",
  attributes: {
    cn: ["alice"],
    sn: ["Alice"],
    title: ["old"],
    description: ["a", "b", "c", "d"],
    objectClass: ["top", "person"],
  },
};

const attrRows = (wrapper: Awaited<ReturnType<typeof mountEditor>>) => wrapper.findAll(".attr-editor .attr-row");
const rowFor = (wrapper: Awaited<ReturnType<typeof mountEditor>>, attributeName: string) =>
  attrRows(wrapper).find((row) => {
    const name = (row.find("input[name='attr-name']").element as HTMLInputElement).value;
    return name.toLowerCase() === attributeName.toLowerCase();
  })!;
const saveButton = (wrapper: Awaited<ReturnType<typeof mountEditor>>) => wrapper.find("footer .primary-button");
const preview = (wrapper: Awaited<ReturnType<typeof mountEditor>>) => wrapper.find(".changes-layer");
const pressEscape = () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

describe("changes preview before save (edit mode)", () => {
  it("shows the preview before modify is sent; confirm issues the modify with exact changes", async () => {
    entryModifyMock.mockResolvedValue({ success: true });
    const wrapper = track({ entry });
    await rowFor(wrapper, "description").find("textarea").setValue("x\ny\nz\nw\nv");
    await saveButton(wrapper).trigger("click");
    // 预览在场,modify 未发。
    expect(preview(wrapper).exists()).toBe(true);
    expect(preview(wrapper).text()).toContain("变更预览");
    expect(preview(wrapper).text()).toContain("保存将向服务器提交以下修改:");
    expect(entryModifyMock).not.toHaveBeenCalled();
    // replace 分组:属性名 + 多值截断(前 3 个 + …)。
    expect(preview(wrapper).find(".change-badge--replace").exists()).toBe(true);
    expect(preview(wrapper).text()).toContain("description");
    expect(preview(wrapper).text()).toContain("x, y, z, …");
    await preview(wrapper).find(".changes-confirm").trigger("click");
    await flushPromises();
    expect(entryModifyMock).toHaveBeenCalledTimes(1);
    expect(entryModifyMock).toHaveBeenCalledWith("cn=alice,dc=demo,dc=dbx", [
      { operation: "replace", attribute: "description", values: ["x", "y", "z", "w", "v"] },
    ]);
    expect(wrapper.emitted("saved")?.[0]).toEqual(["cn=alice,dc=demo,dc=dbx", "edit"]);
    expect(preview(wrapper).exists()).toBe(false);
  });

  it("cancel closes the preview, keeps the editor open and the edits intact", async () => {
    const wrapper = track({ entry });
    await rowFor(wrapper, "cn").find("textarea").setValue("alice2");
    await saveButton(wrapper).trigger("click");
    expect(preview(wrapper).exists()).toBe(true);
    await preview(wrapper).find(".changes-cancel").trigger("click");
    // 预览关闭、未发 modify、编辑器未关、草稿值原样保留。
    expect(preview(wrapper).exists()).toBe(false);
    expect(entryModifyMock).not.toHaveBeenCalled();
    expect(wrapper.emitted("close")).toBeUndefined();
    expect((rowFor(wrapper, "cn").find("textarea").element as HTMLTextAreaElement).value).toBe("alice2");
    // 取消后仍可再次走 保存 → 预览 → 确认。
    entryModifyMock.mockResolvedValue({ success: true });
    await saveButton(wrapper).trigger("click");
    expect(preview(wrapper).exists()).toBe(true);
    await preview(wrapper).find(".changes-confirm").trigger("click");
    await flushPromises();
    expect(entryModifyMock).toHaveBeenCalledWith("cn=alice,dc=demo,dc=dbx", [
      { operation: "replace", attribute: "cn", values: ["alice2"] },
    ]);
  });

  it("veto Esc while the preview is open so edits cannot be dropped", async () => {
    const wrapper = track({ entry });
    await rowFor(wrapper, "cn").find("textarea").setValue("alice2");
    await saveButton(wrapper).trigger("click");
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(preview(wrapper).exists()).toBe(true);
  });

  it("groups add/replace/delete ops with badges; delete badge has no value preview", async () => {
    entryModifyMock.mockResolvedValue({ success: true });
    const wrapper = track({ entry });
    // add:新增 mail 行;replace:description 改成 5 值(截断);delete:整行移除 title。
    await wrapper.find("footer .toolbar-button").trigger("click");
    const newRow = attrRows(wrapper).at(-1)!;
    await newRow.find("input").setValue("mail");
    await newRow.find("textarea").setValue("alice@demo");
    await rowFor(wrapper, "description").find("textarea").setValue("x\ny\nz\nw\nv");
    await rowFor(wrapper, "title").find("button[title='移除属性']").trigger("click");
    await saveButton(wrapper).trigger("click");
    const groups = preview(wrapper).findAll(".changes-group");
    expect(groups.map((group) => group.find(".change-badge").text())).toEqual(["add", "replace", "delete"]);
    expect(groups[0].text()).toContain("mail");
    expect(groups[1].text()).toContain("description");
    // delete 的 values 恒为空:只有属性名,没有值预览。
    const titleItem = groups[2].findAll(".change-item").find((item) => item.text().includes("title"))!;
    expect(titleItem.find(".change-values").exists()).toBe(false);
    await preview(wrapper).find(".changes-confirm").trigger("click");
    await flushPromises();
    // diffChanges 按属性键插入序遍历(before 键序在前):title/description 在
    // 原条目先声明,mail 是新加的行,故 delete/replace 在前、add 在最后。
    expect(entryModifyMock.mock.calls[0][1]).toEqual([
      { operation: "delete", attribute: "title", values: [] },
      { operation: "replace", attribute: "description", values: ["x", "y", "z", "w", "v"] },
      { operation: "add", attribute: "mail", values: ["alice@demo"] },
    ]);
  });

  it("does not show a preview in add mode: save goes straight to entryAdd", async () => {
    entryAddMock.mockResolvedValue({ success: true });
    const wrapper = track({ parentDn: "ou=people,dc=demo,dc=dbx" });
    await wrapper.findAll(".attr-row .field input")[0].setValue("cn=bob");
    await saveButton(wrapper).trigger("click");
    await flushPromises();
    expect(preview(wrapper).exists()).toBe(false);
    expect(entryAddMock).toHaveBeenCalledWith("cn=bob,ou=people,dc=demo,dc=dbx", { objectClass: ["top"] });
    expect(entryModifyMock).not.toHaveBeenCalled();
  });
});
