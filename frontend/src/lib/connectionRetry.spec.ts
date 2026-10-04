import { describe, expect, it } from "vitest";
import {
  BOOT_RESTORE_RETRY_DELAY_MS,
  BOOT_RESTORE_RETRY_MAX,
  decideConnectionRetry,
  isConnectionInactiveError,
} from "./connectionRetry";

const inactiveCause = new Error('connection "abc" is not connected; call connection/connect first');

describe("connectionRetry boot-restore window", () => {
  it("recognizes the sidecar not-connected error as the retryable transient", () => {
    expect(isConnectionInactiveError(inactiveCause)).toBe(true);
    expect(isConnectionInactiveError('connection "x" is not connected; call connection/connect first')).toBe(true);
    // 真实 LDAP 业务错误（认证拒绝等）不属于该暂时态。
    expect(isConnectionInactiveError(new Error('LDAP Result Code 49 "Invalid Credentials"'))).toBe(false);
    expect(isConnectionInactiveError(undefined)).toBe(false);
    expect(isConnectionInactiveError(null)).toBe(false);
  });

  it("retries inactive errors inside the bounded window at a fixed cadence", () => {
    expect(decideConnectionRetry({ cause: inactiveCause, attempt: 0 })).toEqual({
      kind: "retry",
      attempt: 1,
      delayMs: BOOT_RESTORE_RETRY_DELAY_MS,
    });
    expect(decideConnectionRetry({ cause: inactiveCause, attempt: BOOT_RESTORE_RETRY_MAX - 1 })).toEqual({
      kind: "retry",
      attempt: BOOT_RESTORE_RETRY_MAX,
      delayMs: BOOT_RESTORE_RETRY_DELAY_MS,
    });
  });

  it("fails once the window is exhausted", () => {
    expect(decideConnectionRetry({ cause: inactiveCause, attempt: BOOT_RESTORE_RETRY_MAX })).toEqual({ kind: "fail" });
    expect(decideConnectionRetry({ cause: inactiveCause, attempt: BOOT_RESTORE_RETRY_MAX + 5 })).toEqual({ kind: "fail" });
  });

  it("never retries non-inactive errors — they keep the existing single-shot error surfaces", () => {
    expect(decideConnectionRetry({ cause: new Error("LDAP Result Code 49 \"Invalid Credentials\""), attempt: 0 })).toEqual({ kind: "fail" });
    expect(decideConnectionRetry({ cause: new Error("network error"), attempt: 0 })).toEqual({ kind: "fail" });
  });
});
