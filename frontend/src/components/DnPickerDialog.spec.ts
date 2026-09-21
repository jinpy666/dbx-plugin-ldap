// @vitest-environment happy-dom
// DnPickerDialog 组件测试：根节点懒加载、展开/收起、行点击 select 回填、
// 截断徽标、错误透出、取消关闭。ldapApi.search 打 mock。
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DnPickerDialog from "./DnPickerDialog.vue";
import { ldapApi, type LdapEntry } from "../lib/api";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, ldapApi: { ...actual.ldapApi, search: vi.fn() } };
});

const searchMock = vi.mocked(ldapApi.search);

beforeEach(() => {
  searchMock.mockReset();
});

const tracked: Awaited<ReturnType<typeof mountPicker>>[] = [];

function mountPicker(props: { open?: boolean; baseDn?: string } = {}) {
  return mount(DnPickerDialog, { props: { open: true, baseDn: "dc=demo,dc=dbx", ...props } });
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const track = async (props?: Parameters<typeof mountPicker>[0]) => {
  const wrapper = mountPicker(props);
  tracked.push(wrapper);
  await flushPromises();
  return wrapper;
};

const entry = (dn: string): LdapEntry => ({ dn, attributes: {} });
const rowByLabel = (wrapper: Awaited<ReturnType<typeof mountPicker>>, label: string) =>
  wrapper.findAll(".dn-picker-row").find((row) => row.find(".dn-picker-name").text() === label)!;

describe("DnPickerDialog", () => {
  it("loads the root children lazily on open", async () => {
    searchMock.mockResolvedValue({ entries: [entry("ou=people,dc=demo,dc=dbx"), entry("ou=groups,dc=demo,dc=dbx")], count: 2, truncated: false });
    const wrapper = await track();
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseDn: "dc=demo,dc=dbx", scope: "one", filter: "(objectClass=*)" }),
    );
    const labels = wrapper.findAll(".dn-picker-name").map((node) => node.text());
    expect(labels).toEqual(["dc=demo,dc=dbx", "ou=people", "ou=groups"]);
  });

  it("expands a node on toggle and loads only that node's children", async () => {
    searchMock.mockResolvedValue({ entries: [entry("ou=people,dc=demo,dc=dbx")], count: 1, truncated: false });
    const wrapper = await track();
    searchMock.mockClear();
    searchMock.mockResolvedValue({ entries: [entry("cn=alice,ou=people,dc=demo,dc=dbx")], count: 1, truncated: false });
    await rowByLabel(wrapper, "ou=people").find(".dn-picker-toggle").trigger("click");
    await flushPromises();
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ baseDn: "ou=people,dc=demo,dc=dbx" });
    expect(rowByLabel(wrapper, "cn=alice").exists()).toBe(true);
  });

  it("emits select with the row DN on name click", async () => {
    searchMock.mockResolvedValue({ entries: [entry("ou=people,dc=demo,dc=dbx")], count: 1, truncated: false });
    const wrapper = await track();
    await rowByLabel(wrapper, "ou=people").find(".dn-picker-name").trigger("click");
    expect(wrapper.emitted("select")![0]).toEqual(["ou=people,dc=demo,dc=dbx"]);
  });

  it("emits select when clicking the row outside the name button (整行可点)", async () => {
    searchMock.mockResolvedValue({ entries: [entry("ou=people,dc=demo,dc=dbx")], count: 1, truncated: false });
    const wrapper = await track();
    const row = rowByLabel(wrapper, "ou=people");
    // 模拟点到行内按钮之外的空白区域：事件目标为 li 自身。
    await row.trigger("click");
    expect(wrapper.emitted("select")![0]).toEqual(["ou=people,dc=demo,dc=dbx"]);
  });

  it("does not select when only expanding via the toggle button", async () => {
    searchMock.mockResolvedValue({ entries: [entry("ou=people,dc=demo,dc=dbx")], count: 1, truncated: false });
    const wrapper = await track();
    await rowByLabel(wrapper, "ou=people").find(".dn-picker-toggle").trigger("click");
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("shows the truncation badge when the backend reports truncation", async () => {
    searchMock.mockResolvedValue({ entries: Array.from({ length: 20 }, (_, i) => entry(`cn=u${i},dc=demo,dc=dbx`)), count: 20, truncated: true });
    const wrapper = await track();
    expect(wrapper.find(".badge").exists()).toBe(true);
  });

  it("requests the 500-entry cap aligned with TREE_FETCH_PAGE", async () => {
    searchMock.mockResolvedValue({ entries: [], count: 0, truncated: false });
    await track();
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ sizeLimit: 500 }));
  });

  it("shows the badge past the 500 cap when the backend omits the truncation flag", async () => {
    searchMock.mockResolvedValue({
      entries: Array.from({ length: 501 }, (_, i) => entry(`cn=u${i},dc=demo,dc=dbx`)),
      count: 501,
      truncated: false,
    });
    const wrapper = await track();
    expect(wrapper.find(".badge").exists()).toBe(true);
  });

  it("hides the badge at exactly the 500 cap without a truncation flag", async () => {
    searchMock.mockResolvedValue({
      entries: Array.from({ length: 500 }, (_, i) => entry(`cn=u${i},dc=demo,dc=dbx`)),
      count: 500,
      truncated: false,
    });
    const wrapper = await track();
    expect(wrapper.find(".badge").exists()).toBe(false);
  });

  it("surfaces search errors without crashing", async () => {
    searchMock.mockRejectedValue(new Error("connection lost"));
    const wrapper = await track();
    expect(wrapper.find(".form-error").text()).toContain("connection lost");
    expect(wrapper.find(".form-error").attributes("role")).toBe("alert");
  });

  it("renders nothing interactive without a base DN", async () => {
    searchMock.mockClear();
    const wrapper = await track({ baseDn: "" });
    expect(wrapper.text()).not.toContain("dc=");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("reloads when reopened with a different base", async () => {
    searchMock.mockResolvedValue({ entries: [], count: 0, truncated: false });
    const wrapper = await track({ open: false, baseDn: "dc=a" });
    expect(searchMock).not.toHaveBeenCalled();
    await wrapper.setProps({ open: true, baseDn: "dc=b" });
    await flushPromises();
    expect(searchMock).toHaveBeenCalledWith(expect.objectContaining({ baseDn: "dc=b" }));
  });
});
