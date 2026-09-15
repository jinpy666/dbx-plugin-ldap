// @vitest-environment happy-dom
// objectClass 专用 chips 行 + ObjectClassPickerDialog:chips 渲染/移除/最后
// 一个不可移除;picker 打开、搜索过滤、添加写回 valuesText、重复类禁用、
// schema 缺失时的内置兜底。ldapApi mock 方式照抄既有 EntryEditorDialog spec
// (in-file mock,无宿主桥/网络)。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { ldapApi, type LdapEntry } from "../lib/api";
import type { LdapSchema } from "../lib/newEntryTemplates";

vi.mock("../lib/api", () => ({
  ldapApi: {
    entryAdd: vi.fn(),
    entryModify: vi.fn(),
  },
}));

import EntryEditorDialog from "./EntryEditorDialog.vue";

const tracked: Awaited<ReturnType<typeof mountEditor>>[] = [];

function mountEditor(props: { canWrite?: boolean; open?: boolean; entry?: LdapEntry; schema?: LdapSchema; parentDn?: string } = {}) {
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

const entry: LdapEntry = {
  dn: "cn=alice,dc=demo,dc=dbx",
  attributes: {
    cn: ["alice"],
    sn: ["Alice"],
    objectClass: ["top", "person"],
  },
};

const objectClassRow = (wrapper: Awaited<ReturnType<typeof mountEditor>>) =>
  wrapper.findAll(".attr-editor .attr-row").find((row) => {
    const name = (row.find("input[name='attr-name']").element as HTMLInputElement).value;
    return name.toLowerCase() === "objectclass";
  })!;

const pickerItem = (wrapper: Awaited<ReturnType<typeof mountEditor>>, name: string) =>
  wrapper.findAll(".oc-picker-item").find((item) => item.find(".oc-picker-name").text() === name)!;

describe("objectClass chips row", () => {
  it("renders objectClass values as chips instead of a textarea", () => {
    const wrapper = track({ entry });
    const row = objectClassRow(wrapper);
    expect(row.findAll(".oc-chip")).toHaveLength(2);
    expect(row.find(".oc-chip .mono").text()).toBe("top");
    // 该行不再出现 textarea(多值类名不走"一行一值"文本编辑)。
    expect(row.find("textarea").exists()).toBe(false);
    expect(row.find(".oc-chip-add").exists()).toBe(true);
    // 每个chip 的移除按钮带值名 aria(无障碍命名)。
    expect(row.findAll(".oc-chip-remove")[0].attributes("aria-label")).toBe("移除 objectClass top");
  });

  it("removes a chip, writes valuesText back and keeps LDIF in sync", async () => {
    const wrapper = track({ entry });
    const row = objectClassRow(wrapper);
    await row.findAll(".oc-chip-remove")[0].trigger("click");
    expect(row.findAll(".oc-chip")).toHaveLength(1);
    expect(row.find(".oc-chip .mono").text()).toBe("person");
    // 写回 valuesText 后既有 rows→LDIF watch 自动同步(切页签验证文本)。
    await wrapper.findAll(".mode-switch button")[1].trigger("click");
    const ldif = (wrapper.find(".ldif-editor").element as HTMLTextAreaElement).value;
    expect(ldif).not.toContain("objectClass: top");
    expect(ldif).toContain("objectClass: person");
  });

  it("disables the remove button for the last remaining chip", async () => {
    const wrapper = track({ entry });
    const row = objectClassRow(wrapper);
    // 初始两个类均可移除;删掉一个后最后一个必须保留(条目不能没有类)。
    expect(row.findAll(".oc-chip-remove")[0].attributes("disabled")).toBeUndefined();
    await row.findAll(".oc-chip-remove")[0].trigger("click");
    expect(row.findAll(".oc-chip-remove")[0].attributes("disabled")).toBeDefined();
  });

  it("disables chips actions in read-only mode but still renders the chips", () => {
    const wrapper = track({ entry, canWrite: false });
    const row = objectClassRow(wrapper);
    expect(row.findAll(".oc-chip")).toHaveLength(2);
    for (const button of row.findAll(".oc-chip-remove")) {
      expect(button.attributes("disabled")).toBeDefined();
    }
    expect(row.find(".oc-chip-add").attributes("disabled")).toBeDefined();
  });
});

describe("ObjectClassPickerDialog via the editor", () => {
  it("opens from the chips add button with the builtin fallback list", async () => {
    const wrapper = track({ entry });
    expect(wrapper.find(".oc-picker-modal").exists()).toBe(false);
    await objectClassRow(wrapper).find(".oc-chip-add").trigger("click");
    expect(wrapper.find(".oc-picker-modal").exists()).toBe(true);
    // schema 缺失 → builtinSchema 内置常用类兜底(不是空壳)。
    expect(wrapper.find(".oc-picker-modal h2").text()).toBe("选择 objectClass");
    expect(pickerItem(wrapper, "inetOrgPerson").exists()).toBe(true);
    expect(pickerItem(wrapper, "groupOfNames").exists()).toBe(true);
    // MUST 提示:groupOfNames 有 MUST(cn, member),person 也有(sn, cn)。
    expect(pickerItem(wrapper, "groupOfNames").text()).toContain("必须属性:cn, member");
  });

  it("filters the list by search text and shows the empty state", async () => {
    const wrapper = track({ entry });
    await objectClassRow(wrapper).find(".oc-chip-add").trigger("click");
    const search = wrapper.find(".oc-picker-search");
    await search.setValue("posix");
    const names = wrapper.findAll(".oc-picker-name").map((item) => item.text());
    expect(names).toEqual(["posixAccount", "posixGroup"]);
    await search.setValue("no-such-class");
    expect(wrapper.find(".oc-picker-empty").text()).toBe("没有匹配的 objectClass");
  });

  it("adds a picked class back into the row and keeps the picker open", async () => {
    const wrapper = track({ entry });
    await objectClassRow(wrapper).find(".oc-chip-add").trigger("click");
    await pickerItem(wrapper, "groupOfNames").trigger("click");
    // 写回 rows:chips 变 3 个;picker 保持打开支持连续添加;
    // groupOfNames 的 MUST member 立即进入必填提示(证明写到了行数据)。
    expect(objectClassRow(wrapper).findAll(".oc-chip")).toHaveLength(3);
    expect(wrapper.find(".oc-picker-modal").exists()).toBe(true);
    expect(wrapper.find(".required-attributes").text()).toContain("member");
    // 连续添加第二个类后用「关闭」退出。
    await pickerItem(wrapper, "organizationalUnit").trigger("click");
    expect(objectClassRow(wrapper).findAll(".oc-chip")).toHaveLength(4);
    await wrapper.find(".oc-picker-modal footer .primary-button").trigger("click");
    expect(wrapper.find(".oc-picker-modal").exists()).toBe(false);
    expect(objectClassRow(wrapper).findAll(".oc-chip")).toHaveLength(4);
  });

  it("marks already-used classes as selected and refuses duplicates", async () => {
    const wrapper = track({ entry });
    await objectClassRow(wrapper).find(".oc-chip-add").trigger("click");
    const used = pickerItem(wrapper, "person");
    expect(used.attributes("disabled")).toBeDefined();
    await used.trigger("click");
    // 禁点:chips 仍 2 个,没有追加重复类。
    expect(objectClassRow(wrapper).findAll(".oc-chip")).toHaveLength(2);
  });

  it("uses schema objectClassAttributes as the data source when available", async () => {
    const schema: LdapSchema = {
      objectClassAttributes: {
        customClass: { must: ["cn"], may: [] },
        person: { must: [], may: [] },
      },
    };
    const wrapper = track({ entry, schema });
    await objectClassRow(wrapper).find(".oc-chip-add").trigger("click");
    // schema 在场 → 不再注入内置兜底表。
    expect(pickerItem(wrapper, "customClass").exists()).toBe(true);
    const names = wrapper.findAll(".oc-picker-name").map((item) => item.text());
    expect(names).not.toContain("inetOrgPerson");
    await pickerItem(wrapper, "customClass").trigger("click");
    expect(objectClassRow(wrapper).findAll(".oc-chip")).toHaveLength(3);
    expect(objectClassRow(wrapper).findAll(".oc-chip .mono").map((chip) => chip.text())).toContain("customClass");
  });
});
