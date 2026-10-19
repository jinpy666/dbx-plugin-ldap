// @vitest-environment happy-dom
// 传输看守移植自 dbx-plugin-ssh 的 useTerminalTransportWatch：断链不以 ldap/*
// 报错形式落地，靠 online/offline 即时信号 + 有界探测兜底 + 同源可达性确认
// 恢复。这里逐条验证：离线即落不可用、探测超时兜底、恢复单飞、连接切换的
// 失败不归属断链。
import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSPORT_HOST_REACHABILITY_TIMEOUT_MS,
  TRANSPORT_PROBE_INTERVAL_MS,
  TRANSPORT_PROBE_TIMEOUT_MS,
  useTransportWatch,
} from "./useTransportWatch";

type WatchOptions = Parameters<typeof useTransportWatch>[0];

function mountWatch(overrides: Partial<WatchOptions> = {}) {
  let api!: ReturnType<typeof useTransportWatch>;
  const wrapper = mount(defineComponent({
    setup() {
      api = useTransportWatch({
        active: () => true,
        subject: () => "conn-1",
        probe: vi.fn().mockResolvedValue({ authzId: "dn:cn=admin" }),
        recover: vi.fn().mockResolvedValue(true),
        onUnavailable: vi.fn(),
        onRecovered: vi.fn(),
        ...overrides,
      });
      return () => null;
    },
  }));
  return { api, wrapper };
}

describe("useTransportWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("goes unavailable when the probe invoke never settles, and recovers only after reachability confirms", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => new Promise<never>(() => {}));
    const canReachHost = vi.fn().mockResolvedValue(false);
    const recover = vi.fn().mockResolvedValue(true);
    const onUnavailable = vi.fn();
    const { wrapper } = mountWatch({ probe, canReachHost, recover, onUnavailable });

    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledOnce();

    // 在途探测挂满 8s 才落不可用态（探测本身单飞，期间不叠加）。
    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_TIMEOUT_MS);
    expect(onUnavailable).toHaveBeenCalledOnce();

    // 下一轮周期探测发现不可用态 → 先问同源可达性：未确认前不执行恢复。
    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_INTERVAL_MS);
    expect(canReachHost).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();

    canReachHost.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_INTERVAL_MS);
    expect(recover).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("treats the offline event as an immediate outage and recovers on online", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue({ authzId: "dn:cn=admin" });
    const canReachHost = vi.fn().mockResolvedValue(false);
    const recover = vi.fn().mockResolvedValue(true);
    const onUnavailable = vi.fn();
    const onRecovered = vi.fn();
    const { wrapper } = mountWatch({ probe, canReachHost, recover, onUnavailable, onRecovered });

    window.dispatchEvent(new Event("offline"));
    expect(onUnavailable).toHaveBeenCalledOnce();
    // 可达性未确认前：周期兜底只重试恢复探测，不执行恢复动作、不发健康探测。
    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_INTERVAL_MS);
    expect(probe).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();

    // online + 可达性转真：恢复动作执行一次，回到健康探测节奏。
    canReachHost.mockResolvedValue(true);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(TRANSPORT_HOST_REACHABILITY_TIMEOUT_MS);
    expect(recover).toHaveBeenCalledOnce();
    expect(onRecovered).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("keeps recovery single-flight when online events and probes pile up", async () => {
    vi.useFakeTimers();
    let reachability = vi.fn().mockResolvedValue(false);
    const recover = vi.fn(async () => {
      await Promise.resolve();
      return true;
    });
    const onRecovered = vi.fn();
    const { wrapper } = mountWatch({ probe: vi.fn().mockRejectedValue(new Error("bridge gone")), canReachHost: () => reachability(), recover, onRecovered });

    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_INTERVAL_MS);
    expect(onRecovered).not.toHaveBeenCalled();

    reachability = vi.fn().mockResolvedValue(true);
    // online 事件 + 周期探测同时触发恢复：单飞闸下 recover 只跑一次。
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_INTERVAL_MS);
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
    expect(onRecovered).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("stays silent while inactive and ignores failures from a switched connection", async () => {
    vi.useFakeTimers();
    let active = false;
    let subject = "conn-1";
    let rejectProbe!: (cause: unknown) => void;
    const probe = vi.fn(() => new Promise<unknown>((_resolve, reject) => { rejectProbe = reject; }));
    const onUnavailable = vi.fn();
    const { api, wrapper } = mountWatch({ active: () => active, subject: () => subject, probe, onUnavailable });

    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_INTERVAL_MS * 2);
    expect(probe).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();

    // 探测在途时切换连接：旧主体的失败不落不可用态。
    active = true;
    await vi.advanceTimersByTimeAsync(TRANSPORT_PROBE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledOnce();
    subject = "conn-2";
    rejectProbe(new Error("not connected"));
    await Promise.resolve();
    await Promise.resolve();
    expect(onUnavailable).not.toHaveBeenCalled();

    // 显式上报仍受主体/激活闸约束：切回原主体且激活才落态。
    subject = "conn-1";
    api.reportUnavailable();
    expect(onUnavailable).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("aborts the same-origin reachability probe when the host does not answer", async () => {
    vi.useFakeTimers();
    const recover = vi.fn().mockResolvedValue(true);
    const onRecovered = vi.fn();
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = mountWatch({ probe: vi.fn().mockRejectedValue(new Error("bridge gone")), recover, onRecovered });

    window.dispatchEvent(new Event("offline"));
    // online 事件立即触发恢复：同源可达性探测在 2s 窗口内不被应答即中止。
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(TRANSPORT_HOST_REACHABILITY_TIMEOUT_MS);

    expect(fetchMock).toHaveBeenCalledWith(window.location.href, expect.objectContaining({
      method: "HEAD",
      cache: "no-store",
      credentials: "same-origin",
    }));
    expect(recover).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
