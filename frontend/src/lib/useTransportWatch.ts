import { onBeforeUnmount } from "vue";

export const TRANSPORT_PROBE_INTERVAL_MS = 5_000;
export const TRANSPORT_PROBE_TIMEOUT_MS = 8_000;
export const TRANSPORT_HOST_REACHABILITY_TIMEOUT_MS = 2_000;

/**
 * Detects browser-to-host outages that never surface as an `ldap/*` error:
 * on a dead link the in-flight invoke never settles and later calls vanish.
 * Ported from dbx-plugin-ssh's useTerminalTransportWatch (constants aligned):
 * browser online/offline events give the immediate signal, the bounded probe
 * covers Docker/WebSocket paths where navigator.onLine stays true, and
 * recovery re-runs the caller's reopen action once a same-origin probe
 * confirms the host is reachable again.
 */
export function useTransportWatch(options: {
  /** 仅就绪且挂定连接的主工作台探测；boot 恢复窗/log 面板一律静止（gate）。 */
  active: () => boolean;
  /** 当前探测主体（connectionId）：探测期间切换连接的失败不归属为断链。 */
  subject: () => string;
  /** 只读轻量探测 RPC（App.vue 注入 ldapApi.whoami）。 */
  probe: () => Promise<unknown>;
  /** 恢复动作：宿主 reopen + 树/Base DN 重解；返回 false = 仍不可用。 */
  recover: () => Promise<boolean>;
  onUnavailable: () => void;
  onRecovered: () => void;
  canReachHost?: () => Promise<boolean>;
}) {
  let probeTimer = 0;
  let probeInFlight = false;
  let recoveryInFlight = false;
  let unavailableSubject = "";
  let stopped = false;

  // DBX Web 部署跑在 http(s) 浏览器上下文里；原生 webview（file://）保持
  // 宿主推送的连接生命周期，看守整体静默不启动。
  const browserDeployment = window.location.protocol === "http:" || window.location.protocol === "https:";

  async function probeHostReachability(): Promise<boolean> {
    if (options.canReachHost) {
      try {
        return await options.canReachHost();
      } catch {
        return false;
      }
    }

    // invoke 的超时在宿主收到 HTTP 请求之后才由宿主执行，卡在浏览器与宿主
    // 之间的请求它永远收不到——先用可中止的同源请求判定何时能安全重开。
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TRANSPORT_HOST_REACHABILITY_TIMEOUT_MS);
    try {
      await fetch(window.location.href, {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        settled = true;
        reject(new Error(`LDAP transport probe timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      Promise.resolve(operation).then(
        (value) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(value);
        },
        (cause: unknown) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(cause);
        },
      );
    });
  }

  function reportUnavailable() {
    if (stopped || !browserDeployment) return;
    const subject = options.subject();
    if (!subject || !options.active() || unavailableSubject === subject) return;
    unavailableSubject = subject;
    options.onUnavailable();
  }

  async function tryRecover() {
    const subject = unavailableSubject;
    if (stopped || !browserDeployment || recoveryInFlight || !subject) return;
    // 主体已被切换/摘除（连接换页签、boot 窗重启）：旧的不可用态作废。
    if (!options.active() || options.subject() !== subject) {
      unavailableSubject = "";
      return;
    }
    recoveryInFlight = true;
    try {
      if (await probeHostReachability()) {
        if (await options.recover()) {
          unavailableSubject = "";
          options.onRecovered();
        }
      }
    } finally {
      recoveryInFlight = false;
    }
  }

  async function probe() {
    if (stopped || !browserDeployment || document.visibilityState === "hidden") return;
    if (unavailableSubject) {
      await tryRecover();
      return;
    }
    if (probeInFlight || !options.active()) return;
    const subject = options.subject();
    if (!subject) return;
    probeInFlight = true;
    try {
      await withTimeout(Promise.resolve().then(() => options.probe()), TRANSPORT_PROBE_TIMEOUT_MS);
    } catch {
      // 超时必须由本页面判定：宿主执行不到它收不到的 HTTP 请求。探测期间
      // 切换连接/退出就绪态的失败不归属断链（不是当前主体的 outage）。
      if (options.subject() === subject && options.active()) reportUnavailable();
    } finally {
      probeInFlight = false;
    }
  }

  function onOffline() {
    reportUnavailable();
  }

  function onOnline() {
    void tryRecover();
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") void probe();
  }

  if (browserDeployment) {
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    probeTimer = window.setInterval(() => void probe(), TRANSPORT_PROBE_INTERVAL_MS);
  }

  onBeforeUnmount(() => {
    stopped = true;
    window.clearInterval(probeTimer);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  return { reportUnavailable };
}
