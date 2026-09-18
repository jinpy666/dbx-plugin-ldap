// @vitest-environment happy-dom
// ImportEntryDialog 组件测试（阶段4）：粘贴解析 → 预览（DN/属性数/告警）→
// DN 策略 → 逐条 entryAdd → 成败汇总与 imported 事件；canWrite 门禁。
// 逐条状态（待导入/已导入/失败徽标）、changetype 变更记录拒绝（LDIF 路径
// 解析丢弃 + PS 路径属性键兜底）、失败清单复制与只重跑失败项。
// ldapApi.entryAdd 打 mock；DnPickerDialog 打 stub（树选择另测）。
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import ImportEntryDialog from "./ImportEntryDialog.vue";
import { ldapApi } from "../lib/api";
import { t } from "../lib/i18n";

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

// PS Format-List 双块：第二块带 changetype 属性（PS 解析路径会原样保留该键）。
const PS_CHANGETYPE_SAMPLE = [
  "distinguishedName : cn=ok,dc=demo,dc=dbx",
  "objectClass : user",
  "",
  "distinguishedName : cn=chg,dc=demo,dc=dbx",
  "changetype : add",
  "objectClass : user",
].join("\n");

/** 按精确文案定位按钮（失败清单的复制/重试按钮无专属 class）。 */
function findButtonByText(wrapper: VueWrapper, text: string) {
  return wrapper.findAll("button").find((button) => button.text() === text);
}

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

  it("drops LDIF change records at parse time and never sends their DN", async () => {
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue("dn: cn=x,dc=demo,dc=dbx\nchangetype: modify\nreplace: sn\nsn: New\n");
    await wrapper.find(PARSE_BUTTON).trigger("click");
    // LDIF 路径：lib/ldif.ts 将变更记录整条丢弃（仅记 notes）→ 无预览可导入
    expect(wrapper.find(".import-preview").exists()).toBe(false);
    expect((wrapper.find(IMPORT_BUTTON).element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.find(IMPORT_BUTTON).trigger("click");
    await flushPromises();
    expect(entryAddMock).not.toHaveBeenCalled();
  });

  it("marks changetype entries as failed and never sends their DN", async () => {
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue(PS_CHANGETYPE_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    await wrapper.find(IMPORT_BUTTON).trigger("click");
    await flushPromises();
    // 仅正常条目发了 ldap/entry/add；changetype 条目在发送前被拒绝
    expect(entryAddMock.mock.calls.map((call) => call[0])).toEqual(["cn=ok,dc=demo,dc=dbx"]);
    const rows = wrapper.findAll(".import-preview tbody tr");
    const chgRow = rows.find((row) => row.text().includes("cn=chg"));
    expect(chgRow).toBeDefined();
    expect(chgRow!.text()).toContain(t("ldap.importEntry.statusFailed"));
    expect(chgRow!.text()).toContain(t("ldap.importEntry.changetypeRejected"));
  });

  it("renders per-entry status badges from pending to ok/failed", async () => {
    entryAddMock.mockRejectedValueOnce(new Error("entry exists"));
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    // 解析后全部为「待导入」徽标
    for (const row of wrapper.findAll(".import-preview tbody tr")) {
      expect(row.text()).toContain(t("ldap.importEntry.statusPending"));
    }
    await wrapper.find(IMPORT_BUTTON).trigger("click");
    await flushPromises();
    const rows = wrapper.findAll(".import-preview tbody tr");
    expect(rows[0].text()).toContain(t("ldap.importEntry.statusFailed"));
    expect(rows[1].text()).toContain(t("ldap.importEntry.statusOk"));
  });

  it("copies the failed list as DN<TAB>error lines and notifies", async () => {
    entryAddMock.mockRejectedValueOnce(new Error("entry exists"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { dbxPlugin?: unknown }).dbxPlugin = { clipboard: { writeText } };
    try {
      const wrapper = track();
      await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
      await wrapper.find(PARSE_BUTTON).trigger("click");
      await wrapper.find(IMPORT_BUTTON).trigger("click");
      await flushPromises();
      const copyButton = findButtonByText(wrapper, t("ldap.importEntry.copyFailedList"));
      expect(copyButton).toBeDefined();
      await copyButton!.trigger("click");
      await flushPromises();
      // 每行 `DN\t错误文案`；成功条目不出现在清单
      expect(writeText).toHaveBeenCalledWith("cn=a,dc=demo,dc=dbx\tentry exists");
      expect(wrapper.emitted("notify")![0]).toEqual([t("copied")]);
    } finally {
      delete (window as unknown as { dbxPlugin?: unknown }).dbxPlugin;
    }
  });

  it("retries only the failed entries and refreshes their statuses", async () => {
    entryAddMock.mockRejectedValueOnce(new Error("entry exists"));
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    await wrapper.find(IMPORT_BUTTON).trigger("click");
    await flushPromises();
    expect(entryAddMock).toHaveBeenCalledTimes(2);
    const retryButton = findButtonByText(wrapper, t("ldap.importEntry.retryFailed"));
    expect(retryButton).toBeDefined();
    await retryButton!.trigger("click");
    await flushPromises();
    // 只补发失败的 cn=a；已成功的 cn=b 不重复发
    expect(entryAddMock).toHaveBeenCalledTimes(3);
    expect(entryAddMock.mock.calls[2][0]).toBe("cn=a,dc=demo,dc=dbx");
    expect(wrapper.emitted("imported")![1]).toEqual([1, 0]);
    const rows = wrapper.findAll(".import-preview tbody tr");
    expect(rows[0].text()).toContain(t("ldap.importEntry.statusOk"));
    // 失败清零 → 失败清单区随之隐藏
    expect(wrapper.find(".import-failed").exists()).toBe(false);
  });

  it("vetoes Escape and backdrop while the import loop is in flight (J-4/L-3)", async () => {
    // 首条请求挂起 = 导入在途：Esc 与遮罩都被 allowClose 否决，弹窗保持
    // 打开（防"视觉遗弃"）；✕/取消显式通道仍可关闭。
    let release!: (value: { success: boolean }) => void;
    entryAddMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    await wrapper.find(IMPORT_BUTTON).trigger("click");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.find(".modal-backdrop").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.find(".icon-button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    release({ success: true });
    await flushPromises();
  });

  it("allows Escape and backdrop close when the import loop is idle", async () => {
    const wrapper = track();
    await wrapper.find(TEXTAREA).setValue(LDIF_SAMPLE);
    await wrapper.find(PARSE_BUTTON).trigger("click");
    // 空闲态守卫放行：Esc 与遮罩 self 点击均可关闭。
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toHaveLength(1);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    await wrapper.find(".modal-backdrop").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(2);
  });
});
