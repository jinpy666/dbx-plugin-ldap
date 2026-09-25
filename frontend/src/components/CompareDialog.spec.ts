// @vitest-environment happy-dom
// CompareDialog workbench UI tests（对照 BatchModifyDialog.spec 的用例风格）：
// 关闭不渲染、当前 DN 只读回显、目标 DN 必填/同 DN 校验（不发请求）、整条目
// 差异表与汇总、identical 路径、异常路径（friendlyLdapError 内联 + notify）、
// submitting 防重入与 Esc 否决、DN 选择器回填、各关闭通道、关闭重开重置。
// 文案断言一律用 t() 动态取值（同 batch spec 约定，不硬编码语言串）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ldapApi, type LdapEntry } from "../lib/api";
import { friendlyLdapError } from "../lib/ldapErrors";
import { t } from "../lib/i18n";
import CompareDialog from "./CompareDialog.vue";

const DN = "cn=alice,dc=demo,dc=dbx";
const TARGET = "cn=bob,dc=demo,dc=dbx";

const tracked: Array<ReturnType<typeof mount<typeof CompareDialog>>> = [];

function trackDialog(props: { open: boolean; dn?: string }) {
  const wrapper = mount(CompareDialog, { props: { dn: DN, ...props } });
  tracked.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
});

const runButton = (wrapper: ReturnType<typeof mount<typeof CompareDialog>>) =>
  wrapper.findAll("footer button").find((button) => button.classes().includes("primary-button"))!;
const cancelButton = (wrapper: ReturnType<typeof mount<typeof CompareDialog>>) =>
  wrapper.findAll("footer button").find((button) => button.text() === t("cancel"))!;

const typeTarget = async (wrapper: ReturnType<typeof mount<typeof CompareDialog>>, value: string) => {
  await wrapper.find(".compare-target-input").setValue(value);
};

const pressEscape = () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

// 按精确 DN 查表返回条目；未知 DN 报错（模拟 sidecar entry not found）。
function mockEntryGet(entries: Record<string, LdapEntry>) {
  return vi.spyOn(ldapApi, "entryGet").mockImplementation(((dn: string) => {
    const entry = entries[dn];
    return entry ? Promise.resolve({ entry }) : Promise.reject(new Error(`entry not found: ${dn}`));
  }) as typeof ldapApi.entryGet);
}

describe("CompareDialog", () => {
  it("renders nothing while closed", () => {
    const wrapper = trackDialog({ open: false });
    expect(wrapper.find(".modal-backdrop").exists()).toBe(false);
  });

  it("shows the title, the pre-filled read-only DN and an empty target DN", () => {
    const wrapper = trackDialog({ open: true });
    expect(wrapper.find("h2").text()).toBe(t("compare.title"));
    const dn = wrapper.find(".compare-dn");
    expect((dn.element as HTMLInputElement).value).toBe(DN);
    expect(dn.attributes("readonly")).toBeDefined();
    expect((wrapper.find(".compare-target-input").element as HTMLInputElement).value).toBe("");
    expect(runButton(wrapper).attributes("disabled")).toBeDefined();
  });

  it("hides inline errors on open, reveals them after a submit attempt, and still blocks the run", async () => {
    const entryGet = vi.spyOn(ldapApi, "entryGet");
    const wrapper = trackDialog({ open: true });
    // 打开瞬间：空目标不渲染行内红字/无效标记（视觉审计 UX-V8），按钮仍禁用。
    expect(wrapper.find(".compare-target-input").attributes("aria-invalid")).toBe("false");
    expect(wrapper.findAll(".form-error")).toHaveLength(0);
    // 提交尝试（输入框按 Enter）后：目标缺失错误显现（aria-invalid + 行内红字）。
    await wrapper.find(".compare-target-input").trigger("keydown.enter");
    expect(wrapper.find(".compare-target-input").attributes("aria-invalid")).toBe("true");
    expect(wrapper.findAll(".form-error").map((error) => error.text())).toEqual([t("compare.needTarget")]);
    // 禁用按钮被强点也不发请求。
    await runButton(wrapper).trigger("click");
    expect(entryGet).not.toHaveBeenCalled();
  });

  it("blocks a self-compare (case-insensitive) without issuing requests", async () => {
    const entryGet = vi.spyOn(ldapApi, "entryGet");
    const wrapper = trackDialog({ open: true });
    await typeTarget(wrapper, DN.toUpperCase());
    expect(wrapper.findAll(".form-error").map((error) => error.text())).toEqual([t("compare.sameDn")]);
    expect(runButton(wrapper).attributes("disabled")).toBeDefined();
    await runButton(wrapper).trigger("click");
    expect(entryGet).not.toHaveBeenCalled();
  });

  it("renders the whole-entry diff table with per-attribute verdicts", async () => {
    const entryGet = mockEntryGet({
      [DN]: { dn: DN, attributes: { cn: ["alice"], mail: ["a@demo.dbx"], objectClass: ["top"] } },
      [TARGET]: { dn: TARGET, attributes: { cn: ["bob"], objectClass: ["top"], uid: ["u1"] } },
    });
    const wrapper = trackDialog({ open: true });
    await typeTarget(wrapper, ` ${TARGET} `);
    await runButton(wrapper).trigger("click");
    await flushPromises();
    // 目标 DN trim 后下发；两次 entryGet 分别取当前/目标条目。
    expect(entryGet).toHaveBeenCalledWith(DN);
    expect(entryGet).toHaveBeenCalledWith(TARGET);
    // 汇总：共 4 个属性（cn/mail/objectClass/uid），3 个存在差异。
    expect(wrapper.find(".compare-result-nomatch").text()).toBe(t("compare.diffSummary", { count: 3, total: 4 }));
    // 差异表只列差异行（objectClass 一致不展示）；值两列排序对齐。
    const rows = wrapper.findAll(".compare-diff-row");
    expect(rows).toHaveLength(3);
    const names = rows.map((row) => row.find(".mono").text());
    expect(names).toEqual(["cn", "mail", "uid"]);
    const texts = rows.map((row) => row.text());
    expect(texts[0]).toContain(t("compare.different"));
    expect(texts[0]).toContain("alice");
    expect(texts[0]).toContain("bob");
    expect(texts[1]).toContain(t("compare.onlyLeft"));
    expect(texts[1]).toContain("a@demo.dbx");
    expect(texts[2]).toContain(t("compare.onlyRight"));
    expect(texts[2]).toContain("u1");
    expect(wrapper.emitted("notify")).toBeUndefined();
    // 提交成功后再次编辑目标：旧差异表对新输入不再成立，展示随之清除。
    await typeTarget(wrapper, "cn=carol,dc=demo,dc=dbx");
    expect(wrapper.find(".compare-diff-table").exists()).toBe(false);
  });

  it("shows the identical verdict when both entries carry the same attributes", async () => {
    mockEntryGet({
      [DN]: { dn: DN, attributes: { cn: ["same"] } },
      [TARGET]: { dn: TARGET, attributes: { cn: ["same"] } },
    });
    const wrapper = trackDialog({ open: true });
    await typeTarget(wrapper, TARGET);
    await runButton(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.find(".compare-result-match").text()).toBe(t("compare.identical", { count: 1 }));
    expect(wrapper.find(".compare-diff-table").exists()).toBe(false);
  });

  it("maps request failures to a friendly inline message and emits notify once", async () => {
    const raw = 'ldap entry get: LDAP Result Code 32 "No Such Object"';
    vi.spyOn(ldapApi, "entryGet").mockRejectedValue(new Error(raw));
    const wrapper = trackDialog({ open: true });
    await typeTarget(wrapper, TARGET);
    await runButton(wrapper).trigger("click");
    await flushPromises();
    const expected = t("compare.failed", { error: friendlyLdapError(raw) });
    expect(wrapper.find(".form-error").text()).toBe(expected);
    expect(wrapper.emitted("notify")).toEqual([[expected]]);
    // 失败后 submitting 复位，可再次比较。
    expect(runButton(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("guards against double submit while the compare request is in flight", async () => {
    let release!: (value: { entry: LdapEntry }) => void;
    // 两次 entryGet 共享同一个在途 Promise：释放一次即两侧同时落定。
    const shared = new Promise<{ entry: LdapEntry }>((resolve) => { release = resolve; });
    vi.spyOn(ldapApi, "entryGet").mockImplementation(() => shared);
    const wrapper = trackDialog({ open: true });
    await typeTarget(wrapper, TARGET);
    await runButton(wrapper).trigger("click");
    // 在途：按钮禁用显示省略号，重复点击不再发请求。
    expect(runButton(wrapper).text()).toBe("…");
    expect(runButton(wrapper).attributes("disabled")).toBeDefined();
    await runButton(wrapper).trigger("click");
    // 一次 run = 当前 + 目标各一次 entryGet；在途重复点击不追加请求。
    expect(ldapApi.entryGet).toHaveBeenCalledTimes(2);
    release({ entry: { dn: TARGET, attributes: {} } });
    await flushPromises();
    expect(runButton(wrapper).text()).toBe(t("compare.run"));
  });

  it("fills the target DN from the tree picker and clears a stale verdict", async () => {
    const CHILD = "cn=devs,ou=groups,dc=demo,dc=dbx";
    vi.spyOn(ldapApi, "search").mockResolvedValue({
      entries: [{ dn: CHILD, attributes: {} }],
      count: 1,
      truncated: false,
    });
    const wrapper = trackDialog({ open: true });
    await wrapper.findAll("button").find((button) => button.text() === t("compare.pickDn"))!.trigger("click");
    await flushPromises();
    const picker = wrapper.find(".dn-picker-modal");
    expect(picker.exists()).toBe(true);
    // 选择器浏览根：当前条目的父 DN（cn=alice 的父为 dc=demo,dc=dbx）。
    expect(picker.text()).toContain("dc=demo,dc=dbx");
    // 首行是浏览根本身，点选其下的子条目行。
    await picker.findAll(".dn-picker-row").at(1)!.trigger("click");
    expect((wrapper.find(".compare-target-input").element as HTMLInputElement).value).toBe(CHILD);
    expect(wrapper.find(".dn-picker-modal").exists()).toBe(false);
  });

  it("closes via Escape, cancel and the header ✕ when idle", async () => {
    const wrapper = trackDialog({ open: false });
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toHaveLength(1);
    await cancelButton(wrapper).trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(2);
    await wrapper.find(".icon-button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(3);
  });

  it("closes via backdrop self-click while idle, not on inner clicks", async () => {
    const wrapper = trackDialog({ open: true });
    await wrapper.find(".modal").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.find(".modal-backdrop").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("vetoes Escape and backdrop while the request is in flight but keeps ✕ working", async () => {
    let release!: (value: { entry: LdapEntry }) => void;
    // 两次 entryGet 共享同一个在途 Promise（同 double-submit 用例口径）。
    const shared = new Promise<{ entry: LdapEntry }>((resolve) => { release = resolve; });
    vi.spyOn(ldapApi, "entryGet").mockImplementation(() => shared);
    const wrapper = trackDialog({ open: true });
    await typeTarget(wrapper, TARGET);
    await runButton(wrapper).trigger("click");
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.find(".modal-backdrop").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    // 显式通道（✕）不受在途否决影响，与家族弹窗一致。
    await wrapper.find(".icon-button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    release({ entry: { dn: TARGET, attributes: {} } });
    await flushPromises();
  });

  it("resets the target and the verdict each time it opens", async () => {
    mockEntryGet({
      [DN]: { dn: DN, attributes: { cn: ["same"] } },
      [TARGET]: { dn: TARGET, attributes: { cn: ["same"] } },
    });
    const wrapper = trackDialog({ open: true });
    await typeTarget(wrapper, TARGET);
    await runButton(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.find(".compare-result-match").exists()).toBe(true);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    expect((wrapper.find(".compare-target-input").element as HTMLInputElement).value).toBe("");
    expect(wrapper.find(".compare-result-match").exists()).toBe(false);
    expect(runButton(wrapper).attributes("disabled")).toBeDefined();
  });
});
