// @vitest-environment happy-dom
// RootDseDialog（矩阵 F12，服务器信息弹窗）UI 测试。mock 方式对照
// ConnectionsPanel.check.spec：模块级 vi.mock（api/clipboard/fileSave），
// 文案断言一律 t() 动态取值（同家族 spec 约定，不硬编码语言串）。
// 覆盖：打开自取数据（rootDse + statuses 并行）、连接与服务器区块（状态点/
// Ping/绑定身份/TLS 徽标与证书校验提示/服务器+协议摘要、单项失败仅降级）、
// 语义分组渲染（命名上下文/能力合并/标识/其他兜底、大小写归一）、OID 注册
// 表命中（附 RFC 标题描述）与未收录回退、复制写剪贴板 + notify、setBase
// payload、导出 saveTextFile 三种结果反馈、错误态（friendly 行内 + 原始串挂
// title + emit）、加载态、关闭重开重拉与 Esc/✕/底部关闭。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { getLdapConnectionId, ldapApi } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import { saveTextFile } from "../lib/fileSave";
import { friendlyLdapError } from "../lib/ldapErrors";
import { t } from "../lib/i18n";
import type { ConnectionSummary } from "../lib/connectionIdentity";
import RootDseDialog from "./RootDseDialog.vue";

vi.mock("../lib/api", () => ({
  ldapApi: {
    rootDse: vi.fn(),
    connectionStatuses: vi.fn(),
    check: vi.fn(),
    whoami: vi.fn(),
  },
  getLdapConnectionId: vi.fn((): string => CONNECTION_ID),
}));

vi.mock("../lib/clipboard", () => ({
  writeClipboardText: vi.fn(),
}));

vi.mock("../lib/fileSave", () => ({
  saveTextFile: vi.fn(),
}));

const CONNECTION_ID = "conn-1";
const ADMIN_AUTHZ_ID = "dn:cn=admin,dc=demo,dc=dbx";

const rootDseMock = vi.mocked(ldapApi.rootDse);
const statusesMock = vi.mocked(ldapApi.connectionStatuses);
const checkMock = vi.mocked(ldapApi.check);
const whoamiMock = vi.mocked(ldapApi.whoami);
const clipboardMock = vi.mocked(writeClipboardText);
const saveTextFileMock = vi.mocked(saveTextFile);

// 样本刻意混入大小写变体（SupportedLDAPVersion）与未注册 OID（1.2.3.4.5）：
// LDAP 属性名大小写不敏感，归组与「其他属性」判定都必须按小写匹配，展示保留
// 服务器原样大小写；未收录 OID 只显原值、不得硬造说明。
const SAMPLE_ATTRIBUTES = {
  namingContexts: ["dc=demo,dc=dbx", "cn=OpenLDAP Configuration"],
  supportedControl: ["1.2.840.113556.1.4.319", "2.16.840.1.113730.3.4.18", "1.2.3.4.5"],
  SupportedLDAPVersion: ["3"],
  vendorName: ["DemoDB"],
  objectClass: ["top"],
  subschemaSubentry: ["cn=Subschema"],
};

const SAMPLE_STATUSES = {
  statuses: [
    { connectionId: CONNECTION_ID, status: "connected" as const, readOnly: false, connectedAt: 1700000000000, lastUsedAt: 1700000600000 },
  ],
};

function mountDialog(open: boolean, connection?: ConnectionSummary | null) {
  return mount(RootDseDialog, { props: { open, connection } });
}

type DialogWrapper = ReturnType<typeof mountDialog>;

const tracked: DialogWrapper[] = [];

function trackDialog(open: boolean, connection?: ConnectionSummary | null) {
  const wrapper = mountDialog(open, connection);
  tracked.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  rootDseMock.mockReset().mockResolvedValue({ attributes: SAMPLE_ATTRIBUTES });
  statusesMock.mockReset().mockResolvedValue(SAMPLE_STATUSES);
  checkMock.mockReset().mockResolvedValue({ ok: true, network: { ok: true, latencyMs: 12 }, bind: { ok: true } });
  whoamiMock.mockReset().mockResolvedValue({ authzId: ADMIN_AUTHZ_ID });
  clipboardMock.mockReset();
  saveTextFileMock.mockReset();
});

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

// 手动控制的 Promise，用于稳定复现「加载中」场景（同 ConnectionsPanel spec）。
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sections = (wrapper: DialogWrapper) => wrapper.findAll(".rootdse-body section");
const sectionByTitle = (wrapper: DialogWrapper, title: string) =>
  sections(wrapper).find((section) => section.find("h3").text().includes(title))!;
const valueRows = (section: ReturnType<DialogWrapper["find"]>) => section.findAll(".rootdse-value-row");
const exportButton = (wrapper: DialogWrapper) => wrapper.find("footer .toolbar-button")!;
const pressEscape = () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

describe("RootDseDialog 打开与分组渲染", () => {
  it("关闭时不渲染弹层", () => {
    const wrapper = trackDialog(false);
    expect(wrapper.find(".modal-backdrop").exists()).toBe(false);
    expect(rootDseMock).not.toHaveBeenCalled();
  });

  it("打开即自取数据（rootDse + statuses 并行），弹层出现且加载态结束", async () => {
    const wrapper = trackDialog(true);
    expect(rootDseMock).toHaveBeenCalledOnce();
    expect(rootDseMock).toHaveBeenCalledWith();
    expect(statusesMock).toHaveBeenCalledOnce();
    // 数据未返回前：spinner 占位、无属性区、导出禁用。
    expect(wrapper.find(".spinning").exists()).toBe(true);
    expect(wrapper.find(".rootdse-body").exists()).toBe(false);
    expect(exportButton(wrapper).attributes("disabled")).toBeDefined();
    await flushPromises();
    expect(wrapper.find(".spinning").exists()).toBe(false);
    expect(wrapper.find(".rootdse-body").exists()).toBe(true);
    expect(wrapper.find(".modal").attributes("aria-label")).toBe(t("rootDse.title"));
    expect(wrapper.find("h2").text()).toBe(t("rootDse.title"));
  });

  it("按语义分组：连接与服务器 + 命名上下文/服务器能力（合并）/服务器标识/其他属性兜底，空组不渲染", async () => {
    const wrapper = trackDialog(true);
    await flushPromises();
    // 连接与服务器节在最前，四节按序出现；样本缺 supportedExtension 等，
    // 不产生多余空组；productName 缺省但 vendorName 在，服务器标识节仍渲染。
    expect(sections(wrapper).map((section) => section.find("h3").text())).toEqual([
      t("rootDse.serverSection"),
      `${t("rootDse.groupNaming")} (2)`,
      `${t("rootDse.groupCapability")} (4)`,
      `${t("rootDse.groupIdentity")} (1)`,
      `${t("rootDse.groupOther")} (2)`,
    ]);
    // 大小写混合的 SupportedLDAPVersion 归入能力组且展示保留原样大小写。
    const capability = sectionByTitle(wrapper, t("rootDse.groupCapability"));
    expect(capability.find("dt").text()).toBe("supportedControl");
    expect(capability.findAll("dt").map((dt) => dt.text())).toEqual(["supportedControl", "SupportedLDAPVersion"]);
    // 其余属性兜底（objectClass / subschemaSubentry），值行 title 挂全文。
    const other = sectionByTitle(wrapper, t("rootDse.groupOther"));
    expect(other.findAll("dt").map((dt) => dt.text())).toEqual(["objectClass", "subschemaSubentry"]);
    expect(valueRows(other)[0].attributes("title")).toBe("top");
  });
});

describe("RootDseDialog 连接与服务器区块", () => {
  it("状态行渲染状态点与标签；Ping/绑定身份渲染后台体检结果", async () => {
    const wrapper = trackDialog(true);
    await flushPromises();
    const conn = sectionByTitle(wrapper, t("rootDse.serverSection"));
    expect(conn.find(".state-dot").classes()).toContain("connected");
    expect(conn.text()).toContain(t("connections.stateConnected"));
    // Ping = ldap/check 的 checkOk 文案（network.latencyMs=12）。
    expect(conn.text()).toContain(t("connections.checkOk", { networkMs: 12 }));
    // 绑定身份 = whoami 的授权身份文案。
    expect(conn.text()).toContain(t("connections.whoamiOk", { authzId: ADMIN_AUTHZ_ID }));
  });

  it("TLS 徽标来自 connection prop（配置层），显式关闭证书校验时附提示", async () => {
    const wrapper = trackDialog(true, { external_config: { tls_mode: "ldaps", tls_verify: false }, port: 636 });
    await flushPromises();
    const conn = sectionByTitle(wrapper, t("rootDse.serverSection"));
    expect(conn.text()).toContain("LDAPS");
    expect(conn.text()).toContain(t("rootDse.tlsVerifyOff"));
  });

  it("只读连接在状态行显示 readOnly 徽标", async () => {
    statusesMock.mockResolvedValue({ statuses: [{ connectionId: CONNECTION_ID, status: "connected", readOnly: true }] });
    const wrapper = trackDialog(true);
    await flushPromises();
    expect(sectionByTitle(wrapper, t("rootDse.serverSection")).text()).toContain(t("readOnly"));
  });

  it("服务器与协议版本摘要行取自 RootDSE 属性（属性名大小写不敏感）", async () => {
    rootDseMock.mockResolvedValue({ attributes: { ...SAMPLE_ATTRIBUTES, productName: ["DemoDB Server"], vendorVersion: ["2.5"] } });
    const wrapper = trackDialog(true);
    await flushPromises();
    const dds = sectionByTitle(wrapper, t("rootDse.serverSection")).findAll("dd");
    // 倒数第二行 = 服务器（product + version 拼接），最后一行 = 协议版本。
    expect(dds[dds.length - 2].text()).toContain("DemoDB Server 2.5");
    expect(dds[dds.length - 1].text()).toBe("3");
  });

  it("check 失败只降级 Ping 行，不影响其他行与主体分组，也不 emit error", async () => {
    checkMock.mockRejectedValue(new Error("connection unknown"));
    const wrapper = trackDialog(true);
    await flushPromises();
    const conn = sectionByTitle(wrapper, t("rootDse.serverSection"));
    expect(conn.text()).toContain(t("connections.checkFail", { error: "connection unknown" }));
    expect(conn.text()).toContain(t("connections.whoamiOk", { authzId: ADMIN_AUTHZ_ID }));
    expect(wrapper.find(".rootdse-body").exists()).toBe(true);
    expect(wrapper.emitted("error")).toBeUndefined();
  });

  it("whoami 失败只降级绑定身份行，不影响 Ping 行", async () => {
    const raw = "no such object";
    whoamiMock.mockRejectedValue(new Error(raw));
    const wrapper = trackDialog(true);
    await flushPromises();
    const conn = sectionByTitle(wrapper, t("rootDse.serverSection"));
    expect(conn.text()).toContain(t("connections.whoamiFailed", { error: friendlyLdapError(raw) }));
    expect(conn.text()).toContain(t("connections.checkOk", { networkMs: 12 }));
  });

  it("状态表拉取失败只降级状态行（行内 form-error），主体分组照常渲染", async () => {
    statusesMock.mockRejectedValue(new Error("statuses unavailable"));
    const wrapper = trackDialog(true);
    await flushPromises();
    const conn = sectionByTitle(wrapper, t("rootDse.serverSection"));
    expect(conn.find(".form-error").text()).toBe(friendlyLdapError("statuses unavailable"));
    expect(wrapper.find(".rootdse-body").exists()).toBe(true);
    expect(wrapper.emitted("error")).toBeUndefined();
  });
});

describe("RootDseDialog OID 说明", () => {
  it("注册表命中的 OID 附 RFC 标题与描述；未收录 OID 只显原值", async () => {
    const wrapper = trackDialog(true);
    await flushPromises();
    const capability = sectionByTitle(wrapper, t("rootDse.groupCapability"));
    // 命中：RFC 2696 分页结果控制 → 标题 + 描述块。
    expect(capability.text()).toContain("Simple Paged Results Manipulation");
    const infoBlocks = capability.findAll(".rootdse-oid-info");
    expect(infoBlocks.length).toBe(2);
    expect(infoBlocks[0].text()).toContain("RFC 2696");
    // 未收录：1.2.3.4.5 仍按原值展示，但没有说明块。
    expect(capability.text()).toContain("1.2.3.4.5");
    const rawRow = valueRows(capability).find((row) => row.text().includes("1.2.3.4.5"))!;
    expect(rawRow.find(".rootdse-oid-info").exists()).toBe(false);
  });
});

describe("RootDseDialog 值行动作", () => {
  it("命名上下文值行带「设为浏览基」，点击 emit setBase 原值", async () => {
    const wrapper = trackDialog(true);
    await flushPromises();
    const naming = sectionByTitle(wrapper, t("rootDse.groupNaming"));
    const setBaseButtons = naming.findAll(".rootdse-value-row .toolbar-button");
    expect(setBaseButtons.map((button) => button.text())).toEqual([t("rootDse.setBase"), t("rootDse.setBase")]);
    // 非命名上下文组不出现设基按钮。
    expect(sectionByTitle(wrapper, t("rootDse.groupOther")).findAll(".rootdse-value-row .toolbar-button")).toHaveLength(0);
    await setBaseButtons[1].trigger("click");
    expect(wrapper.emitted("setBase")).toEqual([["cn=OpenLDAP Configuration"]]);
  });

  it("值行右键复制写剪贴板，成功/失败分别 notify copied/copyFailed", async () => {
    const wrapper = trackDialog(true);
    await flushPromises();
    // 行内复制按钮已移除：右键值行打开单项菜单再复制。
    const valueRow = sectionByTitle(wrapper, t("rootDse.groupNaming")).find(".rootdse-value-row")!;
    expect(valueRow.find(".icon-button").exists()).toBe(false);
    const openMenu = async () => {
      await valueRow.trigger("contextmenu", { clientX: 40, clientY: 40 });
      await flushPromises();
      await wrapper.find(".context-menu [role='menuitem']").trigger("click");
    };
    clipboardMock.mockResolvedValueOnce(true);
    await openMenu();
    await flushPromises();
    expect(clipboardMock).toHaveBeenCalledWith("dc=demo,dc=dbx");
    expect(wrapper.emitted("notify")).toEqual([[t("copied")]]);
    // 写入失败如实反馈，不假装"已复制"。
    clipboardMock.mockResolvedValueOnce(false);
    await openMenu();
    await flushPromises();
    expect(wrapper.emitted("notify")).toEqual([[t("copied")], [t("copyFailed")]]);
  });
});

describe("RootDseDialog 导出", () => {
  it("导出走 saveTextFile（root-dse.txt，属性名排序的 name: values 行），宿主/对话框保存报 exportDone", async () => {
    const wrapper = trackDialog(true);
    await flushPromises();
    saveTextFileMock.mockResolvedValueOnce({ status: "saved", name: "root-dse.txt", via: "host" });
    await exportButton(wrapper).trigger("click");
    await flushPromises();
    // 属性名按 JS 排序（大写在前），值以 ", " 连接——与 App 旧直导同一文本形态。
    const expectedText = [
      "SupportedLDAPVersion: 3",
      "namingContexts: dc=demo,dc=dbx, cn=OpenLDAP Configuration",
      "objectClass: top",
      "subschemaSubentry: cn=Subschema",
      "supportedControl: 1.2.840.113556.1.4.319, 2.16.840.1.113730.3.4.18, 1.2.3.4.5",
      "vendorName: DemoDB",
    ].join("\n");
    expect(saveTextFileMock).toHaveBeenCalledOnce();
    expect(saveTextFileMock).toHaveBeenCalledWith({ name: "root-dse.txt", contentType: "text/plain", text: expectedText });
    expect(wrapper.emitted("notify")).toEqual([[t("result.exportDone", { name: "root-dse.txt" })]]);
  });

  it("旧版匿名下载兜底（via legacy）改报 exportDownloaded；取消（cancelled）静默不通知", async () => {
    const wrapper = trackDialog(true);
    await flushPromises();
    saveTextFileMock.mockResolvedValueOnce({ status: "saved", name: "root-dse.txt", via: "legacy" });
    await exportButton(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.emitted("notify")).toEqual([[t("result.exportDownloaded", { name: "root-dse.txt" })]]);

    saveTextFileMock.mockResolvedValueOnce({ status: "cancelled", name: "root-dse.txt", via: "host" });
    await exportButton(wrapper).trigger("click");
    await flushPromises();
    // 用户取消另存为对话框：不弹成功也不弹错误（照 notifyExportSaved 语义）。
    expect(wrapper.emitted("notify")).toHaveLength(1);
    expect(wrapper.emitted("error")).toBeUndefined();
  });
});

describe("RootDseDialog 错误与关闭", () => {
  it("拉取失败：行内友好文案 + 原始串挂 title + emit error", async () => {
    const raw = 'ldap rootDse: LDAP Result Code 53 "Unwilling To Perform"';
    rootDseMock.mockReset().mockRejectedValue(new Error(raw));
    const wrapper = trackDialog(true);
    await flushPromises();
    const friendly = friendlyLdapError(raw);
    expect(friendly).not.toBe(raw);
    const alert = wrapper.find(".form-error");
    expect(alert.text()).toBe(friendly);
    expect(alert.attributes("title")).toBe(raw);
    expect(wrapper.emitted("error")).toEqual([[friendly]]);
    // 失败后无数据区、导出禁用；RootDSE 失败时后台体检也不再发起。
    expect(wrapper.find(".rootdse-body").exists()).toBe(false);
    expect(exportButton(wrapper).attributes("disabled")).toBeDefined();
    expect(checkMock).not.toHaveBeenCalled();
    expect(whoamiMock).not.toHaveBeenCalled();
  });

  it("未知错误（友好映射原样透传）时 title 回退为行内文案，不重复挂原始串", async () => {
    const raw = "-32601 method not found";
    rootDseMock.mockReset().mockRejectedValue(new Error(raw));
    const wrapper = trackDialog(true);
    await flushPromises();
    const alert = wrapper.find(".form-error");
    expect(alert.text()).toBe(raw);
    expect(alert.attributes("title")).toBe(raw);
    expect(wrapper.emitted("error")).toEqual([[raw]]);
  });

  it("关闭重开重新拉取，不缓存旧数据", async () => {
    const wrapper = trackDialog(true);
    await flushPromises();
    expect(rootDseMock).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ open: false });
    // 第二次打开用 pending Promise 钉住：重开瞬间应回到加载态（旧分组清空）。
    const pending = deferred<{ attributes: typeof SAMPLE_ATTRIBUTES }>();
    rootDseMock.mockReturnValueOnce(pending.promise);
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    expect(rootDseMock).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".spinning").exists()).toBe(true);
    expect(wrapper.find(".rootdse-body").exists()).toBe(false);
    pending.resolve({ attributes: SAMPLE_ATTRIBUTES });
    await flushPromises();
    expect(wrapper.find(".rootdse-body").exists()).toBe(true);
  });

  it("Esc、标题栏 ✕、底部关闭按钮均可关闭", async () => {
    const wrapper = trackDialog(false);
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toHaveLength(1);
    await wrapper.find("header .icon-button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(2);
    const footerClose = wrapper
      .findAll("footer button")
      .find((button) => button.text() === t("close"))!;
    await footerClose.trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(3);
  });
});
