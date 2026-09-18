// 弹窗键盘可访问性（P-LDAP）：Esc 关闭 + Tab 焦点陷阱 + 打开初始聚焦 /
// 关闭焦点归还。决策纯函数与 kafka（kafkaModel.decideModalKeydown）同语义，
// 家族内交互统一；各弹窗组件经 useModalA11y 一行接线。
import { computed, nextTick, onBeforeUnmount, watch, type Ref } from "vue";

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function focusableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** Tab 焦点陷阱回绕：无焦点/越界时按方向取首/尾，否则循环步进；空容器返回 -1。 */
export function nextFocusIndex(count: number, currentIndex: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= count) return shift ? count - 1 : 0;
  return (currentIndex + (shift ? -1 : 1) + count) % count;
}

/** 弹层 keydown 决策：Esc → close；Tab → focus 回绕目标下标；其余 → none。 */
export type ModalKeydownDecision = { kind: "none" } | { kind: "close" } | { kind: "focus"; index: number };

export function decideModalKeydown(
  key: string,
  shiftKey: boolean,
  focusableCount: number,
  currentIndex: number,
): ModalKeydownDecision {
  if (key === "Escape") return { kind: "close" };
  if (key !== "Tab" || focusableCount <= 0) return { kind: "none" };
  return { kind: "focus", index: nextFocusIndex(focusableCount, currentIndex, shiftKey) };
}

/** 遮罩点击关闭决策：与 Esc（decideModalKeydown → allowClose）同一条守卫语义。
 *  否决（未保存修改/提交在途）时保持打开、输入不丢——此前遮罩 @click.self
 *  直接 close 绕过 allowClose，是编辑器 dirty 丢改动的根因（UI 扫描 P1-1）。 */
export type BackdropCloseDecision = { kind: "close" } | { kind: "veto" };

export function decideBackdropClose(allowClose: boolean): BackdropCloseDecision {
  return allowClose ? { kind: "close" } : { kind: "veto" };
}

export interface ModalA11yOptions {
  close: () => void;
  /** 返回 false 否决 Esc 关闭（如编辑器有未保存修改）；Tab 陷阱不受影响。 */
  allowClose?: () => boolean;
  /** 打开时初始聚焦目标（弹层内 CSS 选择器，如删除确认框聚焦"取消"而非
   *  标题栏 ✕，UI 扫描 P2-11）；缺失或不可达时回退首个可交互控件。 */
  initialFocus?: string;
  /** 自定义焦点陷阱容器；复合弹窗可将左右面板作为一个会话处理。 */
  containerSelector?: string;
}

/** 模块级弹窗实例栈：后激活者在栈顶。Esc 只由栈顶实例消费——堆叠两层时
 *  两份 window keydown 监听同帧都会收到同一事件，stopPropagation 挡不住
 *  同 target 上的其余监听器（审计 L-5：导入弹窗内嵌 DN 选择器双层同关），
 *  必须按栈位裁决，而非依赖事件拦截。 */
const modalStack: symbol[] = [];

/**
 * 弹窗打开期间挂 window keydown（Esc/Tab），打开时焦点进首个可交互控件、
 * 关闭时归还触发元素。容器按"焦点所在层"解析：单层弹窗行为不变，双层模态
 * （导入弹窗内嵌 DN 选择器、编辑器内嵌 objectClass 选择器）时各层陷阱枚举
 * 自己那一层，不再固定取文档首个 `.modal-backdrop .modal`（审计 J-2/L-5）。
 * Esc 独占栈顶：堆叠时一次 Esc 只关最上层，栈顶关闭后次层接棒（L-5）。
 * 组件卸载自动出栈并摘除监听。
 */
export function useModalA11y(open: Ref<boolean> | (() => boolean), options: ModalA11yOptions): void {
  const isOpen = computed(() => (typeof open === "function" ? open() : open.value));
  let trigger: HTMLElement | null = null;
  let listening = false;
  /** 本实例在实例栈中的令牌：激活后非空，失活即清空；keydown 以此比对栈顶。 */
  let stackToken: symbol | null = null;

  /** DOM 序最后一个弹层容器：堆叠时后渲染者在视觉最上层（后者在上）。 */
  function lastModalContainer(): HTMLElement | null {
    const all = document.querySelectorAll<HTMLElement>(".modal-backdrop .modal");
    return all.length > 0 ? all[all.length - 1] : null;
  }

  function modalContainer(): HTMLElement | null {
    // 复合弹窗显式指定容器：语义不变，优先级最高。
    if (options.containerSelector) {
      return document.querySelector<HTMLElement>(options.containerSelector);
    }
    // 焦点所在层优先：上层弹窗获得焦点后，本实例（含底层弹窗的遗留监听）
    // 的 Tab 陷阱都枚举焦点所在层，焦点不会被拽回底层容器。
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const owner = active.closest<HTMLElement>(".modal-backdrop .modal");
      if (owner) return owner;
    }
    // 焦点不在任何弹层（程序化打开/打开瞬间）：取最后打开的 backdrop。
    return lastModalContainer();
  }

  /** 激活：入实例栈 + 挂 keydown；listening 兜底防止 open 重复置真时重复入栈。 */
  function activate(): void {
    if (listening) return;
    stackToken = Symbol("modal-a11y");
    modalStack.push(stackToken);
    window.addEventListener("keydown", onKeydown);
    listening = true;
  }

  /** 失活：焦点归还放 try，出栈与摘监听放 finally——即使归还焦点抛出，
   *  栈条目与 window 监听也必然被清理，实例不会泄漏在栈里。 */
  function deactivate(): void {
    const token = stackToken;
    stackToken = null;
    try {
      trigger?.focus({ preventScroll: true });
    } finally {
      if (token) {
        const index = modalStack.indexOf(token);
        if (index !== -1) modalStack.splice(index, 1);
      }
      if (listening) window.removeEventListener("keydown", onKeydown);
      listening = false;
      trigger = null;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" && event.key !== "Tab") return;
    // Esc 独占栈顶：非栈顶实例直接放行（不 close、不 preventDefault）。
    // Tab 不做栈位限制，维持按焦点所在层解析容器的语义（R3 不回退）。
    if (event.key === "Escape" && modalStack[modalStack.length - 1] !== stackToken) return;
    const root = modalContainer();
    if (!root && event.key !== "Escape") return;
    const focusables = root ? focusableElements(root) : [];
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const decision = decideModalKeydown(event.key, event.shiftKey, focusables.length, currentIndex);
    if (decision.kind === "close") {
      if (options.allowClose && !options.allowClose()) return;
      event.preventDefault();
      event.stopPropagation();
      options.close();
    } else if (decision.kind === "focus") {
      event.preventDefault();
      event.stopPropagation();
      focusables[decision.index]?.focus({ preventScroll: true });
    }
  }

  // immediate：以 open=true 直接挂载（父组件先置 open 再挂载/测试直挂）时
  // 也要接上监听并聚焦，否则该弹窗的 Esc/Tab 陷阱整场失效。
  watch(
    isOpen,
    (value) => {
      if (value) {
        trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        activate();
        void nextTick(() => {
          // 初始聚焦固定取最后打开的弹层：此刻本层 DOM 刚挂载且排最后，焦点
          // 还在触发元素（父层控件）上，走焦点解析会错绑到父层容器。
          const root = options.containerSelector
            ? document.querySelector<HTMLElement>(options.containerSelector)
            : lastModalContainer();
          if (!root) return;
          // 本层已自行放置焦点（如 objectClass 选择器的搜索框自聚焦）时不抢。
          if (root.contains(document.activeElement)) return;
          const initial = options.initialFocus ? root.querySelector<HTMLElement>(options.initialFocus) : null;
          if (initial && !initial.matches(":disabled")) initial.focus({ preventScroll: true });
          else focusableElements(root)[0]?.focus({ preventScroll: true });
        });
      } else if (listening) {
        deactivate();
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    // 卸载兜底：open 仍为 true 时组件被整体卸载（父级 v-if 移除）也要出栈
    // 并摘监听，保证实例栈不泄漏。
    if (listening) deactivate();
  });
}
