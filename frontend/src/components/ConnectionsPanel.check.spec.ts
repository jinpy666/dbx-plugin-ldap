// @vitest-environment happy-dom
// ConnectionsPanel 每行「检查连接」按钮（ldap/check）UI 测试：检查态文案、
// 全通过/网络失败/认证失败/reject 四种结果的行内展示，以及两行检查互不阻塞。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ConnectionsPanel from "./ConnectionsPanel.vue";

// 照库内其他组件 spec 的方式 mock ../lib/api（面板同时用到 statuses/check/whoami
// 与全局当前连接 id）。
vi.mock("../lib/api", () => ({
  getLdapConnectionId: vi.fn(() => "conn-a"),
  ldapApi: {
    connectionStatuses: vi.fn(),
    check: vi.fn(),
    whoami: vi.fn(),
  },
}));

import { getLdapConnectionId, ldapApi, type LdapCheckResult } from "../lib/api";

const connectionStatusesMock = vi.mocked(ldapApi.connectionStatuses);
const checkMock = vi.mocked(ldapApi.check);
const whoamiMock = vi.mocked(ldapApi.whoami);
const currentConnectionMock = vi.mocked(getLdapConnectionId);

beforeEach(() => {
  connectionStatusesMock.mockReset();
  checkMock.mockReset();
  whoamiMock.mockReset();
  currentConnectionMock.mockReset().mockReturnValue("conn-a");
  connectionStatusesMock.mockResolvedValue({ statuses: [statusOf("conn-a")] });
});

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

function statusOf(connectionId: string) {
  return { connectionId, status: "idle" as const };
}

function okResult(latencyMs = 12): LdapCheckResult {
  return { ok: true, network: { ok: true, latencyMs }, bind: { ok: true } };
}

// 手动控制的 Promise，用于稳定复现「检查中」与两行并发场景。
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mountPanel(statusIds: string[]) {
  connectionStatusesMock.mockResolvedValue({ statuses: statusIds.map(statusOf) });
  return mount(ConnectionsPanel, { props: { open: true } });
}

type PanelWrapper = ReturnType<typeof mountPanel>;

const tracked: PanelWrapper[] = [];

async function mountedRows(statusIds: string[]) {
  const wrapper = mountPanel(statusIds);
  tracked.push(wrapper);
  await flushPromises();
  return wrapper.findAll("li");
}

describe("ConnectionsPanel 每行检查连接", () => {
  it("点击进入检查态（running 文案 + 按钮禁用），全 ok 后显示 checkOk 含 latencyMs", async () => {
    const pending = deferred<LdapCheckResult>();
    checkMock.mockReturnValueOnce(pending.promise);
    const rows = await mountedRows(["conn-a"]);
    const button = rows[0].find(".check-button");
    expect(button.attributes("title")).toBe("检查连接");
    expect(button.attributes("aria-label")).toBe("检查连接");

    await button.trigger("click");
    expect(checkMock).toHaveBeenCalledWith("conn-a");
    expect(rows[0].text()).toContain("检查中…");
    expect(rows[0].find(".check-button").attributes("disabled")).toBeDefined();

    pending.resolve(okResult(12));
    await flushPromises();
    const result = rows[0].find(".settings-list-main span:last-child");
    expect(rows[0].text()).toContain("网络 12ms · 认证通过");
    expect(result.classes()).toContain("muted");
    expect(result.classes()).not.toContain("form-error");
    expect(rows[0].find(".check-button").attributes("disabled")).toBeUndefined();
  });

  it("network 段失败 → checkNetworkFail 文案并走高亮错误色", async () => {
    checkMock.mockResolvedValue({
      ok: false,
      network: { ok: false, error: "connection timed out" },
      bind: { ok: false, skipped: true },
    });
    const rows = await mountedRows(["conn-a"]);
    await rows[0].find(".check-button").trigger("click");
    await flushPromises();
    const result = rows[0].find(".settings-list-main span:last-child");
    expect(result.text()).toBe("网络不通:connection timed out");
    expect(result.classes()).toContain("form-error");
  });

  it("bind 段失败 → checkBindFail 文案", async () => {
    checkMock.mockResolvedValue({
      ok: false,
      network: { ok: true, latencyMs: 5 },
      bind: { ok: false, error: "invalid credentials" },
    });
    const rows = await mountedRows(["conn-a"]);
    await rows[0].find(".check-button").trigger("click");
    await flushPromises();
    expect(rows[0].find(".settings-list-main span:last-child").text()).toBe("网络通,认证失败:invalid credentials");
  });

  it("invoke reject（如后端未实现 ldap/check）→ checkFail 文案且按钮恢复可用", async () => {
    checkMock.mockRejectedValue(new Error("-32601 method not found"));
    const rows = await mountedRows(["conn-a"]);
    await rows[0].find(".check-button").trigger("click");
    await flushPromises();
    const result = rows[0].find(".settings-list-main span:last-child");
    expect(result.text()).toBe("检查失败:-32601 method not found");
    expect(result.classes()).toContain("form-error");
    expect(rows[0].find(".check-button").attributes("disabled")).toBeUndefined();
  });

  it("两行互不阻塞：第一行 pending 时第二行可查且正常出结果", async () => {
    const pending = deferred<LdapCheckResult>();
    checkMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(okResult(7));
    const rows = await mountedRows(["conn-a", "conn-b"]);

    await rows[0].find(".check-button").trigger("click");
    expect(rows[0].text()).toContain("检查中…");

    // 第一行还在 pending，第二行照常可点、可完成。
    await rows[1].find(".check-button").trigger("click");
    await flushPromises();
    expect(checkMock).toHaveBeenNthCalledWith(1, "conn-a");
    expect(checkMock).toHaveBeenNthCalledWith(2, "conn-b");
    expect(rows[1].text()).toContain("网络 7ms · 认证通过");
    expect(rows[1].find(".check-button").attributes("disabled")).toBeUndefined();
    // 第一行仍处于检查态。
    expect(rows[0].text()).toContain("检查中…");
    expect(rows[0].find(".check-button").attributes("disabled")).toBeDefined();

    pending.resolve(okResult(3));
    await flushPromises();
    expect(rows[0].text()).toContain("网络 3ms · 认证通过");
  });

  it("再次点击重查：新结果覆盖上一次结果", async () => {
    checkMock
      .mockResolvedValueOnce(okResult(12))
      .mockResolvedValueOnce({
        ok: false,
        network: { ok: false, error: "host unreachable" },
        bind: { ok: false, skipped: true },
      });
    const rows = await mountedRows(["conn-a"]);
    await rows[0].find(".check-button").trigger("click");
    await flushPromises();
    expect(rows[0].text()).toContain("网络 12ms · 认证通过");

    await rows[0].find(".check-button").trigger("click");
    await flushPromises();
    expect(rows[0].find(".settings-list-main span:last-child").text()).toBe("网络不通:host unreachable");
  });
});

describe("ConnectionsPanel 每行身份查询（WhoAmI）", () => {
  it("当前连接可查：进行中禁用，成功显示 whoamiOk 含 authzId（muted）", async () => {
    const pending = deferred<{ authzId: string }>();
    whoamiMock.mockReturnValueOnce(pending.promise);
    const rows = await mountedRows(["conn-a"]);
    const button = rows[0].find(".whoami-button");
    expect(button.attributes("title")).toBe("身份查询");
    expect(button.attributes("aria-label")).toBe("身份查询");
    expect(button.attributes("disabled")).toBeUndefined();

    await button.trigger("click");
    expect(whoamiMock).toHaveBeenCalledWith();
    expect(rows[0].find(".whoami-button").attributes("disabled")).toBeDefined();

    pending.resolve({ authzId: "cn=admin,dc=demo" });
    await flushPromises();
    const result = rows[0].find(".settings-list-main span:last-child");
    expect(result.text()).toBe("当前认证身份：cn=admin,dc=demo");
    expect(result.classes()).toContain("muted");
    expect(result.classes()).not.toContain("form-error");
    expect(rows[0].find(".whoami-button").attributes("disabled")).toBeUndefined();
  });

  it("非当前连接禁用；当前连接查询 reject → whoamiFailed 文案走错误色且按钮恢复", async () => {
    whoamiMock.mockRejectedValueOnce(new Error("-32601 method not found"));
    const rows = await mountedRows(["conn-a", "conn-b"]);

    // 全局当前连接是 conn-a：conn-b 行的 whoami 按钮禁用（whoami 语义跟随当前连接）。
    expect(rows[1].find(".whoami-button").attributes("disabled")).toBeDefined();
    expect(rows[0].find(".whoami-button").attributes("disabled")).toBeUndefined();

    await rows[0].find(".whoami-button").trigger("click");
    await flushPromises();
    const result = rows[0].find(".settings-list-main span:last-child");
    expect(result.text()).toBe("身份查询失败：-32601 method not found");
    expect(result.classes()).toContain("form-error");
    expect(rows[0].find(".whoami-button").attributes("disabled")).toBeUndefined();
  });
});
