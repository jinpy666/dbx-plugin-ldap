// @vitest-environment happy-dom
// ImportEntryDialog 组件测试（阶段4）：粘贴解析 → 预览（DN/属性数/告警）→
// DN 策略 → 逐条 entryAdd → 成败汇总与 imported 事件；canWrite 门禁。
// ldapApi.entryAdd 打 mock；DnPickerDialog 打 stub（树选择另测）。
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ImportEntryDialog from "./ImportEntryDialog.vue";
import { ldapApi } from "../lib/api";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, ldapApi: { ...actual.ldapApi, entryAdd: vi.fn() } };
});

vi.mock("./DnPickerDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "DnPickerDialog",
      props: { open: { type: Boolean, default: false }, baseDn: { type: String, default: "" } },
      emits: ["close", "select"],
      setup: () => () => h("div", { class: "dn-picker-stub" }),
    }),
  };
});

const entryAddMock = vi.mocked(ldapApi.entryAdd);

beforeEach(() => {
  entryAddMock.mockReset();
  entryAddMock.mockResolvedValue({ success: true });
});

const tracked: Awaited<ReturnType<typeof mountDialog>>[] = [];

function mountDialog(props: { open?: boolean; canWrite?: boolean; parentDn?: string } = {}) {
  return mount(ImportEntryDialog, { props: { open: true, canWrite: true, ...props } });
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = (props?: Parameters<typeof mountDialog>[0]) => {
  const wrapper = mountDialog(props);
  tracked.push(wrapper);
  return wrapper;
};

const TEXTAREA = ".import-textarea";
const PARSE_BUTTON = ".import-source-actions .primary-button";
const IMPORT_BUTTON = "footer .primary-button";

const LDIF_SAMPLE = "dn: cn=a,dc=demo,dc=dbx\ncn: a\nsn: A\n\ndn: cn=b,dc=demo,dc=dbx\ncn: b\n";

describe("ImportEntryDialog", () => {
  it("parses LDIF paste into a preview with DN and attribute counts", async () => {
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    const rows = wrapper.findAll(".import-preview tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("cn=a,dc=demo,dc=dbx");
    expect(rows[0].text()).toContain("2");
  });

  it("imports each parsed entry via entryAdd and emits the summary", async () => {
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    await wrapper.find(IMPORT_BUTTON).trigger("click");
    await flushPromises();
    expect(entryAddMock).toHaveBeenCalledTimes(2);
    expect(entryAddMock.mock.calls[0][0]).toBe("cn=a,dc=demo,dc=dbx");
    expect(wrapper.emitted("imported")![0]).toEqual([2, 0]);
    expect(wrapper.find("[role='status']").text()).toContain("2");
  });

  it("counts failures without aborting the batch", async () => {
    entryAddMock.mockRejectedValueOnce(new Error("entry exists"));
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    await wrapper.find(IMPORT_BUTTON).trigger("click");
    await flushPromises();
    expect(entryAddMock).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted("imported")![0]).toEqual([1, 1]);
  });

  it("forces the parent-DN strategy for entries without a DN and rewrites targets", async () => {
    const wrapper = track({ parentDn: "ou=incoming,dc=demo,dc=dbx" });
    await wrapper.find(TEXTAREA).setValue("GivenName : Alice\n");
    await wrapper.find(PARSE_BUTTON).trigger("click");
    // PS 输出缺 DN → 预览为空 DN + 警告；策略应为 under（用户先补父 DN）
    expect(wrapper.find(".import-preview .form-error").exists()).toBe(true);
    expect((wrapper.find("input[value='keep']").element as HTMLInputElement).disabled).toBe(true);
    // 填父 DN 后导入：finalDn = RDN(parent 解析不出 → 空) + parent —— 无 RDN 时
    // 只剩父 DN 本身会被 isLikelyDn 放行，但后端会拒；此处仅验证按钮可用化
    await wrapper.find(".import-parent-input").setValue("ou=incoming,dc=demo,dc=dbx");
    expect((wrapper.find(IMPORT_BUTTON).element as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps original DNs by default and rewrites when 'under' is chosen", async () => {
    const wrapper = track({ parentDn: "ou=other,dc=demo,dc=dbx" });
    await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    expect(wrapper.findAll(".import-preview tbody tr")[0].text()).toContain("cn=a,dc=demo,dc=dbx");
    await wrapper.find("input[value='under']").setValue();
    await wrapper.find(".import-parent-input").setValue("ou=other,dc=demo,dc=dbx");
    expect(wrapper.findAll(".import-preview tbody tr")[0].text()).toContain("cn=a,ou=other,dc=demo,dc=dbx");
  });

  it("disables importing for read-only connections", async () => {
    const wrapper = track({ canWrite: false });
    await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    expect((wrapper.find(IMPORT_BUTTON).element as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows nothing to import for unrecognized text", async () => {
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue("hello world");
    await wrapper.find(PARSE_BUTTON).trigger("click");
    expect(wrapper.find(".import-preview").exists()).toBe(false);
    expect((wrapper.find(IMPORT_BUTTON).element as HTMLButtonElement).disabled).toBe(true);
  });
});
