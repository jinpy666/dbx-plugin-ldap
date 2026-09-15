// @vitest-environment happy-dom
// tooltip 层单元测试：纯图标按钮（含禁用态）hover 出气泡、title 暂存/归还、
// 带文字按钮与普通 title 元素不被接管。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTooltipLayer, teardownTooltipLayer, TOOLTIP_VISIBLE_CLASS } from "./tooltip";

function hover(el: Element, related?: Element) {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: related ?? null }));
}

function unhover(el: Element, related?: Element) {
  el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: related ?? null }));
}

function bubble(): HTMLDivElement | null {
  return document.querySelector<HTMLDivElement>(".app-tooltip");
}

// 负例里气泡可能尚未创建（从未 show 过），统一折算成 false。
function bubbleVisible(): boolean {
  return bubble()?.classList.contains(TOOLTIP_VISIBLE_CLASS) ?? false;
}

async function settleHide() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

beforeEach(() => {
  document.body.innerHTML = `
    <button id="icon" title="刷新目录树" aria-label="刷新目录树"><svg><path /></svg></button>
    <button id="icon-disabled" title="导出 LDIF" disabled><svg><path /></svg></button>
    <button id="with-text" title="带文字提示">搜索</button>
    <span id="explicit" data-tip="显式提示">x</span>
    <span id="plain" title="uid=user1,ou=people">uid=user1</span>
    <div id="row" title="uid=user1,ou=people,dc=demo"><button id="nested-icon" title="收起"><svg><path /></svg></button></div>
  `;
  setupTooltipLayer();
});

afterEach(() => teardownTooltipLayer());

describe("app tooltip layer", () => {
  it("hover on icon-only button shows bubble and stashes the native title", () => {
    hover(document.getElementById("icon")!);
    expect(bubble()?.classList.contains(TOOLTIP_VISIBLE_CLASS)).toBe(true);
    expect(bubble()?.textContent).toBe("刷新目录树");
    expect(document.getElementById("icon")!.hasAttribute("title")).toBe(false);
  });

  it("disabled icon-only button still shows bubble (native title does not)", () => {
    hover(document.getElementById("icon-disabled")!.querySelector("svg")!);
    expect(bubble()?.classList.contains(TOOLTIP_VISIBLE_CLASS)).toBe(true);
    expect(bubble()?.textContent).toBe("导出 LDIF");
  });

  it("hover on the svg child delegates to the owning button", () => {
    hover(document.getElementById("icon")!.querySelector("svg")!);
    expect(bubble()?.textContent).toBe("刷新目录树");
  });

  it("mouseout hides the bubble and restores stashed titles", async () => {
    const btn = document.getElementById("icon")!;
    hover(btn);
    unhover(btn);
    await settleHide();
    expect(bubbleVisible()).toBe(false);
    expect(btn.getAttribute("title")).toBe("刷新目录树");
  });

  it("moving inside the host does not hide the bubble", async () => {
    const btn = document.getElementById("icon")!;
    const svg = btn.querySelector("svg")!;
    hover(btn);
    unhover(btn, svg);
    await settleHide();
    expect(bubble()?.classList.contains(TOOLTIP_VISIBLE_CLASS)).toBe(true);
  });

  it("button with visible text keeps its native title (no bubble)", () => {
    const btn = document.getElementById("with-text")!;
    hover(btn);
    expect(bubbleVisible()).toBe(false);
    expect(btn.getAttribute("title")).toBe("带文字提示");
  });

  it("plain titled elements are not taken over", () => {
    const span = document.getElementById("plain")!;
    hover(span);
    expect(bubbleVisible()).toBe(false);
    expect(span.getAttribute("title")).toBe("uid=user1,ou=people");
  });

  it("data-tip opts in explicitly without touching title", () => {
    const span = document.getElementById("explicit")!;
    span.setAttribute("title", "不该被动");
    hover(span);
    expect(bubble()?.textContent).toBe("显式提示");
    expect(span.getAttribute("title")).toBe("不该被动");
  });

  it("icon button inside a titled row: button title wins, row title suppressed then restored", async () => {
    const btn = document.getElementById("nested-icon")!;
    const row = document.getElementById("row")!;
    hover(btn);
    expect(bubble()?.textContent).toBe("收起");
    expect(row.hasAttribute("title")).toBe(false);
    unhover(btn);
    await settleHide();
    expect(row.getAttribute("title")).toBe("uid=user1,ou=people,dc=demo");
    expect(btn.getAttribute("title")).toBe("收起");
  });

  it("switching hosts swaps the bubble content", () => {
    hover(document.getElementById("icon")!);
    hover(document.getElementById("icon-disabled")!);
    expect(bubble()?.textContent).toBe("导出 LDIF");
    expect(document.getElementById("icon")!.getAttribute("title")).toBe("刷新目录树");
  });

  it("mousedown hides the bubble immediately", () => {
    hover(document.getElementById("icon")!);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(bubbleVisible()).toBe(false);
  });
});
