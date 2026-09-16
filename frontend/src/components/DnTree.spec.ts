// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { ldapApi, type LdapSearchResult } from "../lib/api";
import DnTree from "./DnTree.vue";

vi.mock("../lib/api", () => ({
  getLdapConnectionId: vi.fn(() => ""),
  ldapApi: { search: vi.fn(), searchStart: vi.fn(), searchNext: vi.fn(), searchCancel: vi.fn(), count: vi.fn() },
}));

// Only replace viewport measurement; exercise the real tree rows and API flow.
const ListStub = defineComponent({
  props: ["items"],
  setup: (props, { slots }) => () => h("div", props.items.map((item: unknown, index: number) => slots.default?.({ item, index }))),
});
const search = vi.mocked(ldapApi.search);
const searchStart = vi.mocked(ldapApi.searchStart);
const searchNext = vi.mocked(ldapApi.searchNext);
const searchCancel = vi.mocked(ldapApi.searchCancel);
const count = vi.mocked(ldapApi.count);
const baseDn = "dc=demo,dc=dbx";
const hit = { dn: "cn=alice," + baseDn, attributes: { cn: ["alice"] } };
let wrapper: ReturnType<typeof mount<typeof DnTree>>;

beforeEach(() => {
  vi.useFakeTimers();
  search.mockReset();
  searchStart.mockReset();
  searchNext.mockReset();
  searchCancel.mockReset().mockResolvedValue({ success: true });
  count.mockReset().mockResolvedValue({ count: 0 });
  wrapper = mount(DnTree, {
    props: { baseDn, canWrite: true },
    global: { stubs: { VirtualList: ListStub } },
  });
});
afterEach(() => {
  wrapper.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DnTree keyboard navigation through virtual rows", () => {
  async function useRealList() {
    wrapper.unmount();
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { height: 84 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
    });
    wrapper = mount(DnTree, { props: { baseDn, canWrite: true }, attachTo: document.body });
    await wrapper.vm.refresh();
    await flushPromises();
  }

  async function press(key: string) {
    const row = wrapper.findAll(".tree-node").find((item) => item.element === document.activeElement);
    // Vue's trigger also advances the event timestamp past listeners attached
    // at the frozen fake-timer time, allowing child -> parent bubbling.
    await row?.trigger("keydown", { key });
    await flushPromises();
  }

  const focusedDn = () => document.activeElement?.getAttribute("title");

  it("enters children and returns to parents without toggling an already requested state", async () => {
    const parent = { dn: "ou=people," + baseDn, attributes: {} };
    const child = { dn: "cn=alice," + parent.dn, attributes: {} };
    searchStart.mockResolvedValueOnce({ searchId: "root", entries: [parent], hasMore: false });
    searchStart.mockResolvedValueOnce({ searchId: "parent", entries: [child], hasMore: false });
    count.mockResolvedValue({ count: 1 });
    await useRealList();
    (wrapper.find(".tree-node").element as HTMLElement).focus();
    await press("ArrowRight");
    expect(focusedDn()).toBe(parent.dn);
    await press("ArrowRight"); // load children, retaining parent focus
    expect(focusedDn()).toBe(parent.dn);
    await press("ArrowRight");
    expect(focusedDn()).toBe(child.dn);
    await press("ArrowLeft");
    expect(focusedDn()).toBe(parent.dn);
    await press("ArrowLeft"); // collapse
    expect(focusedDn()).toBe(parent.dn);
    expect(wrapper.findAll(".tree-node")).toHaveLength(2);
    await press("ArrowLeft");
    expect(focusedDn()).toBe(baseDn);
    await press("Enter");
    await press(" ");
    expect(wrapper.emitted("select")?.slice(-2)).toEqual([[baseDn], [baseDn]]);
  });

  it("uses Home/End and adjacent arrows across unmounted rows while keeping a bounded DOM", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ dn: `cn=user${index},${baseDn}`, attributes: {} }));
    searchStart.mockResolvedValue({ searchId: "root", entries, hasMore: false });
    count.mockResolvedValue({ count: entries.length });
    await useRealList();
    (wrapper.find(".tree-node").element as HTMLElement).focus();
    await press("End");
    expect(focusedDn()).toBe(entries[99].dn);
    await press("ArrowUp");
    expect(focusedDn()).toBe(entries[98].dn);
    await press("Home");
    expect(focusedDn()).toBe(baseDn);
    for (let index = 0; index < 30; index++) await press("ArrowDown");
    expect(focusedDn()).toBe(entries[29].dn);
    expect(wrapper.findAll(".tree-node").length).toBeLessThan(25);
  });

  it("navigates the full filtered list and ignores hierarchy keys there", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ dn: `cn=user${index},${baseDn}`, attributes: {} }));
    searchStart.mockResolvedValue({ searchId: "root", entries, hasMore: false });
    search.mockResolvedValue({ entries, count: entries.length, truncated: false });
    await useRealList();
    await filter("user");
    (wrapper.find(".tree-node").element as HTMLElement).focus();
    await press("End");
    expect(focusedDn()).toBe(entries[99].dn);
    await press("ArrowLeft");
    expect(focusedDn()).toBe(entries[99].dn);
    await press("Home");
    expect(focusedDn()).toBe(entries[0].dn);
    expect(wrapper.findAll(".tree-node").length).toBeLessThan(25);
  });
});

async function filter(keyword: string) {
  await wrapper.find(".tree-filter input").setValue(keyword);
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
}

describe("DnTree server-side child cursors", () => {
  const titles = () => wrapper.findAll(".tree-node").map((item) => item.attributes("title"));

  it("starts with one bounded page then appends only the next cursor page", async () => {
    const first = { dn: "ou=people," + baseDn, attributes: {} };
    const second = { dn: "cn=admins," + baseDn, attributes: {} };
    searchStart.mockResolvedValueOnce({ searchId: "root-page", entries: [first], hasMore: true });
    searchNext.mockResolvedValueOnce({ entries: [second], hasMore: false });

    await wrapper.vm.refresh();
    await flushPromises();

    expect(searchStart).toHaveBeenCalledWith(expect.objectContaining({
      baseDn,
      scope: "one",
      pageSize: 500,
    }));
    expect(search).not.toHaveBeenCalled();
    expect(wrapper.find(".tree-badge--truncated").text()).toBe("1+");

    await wrapper.find(".tree-badge--truncated").trigger("click");
    await flushPromises();

    expect(searchNext).toHaveBeenCalledWith("root-page", undefined);
    expect(searchStart).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual([baseDn, first.dn, second.dn]);
    expect(wrapper.find(".tree-badge--truncated").exists()).toBe(false);
  });

  it("keeps an already expanded child object when a later page is appended", async () => {
    const parent = { dn: "ou=people," + baseDn, attributes: {} };
    const leaf = { dn: "uid=alice," + parent.dn, attributes: {} };
    const sibling = { dn: "cn=admins," + baseDn, attributes: {} };
    searchStart.mockResolvedValueOnce({ searchId: "root-page", entries: [parent], hasMore: true });
    searchStart.mockResolvedValueOnce({ searchId: "parent-page", entries: [leaf], hasMore: false });
    searchNext.mockResolvedValueOnce({ entries: [sibling], hasMore: false });

    await wrapper.vm.refresh();
    await flushPromises();
    await wrapper.findAll(".tree-node").find((item) => item.attributes("title") === parent.dn)!.trigger("dblclick");
    await flushPromises();
    expect(titles()).toContain(leaf.dn);

    await wrapper.find(".tree-badge--truncated").trigger("click");
    await flushPromises();
    expect(titles()).toEqual([baseDn, parent.dn, leaf.dn, sibling.dn]);
  });

  it("cancels active cursors when refreshing, invalidating, unmounting, or switching connections", async () => {
    searchStart
      .mockResolvedValueOnce({ searchId: "refresh-old", entries: [], hasMore: true })
      .mockResolvedValueOnce({ searchId: "refresh-new", entries: [], hasMore: true })
      .mockResolvedValueOnce({ searchId: "connection-old", entries: [], hasMore: true })
      .mockResolvedValueOnce({ searchId: "connection-new", entries: [], hasMore: true });

    await wrapper.vm.refresh();
    await wrapper.vm.refresh();
    expect(searchCancel).toHaveBeenCalledWith("refresh-old", undefined);

    wrapper.vm.invalidate(baseDn);
    expect(searchCancel).toHaveBeenCalledWith("refresh-new", undefined);

    await wrapper.vm.refresh();
    await flushPromises();
    await wrapper.setProps({ connectionId: "next-connection" });
    await flushPromises();
    expect(searchCancel).toHaveBeenCalledWith("connection-old", undefined);

    wrapper.unmount();
    expect(searchCancel).toHaveBeenCalledWith("connection-new", "next-connection");
  });
});

describe("DnTree context menu presentation", () => {
  it("closes when selecting another filtered tree row", async () => {
    const second = { dn: "cn=bob," + baseDn, attributes: { cn: ["bob"] } };
    search.mockResolvedValueOnce({ entries: [hit, second], count: 2, truncated: false });
    await filter("cn=");
    const rows = wrapper.findAll(".tree-node");
    await rows[0].trigger("contextmenu", { clientX: 12, clientY: 18 });
    expect(document.querySelector(".context-menu")).not.toBeNull();
    await rows[1].trigger("click");
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(wrapper.emitted("select")?.at(-1)).toEqual([second.dn]);
  });

  it("renders an icon slot for every context action", async () => {
    search.mockResolvedValueOnce({ entries: [hit], count: 1, truncated: false });
    await filter("alice");
    const row = wrapper.find(".tree-node");
    await row.trigger("contextmenu", { clientX: 12, clientY: 18 });
    await flushPromises();

    const items = Array.from(document.querySelectorAll<HTMLElement>(".context-menu [role='menuitem']"));
    expect(items).toHaveLength(9);
    expect(items.every((item) => item.querySelector(".context-menu-item-icon"))).toBe(true);
    expect(items.every((item) => item.querySelector(".context-menu-item-icon")?.getAttribute("aria-hidden") === "true")).toBe(true);
  });
});

describe("DnTree recoverable states", () => {
  it("retries a failed remote filter without losing the keyword", async () => {
    search.mockRejectedValueOnce(new Error("connection refused"));
    search.mockResolvedValueOnce({ entries: [hit], count: 1, truncated: false });
    await filter("alice");
    expect(wrapper.find(".tree-error").attributes("role")).toBe("alert");
    expect(wrapper.find(".tree-error").text()).toContain("无法连接");
    await wrapper.find(".tree-error button").trigger("click");
    await flushPromises();
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][0]).toEqual(search.mock.calls[0][0]);
    expect((wrapper.find(".tree-filter input").element as HTMLInputElement).value).toBe("alice");
    expect(wrapper.find(".tree-error").exists()).toBe(false);
    expect(wrapper.find(".tree-node").attributes("title")).toBe(hit.dn);
  });

  it("refreshes the active filter instead of reloading the hidden root tree", async () => {
    search.mockRejectedValueOnce(new Error("connection refused"));
    search.mockResolvedValueOnce({ entries: [], count: 0, truncated: false });
    await filter("alice");
    await wrapper.find(".panel-header button").trigger("click");
    await flushPromises();
    expect(search.mock.calls[1][0]).toEqual(search.mock.calls[0][0]);
    expect(wrapper.find(".tree-error").exists()).toBe(false);
  });

  it("announces loading separately from no matches", async () => {
    let resolve!: (value: LdapSearchResult) => void;
    search.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await filter("nobody");
    expect(wrapper.find("[role='tree']").attributes("aria-busy")).toBe("true");
    expect(wrapper.find("[role='status']").text()).toContain("加载");
    resolve({ entries: [], count: 0, truncated: false });
    await flushPromises();
    expect(wrapper.find("[role='tree']").attributes("aria-busy")).toBe("false");
    expect(wrapper.find("[role='status']").text()).toContain("nobody");
  });

  it("keeps treeitem semantics and selected state in the filtered view", async () => {
    search.mockResolvedValueOnce({ entries: [hit], count: 1, truncated: false });
    await filter("alice");
    const row = wrapper.find(".tree-node");
    expect(row.attributes("role")).toBe("treeitem");
    expect(row.attributes("aria-level")).toBe("1");
    expect(row.attributes("aria-selected")).toBe("false");
    await row.trigger("click");
    expect(row.attributes("aria-selected")).toBe("true");
  });

  it("does not show an older response as the new keyword's result during debounce", async () => {
    let resolve!: (value: LdapSearchResult) => void;
    search.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await filter("alice");
    await wrapper.find(".tree-filter input").setValue("bob");
    resolve({ entries: [hit], count: 1, truncated: false });
    await flushPromises();
    expect(wrapper.find("[role='tree']").attributes("aria-busy")).toBe("true");
    expect(wrapper.find(".tree-node").exists()).toBe(false);
    search.mockResolvedValueOnce({ entries: [], count: 0, truncated: false });
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(wrapper.find("[role='status']").text()).toContain("bob");
  });

  it("cancels a pending debounced search when the tree unmounts", async () => {
    await wrapper.find(".tree-filter input").setValue("alice");
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(300);
    expect(search).not.toHaveBeenCalled();
  });
});
