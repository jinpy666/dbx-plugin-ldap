import { describe, expect, it } from "vitest";
import {
  TREE_AUTO_RETRY_DELAYS_MS,
  TREE_AUTO_RETRY_MAX,
  decideTreeAutoRetry,
  isTransientTreeError,
} from "./treeAutoRetry";

describe("isTransientTreeError", () => {
  it("机器可读 [ldap-code=200] 前缀命中瞬时网络类", () => {
    expect(isTransientTreeError("[ldap-code=200] dial tcp 10.0.0.1:389: connect: connection refused")).toBe(true);
  });

  it("无前缀网络类文本（refused/reset/lost/closed/no such host/broken pipe/i-o timeout/EOF）命中", () => {
    for (const raw of [
      "connect: connection refused",
      "read: connection reset by peer",
      "ldap: connection lost",
      "ldap: connection closed",
      "lookup ldap.local: no such host",
      "write: broken pipe",
      "read tcp 10.0.0.2:54321->10.0.0.1:389: i/o timeout",
      "ldap: connection closed unexpectedly (EOF)",
    ]) {
      expect(isTransientTreeError(raw), raw).toBe(true);
    }
  });

  it("超时类（timeout/timed out/deadline exceeded）同样可重试", () => {
    expect(isTransientTreeError("request timeout")).toBe(true);
    expect(isTransientTreeError("context deadline exceeded")).toBe(true);
  });

  it("确定性失败不重试：凭据/DN/条目/referral/空密码与空串", () => {
    for (const raw of [
      "[ldap-code=49] invalid credentials",
      "[ldap-code=34] invalid dn syntax",
      "[ldap-code=32] no such object",
      "[ldap-code=10] referral",
      "[ldap-code=206] empty password not allowed",
      "[ldap-code=200] x509: certificate signed by unknown authority",
      'search: LDAP Result Code 200 "Network Error": tls: handshake failure',
      'connection "c1" is not connected; call connection/connect first',
      "",
    ]) {
      expect(isTransientTreeError(raw), raw).toBe(false);
    }
  });
});

describe("decideTreeAutoRetry", () => {
  it("退避梯：第 1/2/3 次重试分别延时 5s/10s/20s", () => {
    expect(decideTreeAutoRetry({ attempt: 0, raw: "connection refused" })).toEqual({
      kind: "retry",
      attempt: 1,
      delayMs: TREE_AUTO_RETRY_DELAYS_MS[0],
    });
    expect(decideTreeAutoRetry({ attempt: 1, raw: "connection refused" })).toEqual({
      kind: "retry",
      attempt: 2,
      delayMs: TREE_AUTO_RETRY_DELAYS_MS[1],
    });
    expect(decideTreeAutoRetry({ attempt: 2, raw: "connection refused" })).toEqual({
      kind: "retry",
      attempt: 3,
      delayMs: TREE_AUTO_RETRY_DELAYS_MS[2],
    });
    expect(TREE_AUTO_RETRY_DELAYS_MS).toHaveLength(TREE_AUTO_RETRY_MAX);
  });

  it("第 3 次重试仍瞬时失败 → 放弃（fail）", () => {
    expect(decideTreeAutoRetry({ attempt: TREE_AUTO_RETRY_MAX, raw: "connection refused" })).toEqual({ kind: "fail" });
  });

  it("确定性失败即时放弃（即便重试名额未用完）", () => {
    expect(decideTreeAutoRetry({ attempt: 0, raw: "[ldap-code=49] invalid credentials" })).toEqual({ kind: "fail" });
  });
});
