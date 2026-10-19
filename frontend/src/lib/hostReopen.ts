/**
 * Ask DBX to reopen the LDAP connection with its current configuration
 * (vault-fresh credentials replayed to the sidecar). Mirrors the ssh plugin's
 * lib/hostReopen: the host acknowledge itself can hang on a dead transport,
 * so the wait is bounded in this page and the outcome is a plain boolean —
 * callers decide whether to keep retrying (boot window) or surface the tree
 * error state.
 */
export async function reopenHostConnection(
  api: {
    reopenConnection?: (connectionId: string) => Promise<unknown>;
    request: (method: string, params?: unknown) => Promise<unknown>;
  },
  connectionId: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Host API 1.2+ 走专用桥；旧宿主回退 host.reopenConnection 请求（行为
    // 退化为纯重试）。两路都必须有界：断链时请求可能永不落定。
    const reopen = api.reopenConnection
      ? api.reopenConnection(connectionId)
      : api.request("host.reopenConnection", { connectionId });
    const result = await Promise.race([
      reopen,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Host connection reopen timed out")), timeoutMs);
      }),
    ]);
    return result !== false && !(typeof result === "object" && result !== null && "success" in result && result.success === false);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
