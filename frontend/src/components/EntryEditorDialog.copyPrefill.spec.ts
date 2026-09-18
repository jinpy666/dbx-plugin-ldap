// @vitest-environment happy-dom
// 复制条目 → 编辑器 add 态预填（阶段3）端到端：prefill 行铺开（源属性保留、
// RDN 属性值清空待填）、RDN 未填时保存被阻断、填齐后 entryAdd 载荷正确、
// LDIF 页签与表单同步。
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import EntryEditorDialog from "./EntryEditorDialog.vue";
import { ldapApi, type LdapEntry } from "../lib/api";
import { t } from "../lib/i18n";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, ldapApi: { ...actual.ldapApi, entryAdd: vi.fn(), entryModify: vi.fn() } };
});

vi.mock("./AssociationPanel.vue", () => ({
  default: { name: "AssociationPanel", props: ["dn", "attributes", "baseDn", "dnAttributes", "active"], template: '<div class="assoc-stub"></div>' },
}));

const entryAddMock = vi.mocked(ldapApi.entryAdd);

beforeEach(() => {
  entryAddMock.mockReset();
  entryAddMock.mockResolvedValue({ success: true });
});

// prepareCopyEntry 的输出形态（同款剔除/清空语义），直接作为预填夹具
const copyPrefill = {
  rdn: "cn=",
  attributes: {
    objectClass: ["top", "person"],
    cn: [""],
    sn: ["Alice"],
    mail: ["alice@demo.dbx"],
  },
};

interface PrefillFixture {
  rdn: string;
  attributes: Record<string, string[]>;
}

const tracked: Awaited<ReturnType<typeof mountDialog>>[] = [];

function mountDialog(props: { canWrite?: boolean; open?: boolean; parentDn?: string; addPrefill?: PrefillFixture } = {}, attach = false) {
  return mount(EntryEditorDialog, {
    // 焦点断言需 attach 真实文档树（happy-dom 对 detached 元素 focus() 无效，
    // 用法同 tabs spec）
    attachTo: attach ? document.body : undefined,
    props: { canWrite: true, open: true, parentDn: "ou=people,dc=demo,dc=dbx", ...props },
  });
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = (props?: Parameters<typeof mountDialog>[0], attach?: boolean) => {
  const wrapper = mountDialog(props, attach);
  tracked.push(wrapper);
  return wrapper;
};

const rowFor = (wrapper: Awaited<ReturnType<typeof mountDialog>>, attributeName: string) =>
  wrapper.findAll(".attr-editor .attr-row").find((row) => {
    const name = (row.find("input[name='attr-name']").element as HTMLInputElement).value;
    return name.toLowerCase() === attributeName.toLowerCase();
  })!;

const rdnInput = (wrapper: Awaited<ReturnType<typeof mountDialog>>) => wrapper.findAll(".attr-row .field input")[0];
const saveButton = (wrapper: Awaited<ReturnType<typeof mountDialog>>) => wrapper.find("footer .primary-button");

describe("EntryEditorDialog copy-entry prefill", () => {
  it("spreads prefill attributes into rows with the RDN attribute blanked", () => {
    const wrapper = track({ addPrefill: copyPrefill });
    expect(rowFor(wrapper, "sn").find("textarea").element.value).toBe("Alice");
    expect(rowFor(wrapper, "mail").find("textarea").element.value).toBe("alice@demo.dbx");
    expect(rowFor(wrapper, "cn").find("textarea").element.value).toBe("");
    // RDN 字段保留属性名、值为空
    expect((rdnInput(wrapper).element as HTMLInputElement).value).toBe("cn=");
  });

  it("blocks saving until the RDN value is filled (empty segment guard)", () => {
    const wrapper = track({ addPrefill: copyPrefill });
    expect(saveButton(wrapper).attributes("disabled")).toBeDefined();
  });

  // 走查回归：复制态 RDN「属性=」是值待填而非格式错误，提示应引导补值，
  // 且 DN 行字段纵向布局（标签在上、输入在下）不错位。
  it("guides filling the RDN value instead of flagging an invalid format for the prefill state", async () => {
    const wrapper = track({ addPrefill: copyPrefill });
    expect(wrapper.find(".add-dn-row").exists()).toBe(true);
    expect(wrapper.text()).toContain(t("editor.rdnValueEmpty"));
    expect(wrapper.text()).not.toContain(t("editor.rdnInvalid"));
    await rdnInput(wrapper).setValue("cn=Alice2");
    expect(wrapper.text()).not.toContain(t("editor.rdnValueEmpty"));
  });

  it("submits the copied attributes under the target parent after filling the RDN", async () => {
    const wrapper = track({ addPrefill: copyPrefill });
    await rdnInput(wrapper).setValue("cn=Alice2");
    await rowFor(wrapper, "cn").find("textarea").setValue("Alice2");
    await saveButton(wrapper).trigger("click");
    expect(entryAddMock).toHaveBeenCalledTimes(1);
    const [dn, attributes] = entryAddMock.mock.calls[0];
    expect(dn).toBe("cn=Alice2,ou=people,dc=demo,dc=dbx");
    expect(attributes.objectClass).toEqual(["top", "person"]);
    expect(attributes.cn).toEqual(["Alice2"]);
    expect(attributes.sn).toEqual(["Alice"]);
    expect(attributes.mail).toEqual(["alice@demo.dbx"]);
    // 保存成功后发出 saved(add) 事件供父层刷新树
    expect(wrapper.emitted("saved")![0]).toEqual(["cn=Alice2,ou=people,dc=demo,dc=dbx", "add"]);
  });

  // RDN 字段 → RDN 属性行同步：复制态只填一处即可，空值不再被发给服务器。
  it("syncs the RDN field value into the blanked RDN attribute row", async () => {
    const wrapper = track({ addPrefill: copyPrefill });
    await rdnInput(wrapper).setValue("cn=Alice2");
    expect(rowFor(wrapper, "cn").find("textarea").element.value).toBe("Alice2");
  });

  it("saves a coherent entry with only the RDN field filled (no attribute row edit)", async () => {
    const wrapper = track({ addPrefill: copyPrefill });
    await rdnInput(wrapper).setValue("cn=Alice2");
    await saveButton(wrapper).trigger("click");
    expect(entryAddMock).toHaveBeenCalledTimes(1);
    const [dn, attributes] = entryAddMock.mock.calls[0];
    expect(dn).toBe("cn=Alice2,ou=people,dc=demo,dc=dbx");
    expect(attributes.cn).toEqual(["Alice2"]);
    expect(attributes.sn).toEqual(["Alice"]);
  });

  it("keeps hand-edited RDN attribute rows when the RDN field changes again", async () => {
    const wrapper = track({ addPrefill: copyPrefill });
    await rdnInput(wrapper).setValue("cn=Alice2");
    await rowFor(wrapper, "cn").find("textarea").setValue("HandEdited");
    await rdnInput(wrapper).setValue("cn=Alice3");
    expect(rowFor(wrapper, "cn").find("textarea").element.value).toBe("HandEdited");
  });

  it("fills only blank rows for multi-component RDNs, keeping other prefilled values", async () => {
    const wrapper = track({ addPrefill: copyPrefill });
    await rdnInput(wrapper).setValue("cn=Ana+sn=Lee");
    expect(rowFor(wrapper, "cn").find("textarea").element.value).toBe("Ana");
    expect(rowFor(wrapper, "sn").find("textarea").element.value).toBe("Alice");
  });

  it("focuses the RDN input when the add dialog opens", async () => {
    const wrapper = track({ addPrefill: copyPrefill }, true);
    await nextTick();
    expect(document.activeElement).toBe(rdnInput(wrapper).element);
  });

  it("keeps multi-valued prefill attributes verbatim via sourceValues", async () => {
    const prefill = {
      rdn: "cn=",
      attributes: { objectClass: ["top", "groupOfNames"], cn: [""], member: ["cn=a,dc=demo,dc=dbx", "cn=b,dc=demo,dc=dbx"] },
    };
    const wrapper = track({ addPrefill: prefill });
    const memberRow = rowFor(wrapper, "member");
    expect(memberRow.find("textarea").element.value).toBe("cn=a,dc=demo,dc=dbx\ncn=b,dc=demo,dc=dbx");
    await rdnInput(wrapper).setValue("cn=Team");
    await rowFor(wrapper, "cn").find("textarea").setValue("Team");
    await saveButton(wrapper).trigger("click");
    const attributes = entryAddMock.mock.calls[0][1];
    expect(attributes.member).toEqual(["cn=a,dc=demo,dc=dbx", "cn=b,dc=demo,dc=dbx"]);
  });

  it("without a prefill the add dialog starts from a bare objectClass row (regression)", () => {
    const wrapper = track();
    const rows = wrapper.findAll(".attr-editor .attr-row");
    expect(rows).toHaveLength(1);
    expect((rows[0].find("input[name='attr-name']").element as HTMLInputElement).value).toBe("objectClass");
    expect((rdnInput(wrapper).element as HTMLInputElement).value).toBe("");
  });
});
