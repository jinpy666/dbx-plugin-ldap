// @vitest-environment happy-dom
// 弹窗键盘决策纯函数（Esc close + Tab 焦点陷阱）：与 kafka 同语义的家族
// 统一测试；focusableElements 用真实 DOM 断言选择器覆盖面。遮罩点击守卫
// （decideBackdropClose）与 Esc 共用 allowClose，防止 dirty 丢改动（P1-1）。
// 堆叠弹窗容器解析（J-2/L-5）：useModalA11y 以真实挂载组件验证——上层弹窗
// 打开后陷阱枚举上层容器，不再取文档首个 backdrop。Esc 独占栈顶（L-5）：
// 堆叠时一次 Esc 只关最上层，栈顶关闭/失活出栈后次层接棒。
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { decideBackdropClose, decideModalKeydown, focusableElements, nextFocusIndex, useModalA11y } from "./modal";

describe("modal keydown decision (Esc close + Tab focus trap)", () => {
  it("closes on Escape regardless of Tab state", () => {
    expect(decideModalKeydown("Escape", false, 0, -1)).toEqual({ kind: "close" });
    expect(decideModalKeydown("Escape", true, 5, 2)).toEqual({ kind: "close" });
  });

  it("ignores non-Esc/Tab keys and empty containers", () => {
    expect(decideModalKeydown("Enter", false, 5, 0)).toEqual({ kind: "none" });
    expect(decideModalKeydown("Tab", false, 0, -1)).toEqual({ kind: "none" });
    expect(decideModalKeydown("Tab", true, 0, 3)).toEqual({ kind: "none" });
  });

  it("cycles forward with wrap-around", () => {
    expect(decideModalKeydown("Tab", false, 3, 0)).toEqual({ kind: "focus", index: 1 });
    expect(decideModalKeydown("Tab", false, 3, 2)).toEqual({ kind: "focus", index: 0 });
  });

  it("cycles backward with wrap-around", () => {
    expect(decideModalKeydown("Tab", true, 3, 2)).toEqual({ kind: "focus", index: 1 });
    expect(decideModalKeydown("Tab", true, 3, 0)).toEqual({ kind: "focus", index: 2 });
  });

  it("enters at the start/end when focus is outside the container", () => {
    // 焦点尚未进容器（如打开瞬间）：Tab 进首个控件，Shift+Tab 进最后一个。
    expect(decideModalKeydown("Tab", false, 4, -1)).toEqual({ kind: "focus", index: 0 });
    expect(decideModalKeydown("Tab", true, 4, -1)).toEqual({ kind: "focus", index: 3 });
  });
});

describe("decideBackdropClose (P1-1 backdrop dirty guard)", () => {
  it("closes when the shared allowClose guard passes", () => {
    expect(decideBackdropClose(true)).toEqual({ kind: "close" });
  });

  it("vetoes when the guard fails, matching the Esc path", () => {
    // dirty/提交在途：遮罩点击与 Esc 同被否决——关闭途径语义一致，输入不丢。
    expect(decideBackdropClose(false)).toEqual({ kind: "veto" });
  });
});

describe("nextFocusIndex", () => {
  it("returns -1 for an empty container", () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
    expect(nextFocusIndex(0, 2, true)).toBe(-1);
  });
});

describe("focusableElements", () => {
  it("collects interactive controls in DOM order and skips disabled/hidden", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      '<button id="a">a</button>',
      '<button id="b" disabled>b</button>',
      '<input id="c" type="hidden" />',
      '<input id="d" />',
      '<select id="e"><option>1</option></select>',
      '<textarea id="f"></textarea>',
      '<a id="g" href="#g">g</a>',
      '<a id="h">h</a>',
      '<span id="i" tabindex="-1">i</span>',
      '<span id="j" tabindex="0">j</span>',
    ].join("");
    document.body.appendChild(root);
    try {
      expect(focusableElements(root).map((element) => element.id)).toEqual(["a", "d", "e", "f", "g", "j"]);
    } finally {
      root.remove();
    }
  });
});

describe("useModalA11y container resolution (stacked dialogs, J-2/L-5)", () => {
  // 测试宿主：两个 backdrop 同时在场（内层嵌在外层 backdrop 内，与导入
  // 弹窗内嵌 DN 选择器同构），各自接线一个 useModalA11y 实例。
  const StackedHost = defineComponent({
    props: { outer: { type: Boolean, default: false }, inner: { type: Boolean, default: false } },
    emits: ["closeOuter", "closeInner"],
    setup(props, { emit }) {
      useModalA11y(() => props.outer, { close: () => emit("closeOuter") });
      useModalA11y(() => props.inner, { close: () => emit("closeInner") });
      return () => [
        props.outer
          ? h("div", { class: "modal-backdrop" }, [
              h("div", { class: "modal" }, [h("button", { "data-test": "outer-close" }, "outer")]),
            ])
          : null,
        props.inner
          ? h("div", { class: "modal-backdrop" }, [
              h("div", { class: "modal" }, [
                h("button", { "data-test": "inner-a" }, "a"),
                h("button", { "data-test": "inner-b" }, "b"),
              ]),
            ])
          : null,
      ];
    },
  });

  const pressTab = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

  // happy-dom 中焦点只在元素真实挂到 document 后生效（同 DeleteEntryDialog.spec）：
  // attachTo body + 额外宏任务等待 nextTick 聚焦回调。
  const flushFocus = async (host: { vm: { $nextTick: () => Promise<void> } }) => {
    await host.vm.$nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("focuses and wraps inside the topmost container after the inner dialog opens", async () => {
    const wrapper = mount(StackedHost, { attachTo: document.body, props: { outer: true } });
    try {
      await flushFocus(wrapper);
      // 单层场景行为不变：初始聚焦进唯一弹层的首个控件。
      expect(document.activeElement).toBe(wrapper.find("[data-test='outer-close']").element);
      // 打开上层弹窗：初始聚焦进上层容器（修复前会错绑文档首个 backdrop）。
      await wrapper.setProps({ inner: true });
      await flushFocus(wrapper);
      expect(document.activeElement).toBe(wrapper.find("[data-test='inner-a']").element);
      // Tab 陷阱在上层容器内回绕，焦点不被拽回底层（修复前 Tab 会落到外层控件）。
      pressTab();
      await wrapper.vm.$nextTick();
      const innerModal = wrapper.findAll(".modal")[1].element;
      expect(innerModal.contains(document.activeElement)).toBe(true);
      expect(["inner-a", "inner-b"]).toContain(document.activeElement!.getAttribute("data-test"));
      // Shift+Tab 同样留在上层容器。
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
      await wrapper.vm.$nextTick();
      expect(innerModal.contains(document.activeElement)).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });

  it("falls back to the last-open backdrop when focus is programmatically on body", async () => {
    // 程序化打开：焦点在 body（不在任何弹层）→ 回退取 DOM 序最后一个 backdrop。
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement).toBe(document.body);
    const wrapper = mount(StackedHost, { attachTo: document.body, props: { outer: true, inner: true } });
    try {
      await flushFocus(wrapper);
      const lastBackdrop = wrapper.findAll(".modal-backdrop")[1].element;
      expect(lastBackdrop.contains(document.activeElement)).toBe(true);
    } finally {
      wrapper.unmount();
    }
  });
});

describe("useModalA11y Esc exclusivity (instance stack, L-5)", () => {
  // 独立单实例宿主：各自 mount/unmount，驱动实例栈的入栈（open→true 激活）、
  // 出栈（open→false 失活 / 组件卸载兜底）。Esc 分支不依赖 DOM/焦点，
  // 无需等待聚焦宏任务，dispatch 同步生效。
  const SoloDialog = defineComponent({
    props: { open: { type: Boolean, default: false } },
    emits: ["close"],
    setup(props, { emit }) {
      useModalA11y(() => props.open, { close: () => emit("close") });
      return () =>
        props.open
          ? h("div", { class: "modal-backdrop" }, [h("div", { class: "modal" }, [h("button", {}, "x")])])
          : null;
    },
  });

  const pressEsc = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

  it("closes only the topmost dialog while two are stacked", () => {
    const outer = mount(SoloDialog, { attachTo: document.body, props: { open: true } });
    const inner = mount(SoloDialog, { attachTo: document.body, props: { open: true } });
    try {
      pressEsc();
      // 后激活者在栈顶：Esc 只关内层，外层监听同帧收到事件但非栈顶被放行。
      expect(inner.emitted("close")).toHaveLength(1);
      expect(outer.emitted("close")).toBeUndefined();
    } finally {
      outer.unmount();
      inner.unmount();
    }
  });

  it("closes the next dialog on the following Esc after the top one closed", async () => {
    const outer = mount(SoloDialog, { attachTo: document.body, props: { open: true } });
    const inner = mount(SoloDialog, { attachTo: document.body, props: { open: true } });
    try {
      pressEsc();
      expect(inner.emitted("close")).toHaveLength(1);
      // 内层响应 close 置 open=false：失活出栈，外层接棒成为新栈顶。
      await inner.setProps({ open: false });
      pressEsc();
      expect(outer.emitted("close")).toHaveLength(1);
    } finally {
      outer.unmount();
      inner.unmount();
    }
  });

  it("keeps stack order intact when a middle instance unmounts without closing", async () => {
    const first = mount(SoloDialog, { attachTo: document.body, props: { open: true } });
    const second = mount(SoloDialog, { attachTo: document.body, props: { open: true } });
    const third = mount(SoloDialog, { attachTo: document.body, props: { open: true } });
    try {
      // 中间实例未先置 open=false 就被整体卸载：onBeforeUnmount 兜底出栈，
      // 不泄漏栈条目，也不破坏其余实例的先后关系。
      second.unmount();
      pressEsc();
      expect(third.emitted("close")).toHaveLength(1);
      expect(first.emitted("close")).toBeUndefined();
      // 栈顶也失活后，首个实例接棒——indexOf/splice 出栈保序。
      await third.setProps({ open: false });
      pressEsc();
      expect(first.emitted("close")).toHaveLength(1);
    } finally {
      first.unmount();
      third.unmount();
    }
  });
});
