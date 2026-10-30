/**
 * 树根失败自动重试（有界退避）的纯决策。
 *
 * 背景：LDAP 服务器/链路的瞬时抖动会让树根首次加载失败，横幅上的「重试」
 * 是一次性手动出口——点的时候网络往往还没恢复，再失败一次就只能重开页签
 * （2026-10 现场复现）。本模块把「要不要重试、隔多久、还剩几次」收敛成
 * 单测可测的纯函数；重试动作本身沿用既有 retry-connection 事件（宿主重开
 * 连接 + 重载树根），不在树内另起重连路径。
 *
 * 口径：瞬时性判定复用 ldapErrors 的友好文案分类——只有会被显示为
 * 「无法连接/超时」的失败才自动重试，凭据/referral/TLS 等确定性失败保持
 * 一次性错误态不吞错。
 */
import { isTransientLdapError } from "./ldapErrors";

/** 自动重试次数上限（不含首次失败）。 */
export const TREE_AUTO_RETRY_MAX = 3;

/** 各次重试前的退避延时（毫秒），长度必须等于 TREE_AUTO_RETRY_MAX。 */
export const TREE_AUTO_RETRY_DELAYS_MS: ReadonlyArray<number> = [5_000, 10_000, 20_000];

export type TreeAutoRetryDecision =
  | { kind: "retry"; attempt: number; delayMs: number }
  | { kind: "fail" };

/** 同 ldapErrors 的瞬时性口径（供树组件语义化调用）。 */
export const isTransientTreeError = (raw: string): boolean => isTransientLdapError(raw);

/**
 * 决定一次树根瞬时失败后的动作。`attempt` 是已消耗的自动重试次数
 * （0 = 首次失败，尚未自动重试过）。
 */
export function decideTreeAutoRetry(options: { attempt: number; raw: string }): TreeAutoRetryDecision {
  if (!isTransientLdapError(options.raw)) return { kind: "fail" };
  if (options.attempt >= TREE_AUTO_RETRY_MAX) return { kind: "fail" };
  return {
    kind: "retry",
    attempt: options.attempt + 1,
    delayMs: TREE_AUTO_RETRY_DELAYS_MS[options.attempt],
  };
}
