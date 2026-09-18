import { ref } from "vue";
import { friendlyLdapError } from "./ldapErrors";

/**
 * 工作台即时反馈（横幅 + 通知）的组合式封装。搜索/条目编辑的专属错误态
 * （searchError/editorLoadError）由各自会话组合式持有，这里只管全局横幅、
 * 初始化错误与 3.5s 自动消退的通知。
 */
export function useWorkbenchFeedback() {
  const notice = ref("");
  const ldapError = ref("");
  const ldapErrorDetail = ref("");
  const initError = ref("");
  let noticeTimer = 0;

  function showNotice(message: string) {
    notice.value = message;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => (notice.value = ""), 3500);
  }

  // 横幅展示本地化的可行动文案；原始错误串挂在 title 悬停里供排查。
  function showError(cause: unknown, target: "ldap" | "init" = "ldap") {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (target === "init") {
      initError.value = message;
      return;
    }
    ldapError.value = friendlyLdapError(message);
    ldapErrorDetail.value = ldapError.value === message ? "" : message;
  }

  function dismissError() {
    ldapError.value = "";
  }

  function clearBanner() {
    ldapError.value = "";
  }

  function dispose() {
    window.clearTimeout(noticeTimer);
  }

  return { notice, ldapError, ldapErrorDetail, initError, showNotice, showError, dismissError, clearBanner, dispose };
}
