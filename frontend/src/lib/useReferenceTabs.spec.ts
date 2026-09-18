// @vitest-environment happy-dom
// useReferenceTabs 页签上限（审计 K-4 同类）测试：锁定"打开第 11 个引用时
// 淘汰最旧的非活跃页签、活跃页签永不被逐、重开命中既有页签不淘汰"，并覆盖
// 正常开关与被淘汰页签在途结果的序号守卫。经宿主组件挂载以获得 Vue 实例
// 上下文（useModalA11y 内部依赖 onBeforeUnmount）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { ldapApi } from "./api";
import { REFERENCE_TAB_LIMIT, useReferenceTabs } from "./useReferenceTabs";

vi.mock("./api", () => ({
  ldapApi: { entryGet: vi.fn() },
}));

const entryGet = vi.mocked(ldapApi.entryGet);
type TabsSession = ReturnType<typeof useReferenceTabs>;

function createHarness() {
  const onSnapshot = vi.fn();
  const onRecent = vi.fn();
  const holder: { session?: TabsSession } = {};
  const wrapper = mount(
    defineComponent({
      setup() {
        holder.session = useReferenceTabs({
          dialogToken: { value: 0 },
          onSnapshot,
          onRecent,
          ensureDnAttributes: () => {},
        });
        return () => h("div");
      },
    }),
  );
  return { wrapper, session: holder.session!, onSnapshot, onRecent };
}

/** 顺序打开 n 个引用；每轮 flush 推进已 resolve 的加载。
 *  不逐个 await openReferencedEntry：在途场景下某页签的 entryGet 被刻意挂起，
 *  await 会让 openN 死等而超时。 */
async function openN(session: TabsSession, count: number, prefix = "e") {
  for (let index = 0; index < count; index++) {
    void session.openReferencedEntry(`cn=${prefix}${index},dc=demo`);
    await flushPromises();
  }
}

beforeEach(() => {
  entryGet.mockReset();
  entryGet.mockImplementation(async (dn: string) => ({ entry: { dn, attributes: {} } }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useReferenceTabs 基本开关", () => {
  it("打开引用：加载条目、置活跃页签并回调用 recent/snapshot", async () => {
    const { session, onRecent, onSnapshot } = createHarness();
    await session.openReferencedEntry("cn=a,dc=demo", "member");
    await flushPromises();

    expect(entryGet).toHaveBeenCalledTimes(1);
    expect(entryGet).toHaveBeenCalledWith("cn=a,dc=demo");
    expect(session.referenceOpen.value).toBe(true);
    expect(session.referenceTabs.value).toHaveLength(1);
    expect(session.activeReferenceTab.value?.dn).toBe("cn=a,dc=demo");
    expect(session.activeReferenceTab.value?.attribute).toBe("member");
    expect(session.referenceEntry.value?.dn).toBe("cn=a,dc=demo");
    expect(session.referenceLoading.value).toBe(false);
    expect(session.referenceLoadError.value).toBe("");
    expect(onRecent).toHaveBeenCalledWith("cn=a,dc=demo");
    expect(onSnapshot).toHaveBeenCalledWith({ panel: "entry", anchor: "cn=a,dc=demo" });
  });

  it("切换与关闭：关非活跃页签不动选中，关最后一个页签复位面板", async () => {
    const { session } = createHarness();
    await session.openReferencedEntry("cn=a,dc=demo");
    await flushPromises();
    await session.openReferencedEntry("cn=b,dc=demo");
    await flushPromises();
    expect(session.referenceTabs.value.map((tab) => tab.dn)).toEqual(["cn=a,dc=demo", "cn=b,dc=demo"]);

    session.selectReferenceTab(session.referenceTabs.value[0].id);
    expect(session.referenceRequestedDn.value).toBe("cn=a,dc=demo");

    session.closeReferenceTab(session.referenceTabs.value[0].id);
    expect(session.referenceTabs.value.map((tab) => tab.dn)).toEqual(["cn=b,dc=demo"]);
    expect(session.activeReferenceTab.value?.dn).toBe("cn=b,dc=demo");

    session.closeReferenceTab(session.referenceTabs.value[0].id);
    expect(session.referenceTabs.value).toHaveLength(0);
    expect(session.referenceOpen.value).toBe(false);
    expect(session.activeReferenceTabId.value).toBe("");
  });
});

describe("useReferenceTabs 页签上限", () => {
  it("打开第 11 个引用：最旧的非活跃页签被淘汰，活跃页签保留", async () => {
    const { session } = createHarness();
    await openN(session, REFERENCE_TAB_LIMIT);
    expect(session.referenceTabs.value).toHaveLength(REFERENCE_TAB_LIMIT);
    expect(session.referenceTabs.value[0].dn).toBe("cn=e0,dc=demo");

    // 把最旧的 e0 置为活跃 → 淘汰必须跳过它，改关次旧的 e1。
    session.selectReferenceTab(session.referenceTabs.value[0].id);
    await session.openReferencedEntry("cn=new,dc=demo");
    await flushPromises();

    const dns = session.referenceTabs.value.map((tab) => tab.dn);
    expect(dns).toHaveLength(REFERENCE_TAB_LIMIT);
    expect(dns).toContain("cn=e0,dc=demo"); // 活跃页签永不被逐
    expect(dns).not.toContain("cn=e1,dc=demo"); // 次旧者顶替淘汰位
    expect(dns).toContain("cn=new,dc=demo");
    expect(session.activeReferenceTab.value?.dn).toBe("cn=new,dc=demo");
  });

  it("重开命中既有页签：复用页签、不发新请求、不触发淘汰", async () => {
    const { session } = createHarness();
    await openN(session, REFERENCE_TAB_LIMIT);
    const callsBefore = entryGet.mock.calls.length;
    const idsBefore = session.referenceTabs.value.map((tab) => tab.id);

    // 大小写不敏感命中既有 e0，且补写 attribute。
    await session.openReferencedEntry("CN=E0,dc=demo", "manager");
    await flushPromises();

    expect(entryGet).toHaveBeenCalledTimes(callsBefore);
    expect(session.referenceTabs.value).toHaveLength(REFERENCE_TAB_LIMIT);
    expect(session.referenceTabs.value.map((tab) => tab.id)).toEqual(idsBefore);
    expect(session.activeReferenceTab.value?.dn).toBe("cn=e0,dc=demo");
    expect(session.activeReferenceTab.value?.attribute).toBe("manager");
    expect(session.referenceTabs.value.some((tab) => tab.dn === "cn=e0,dc=demo")).toBe(true);
  });

  it("被淘汰页签的在途结果被 requestSeq 守卫丢弃，不复活、不影响其余页签", async () => {
    const { session } = createHarness();
    let release!: (value: { entry: { dn: string; attributes: Record<string, string[]> } }) => void;
    entryGet.mockImplementation(async (dn: string) => {
      if (dn === "cn=e0,dc=demo") return new Promise((done) => { release = done; });
      return { entry: { dn, attributes: {} } };
    });
    await openN(session, REFERENCE_TAB_LIMIT);
    expect(session.referenceTabs.value[0].loading).toBe(true); // e0 的 entryGet 仍在途

    await session.openReferencedEntry("cn=new,dc=demo"); // 第 11 个 → 淘汰在途的 e0
    await flushPromises();
    expect(session.referenceTabs.value.some((tab) => tab.dn === "cn=e0,dc=demo")).toBe(false);

    release({ entry: { dn: "cn=e0,dc=demo", attributes: { cn: ["late"] } } });
    await flushPromises();
    const dns = session.referenceTabs.value.map((tab) => tab.dn);
    expect(dns).toHaveLength(REFERENCE_TAB_LIMIT);
    expect(dns).not.toContain("cn=e0,dc=demo");
    expect(session.activeReferenceTab.value?.dn).toBe("cn=new,dc=demo");
  });
});
