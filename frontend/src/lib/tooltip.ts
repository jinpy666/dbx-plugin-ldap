// 全局悬浮提示层：接管"纯图标控件"的 hover 文字提示（App.vue 挂载一次）。
// 为什么不用原生 title：Chromium 对 disabled 表单控件不显示 title 提示——
// 工具栏图标未连接时全部禁用，恰是高频悬停场景；且原生提示延迟约 1s、
// 无法样式化。实测禁用按钮仍派发 mouseover（只有 click 被吞），事件委托
// 对禁用态同样生效；气泡 fixed 定位挂在 body，不受滚动容器裁剪。
// 接管范围保持克制：显式 data-tip，或"没有可见文字"的 button/[role=button]。
// 树行 DN、结果单元格等长文本场景继续用原生 title（浏览器负责截断与跟手）。

export const TOOLTIP_VISIBLE_CLASS = "is-visible";

let installed = false;
let bubble: HTMLDivElement | null = null;
let currentHost: Element | null = null;
// 悬浮期间把 host 及其祖先链上的 title 暂存并移除，避免原生提示与气泡
// 叠加（图标按钮常嵌在带 DN title 的树行/行容器里），隐藏时原样归还。
let stashed: Array<{ el: HTMLElement; title: string }> = [];
let hideTimer = 0;

function isIconOnly(el: Element): boolean {
  return (el.textContent ?? "").trim() === "";
}

function findHost(from: Element): Element | null {
  for (let el: Element | null = from; el; el = el.parentElement) {
    if (el.hasAttribute("data-tip")) return el;
    if (el.hasAttribute("title") && (el.tagName === "BUTTON" || el.getAttribute("role") === "button") && isIconOnly(el)) {
      return el;
    }
  }
  return null;
}

function ensureBubble(): HTMLDivElement {
  if (!bubble || !bubble.isConnected) {
    bubble = document.createElement("div");
    bubble.className = "app-tooltip";
    bubble.setAttribute("role", "tooltip");
    document.body.appendChild(bubble);
  }
  return bubble;
}

function restoreStashedTitles() {
  for (const { el, title } of stashed) el.setAttribute("title", title);
  stashed = [];
}

function hideBubble() {
  window.clearTimeout(hideTimer);
  if (bubble) bubble.classList.remove(TOOLTIP_VISIBLE_CLASS);
  restoreStashedTitles();
  currentHost = null;
}

function scheduleHide() {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideBubble, 60);
}

function showBubble(target: Element) {
  if (currentHost === target && bubble?.classList.contains(TOOLTIP_VISIBLE_CLASS)) return;
  restoreStashedTitles();
  const explicit = target.getAttribute("data-tip");
  const text = (explicit ?? target.getAttribute("title") ?? "").trim();
  if (text === "") {
    hideBubble();
    return;
  }
  if (explicit === null) {
    for (let el: Element | null = target; el; el = el.parentElement) {
      if (!(el instanceof HTMLElement)) continue;
      const title = el.getAttribute("title");
      if (title !== null) {
        stashed.push({ el, title });
        el.removeAttribute("title");
      }
    }
  }
  currentHost = target;
  const el = ensureBubble();
  el.textContent = text;
  el.classList.add(TOOLTIP_VISIBLE_CLASS);
  // 同步测量并定位（期间不会产生中间绘制）。
  const rect = target.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const margin = 8;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - margin) top = rect.top - height - 6;
  if (top < margin) top = Math.max(margin, Math.min(rect.bottom + 6, window.innerHeight - height - margin));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function onMouseOver(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const host = findHost(target);
  if (!host) return;
  window.clearTimeout(hideTimer);
  showBubble(host);
}

function onMouseOut(event: MouseEvent) {
  if (!currentHost) return;
  const target = event.target;
  const related = event.relatedTarget;
  if (
    target instanceof Element &&
    currentHost.contains(target) &&
    !(related instanceof Node && currentHost.contains(related))
  ) {
    scheduleHide();
  }
}

export function setupTooltipLayer(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("mouseover", onMouseOver);
  document.addEventListener("mouseout", onMouseOut);
  // 点击与滚动即收起：气泡不跟随宿主，滚动后位置会失真。
  document.addEventListener("mousedown", hideBubble, true);
  document.addEventListener("scroll", hideBubble, true);
}

export function teardownTooltipLayer(): void {
  if (!installed) return;
  installed = false;
  document.removeEventListener("mouseover", onMouseOver);
  document.removeEventListener("mouseout", onMouseOut);
  document.removeEventListener("mousedown", hideBubble, true);
  document.removeEventListener("scroll", hideBubble, true);
  hideBubble();
  bubble?.remove();
  bubble = null;
}
