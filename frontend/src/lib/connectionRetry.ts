/**
 * Boot-restore bounded retry for the workbench's first data load
 * (web/docker 恢复自愈，对标 dbx-plugin-ssh#144 的 connectRetry 分窗位设计)。
 *
 * LDAP 工作台无持久会话，没有 ssh 的 session/open 重试梯——但 web/docker
 * 恢复竞态完全同构：整页刷新/宿主重启后，宿主向 sidecar 重放
 * connection/connect（凭据重推）晚于恢复页的首次 `ldap/*` 调用，sidecar
 * 以 `connection "…" is not connected; call connection/connect first`
 * 拒绝（backend/internal/ldapconn/service.go errConnectionNotFound）。
 * 决策本身是纯函数，窗口常量与"识别为可重试"的判定保持单测可测；
 * 其它失败一律 fail，维持既有的一次性错误面（树错误/横幅），不吞错。
 */

export const BOOT_RESTORE_RETRY_MAX = 12;
export const BOOT_RESTORE_RETRY_DELAY_MS = 1000;

const CONNECTION_INACTIVE_PATTERN = /is not connected; call connection\/connect first/i;

export type ConnectionRetryDecision =
  | { kind: "retry"; attempt: number; delayMs: number }
  | { kind: "fail" };

/** The sidecar reported the connection registry has no live entry yet. */
export function isConnectionInactiveError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return CONNECTION_INACTIVE_PATTERN.test(message);
}

/**
 * Decides what the boot path should do after a failed readiness probe.
 * `attempt` is the number of retries already consumed (0 = first attempt).
 */
export function decideConnectionRetry(options: { cause: unknown; attempt: number }): ConnectionRetryDecision {
  if (!isConnectionInactiveError(options.cause)) return { kind: "fail" };
  if (options.attempt >= BOOT_RESTORE_RETRY_MAX) return { kind: "fail" };
  return { kind: "retry", attempt: options.attempt + 1, delayMs: BOOT_RESTORE_RETRY_DELAY_MS };
}
