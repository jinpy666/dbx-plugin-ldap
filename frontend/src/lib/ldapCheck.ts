/**
 * ldap/check 结果 → 行内文案的纯函数层（ConnectionsPanel 与 RootDseDialog
 * 共用，从 ConnectionsPanel 抽出）：网络段优先、认证段次之、全通过给出网络
 * 耗时。契约外形状（mock / 旧 sidecar 未实现完整返回）统一按检查失败降级，
 * 不抛错——徽章/行内文案绝不能弄挂调用方。
 */
import type { LdapCheckResult } from "./api";
import { t } from "./i18n";

export interface LdapCheckMessage {
  message: string;
  /** true → 错误色（form-error），否则 muted。 */
  failed: boolean;
}

export function describeLdapCheckResult(result: LdapCheckResult): LdapCheckMessage {
  const network = result?.network;
  const bind = result?.bind;
  if (!network || !bind) {
    // 契约外形状（mock / 旧 sidecar 未实现完整返回）→ 统一按检查失败降级，不抛错。
    return { message: t("connections.checkFail", { error: "unexpected ldap/check response" }), failed: true };
  }
  if (!network.ok) {
    return { message: t("connections.checkNetworkFail", { error: network.error ?? "" }), failed: true };
  }
  // bind 段失败/未通过（skipped 之外带 error 也视为未通过）。
  const bindFailed = !bind.ok || (!!bind.error && !bind.skipped);
  if (bindFailed) {
    return { message: t("connections.checkBindFail", { error: bind.error ?? "" }), failed: true };
  }
  return { message: t("connections.checkOk", { networkMs: network.latencyMs ?? 0 }), failed: false };
}
