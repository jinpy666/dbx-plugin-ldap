// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ldapApi, type LdapSearchPreset } from "../lib/api";
import { t } from "../lib/i18n";
import SearchForm from "./SearchForm.vue";

let wrapper: ReturnType<typeof mount<typeof SearchForm>>;
const savedPreset: LdapSearchPreset = { id: "stored-id", name: "People", filter: "(uid=old)", scope: "sub" };

async function mountPresets(presets: LdapSearchPreset[] = [savedPreset]) {
  vi.spyOn(ldapApi, "presetsList").mockResolvedValue({ presets });
  wrapper = mount(SearchForm, { props: { baseDn: "dc=demo,dc=dbx" } });
  await flushPromises();
  return wrapper;
}

const saveButton = () => wrapper.findAll(".search-presets button")[0];
// F11 起删除按钮排在动作按钮（重命名/副本/分组）之后，取末位以避免下标漂移。
const removeButton = () => wrapper.findAll(".search-presets button").at(-1)!;
const presetSelect = () => wrapper.find(".search-presets select");

afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("SearchForm actual preset responses", () => {
  it("updates by the returned id and re-applies the latest filter without duplicate options", async () => {
    const save = vi.spyOn(ldapApi, "presetsSave").mockImplementation(async (preset) => ({ success: true, preset: { ...preset, name: "People updated" } }));
    await mountPresets();
    await presetSelect().setValue(savedPreset.id);
    expect((wrapper.find(".preset-input").element as HTMLInputElement).value).toBe("People");
    await wrapper.find(".qb-value").setValue("new");
    await saveButton().trigger("click");
    await flushPromises();
    expect(save.mock.calls[0][0]).toMatchObject({ id: savedPreset.id, filter: "(uid=new)" });
    expect(save.mock.calls[0][0]).not.toHaveProperty("conditions");
    expect(presetSelect().findAll("option")).toHaveLength(2);
    expect(presetSelect().text()).toContain("People updated");
    await wrapper.find(".qb-value").setValue("unsaved");
    await presetSelect().trigger("change");
    expect(wrapper.find(".qb-preview").text()).toBe("(uid=new)");
  });

  it("uses the server-generated id for the next save", async () => {
    const save = vi.spyOn(ldapApi, "presetsSave").mockImplementation(async (preset) => ({ success: true, preset: { ...preset, id: "server-id" } }));
    await mountPresets([]);
    await wrapper.find(".preset-input").setValue("New preset");
    await saveButton().trigger("click");
    await flushPromises();
    await saveButton().trigger("click");
    await flushPromises();
    expect(save.mock.calls.map(([preset]) => preset.id)).toEqual(["", "server-id"]);
    expect(presetSelect().findAll("option")).toHaveLength(2);
  });

  it("blocks duplicate saves in flight and preserves the draft when saving fails", async () => {
    let reject!: (cause: Error) => void;
    const save = vi.spyOn(ldapApi, "presetsSave").mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    await mountPresets();
    await presetSelect().setValue(savedPreset.id);
    await saveButton().trigger("click");
    await saveButton().trigger("click");
    expect(save).toHaveBeenCalledOnce();
    expect(presetSelect().attributes("disabled")).toBeDefined();
    reject(new Error("write failed"));
    await flushPromises();
    expect(wrapper.emitted("error")?.at(-1)).toEqual(["write failed"]);
    expect(presetSelect().findAll("option")).toHaveLength(2);
    expect(saveButton().attributes("disabled")).toBeUndefined();
  });

  it("removes only the selected id via the inline two-step confirm (J-5)", async () => {
    const remove = vi.spyOn(ldapApi, "presetsRemove").mockResolvedValue({ success: true });
    await mountPresets([savedPreset, { id: "other", name: "Other" }]);
    await presetSelect().setValue(savedPreset.id);
    // 第一次点击只进入确认态：不调删除接口，按钮切确认文案 + 带名 title。
    await removeButton().trigger("click");
    expect(remove).not.toHaveBeenCalled();
    expect(removeButton().classes()).toContain("is-armed");
    expect(removeButton().text()).toContain(t("confirm"));
    expect(removeButton().attributes("title")).toBe(t("search.presetRemoveConfirm", { name: "People" }));
    // 确认态再次点击才执行删除。
    await removeButton().trigger("click");
    await flushPromises();
    expect(remove).toHaveBeenCalledWith(savedPreset.id);
    expect(presetSelect().findAll("option").map((option) => option.attributes("value"))).toEqual(["", "other"]);
  });

  it("falls back to the idle state when the confirm window times out (J-5)", async () => {
    // 先在真实 timers 下挂载（flushPromises 依赖宏任务），再接管时钟。
    const remove = vi.spyOn(ldapApi, "presetsRemove").mockResolvedValue({ success: true });
    await mountPresets();
    await presetSelect().setValue(savedPreset.id);
    vi.useFakeTimers();
    try {
      await removeButton().trigger("click");
      expect(removeButton().classes()).toContain("is-armed");
      // 3 秒无操作自动回落：之后的一次点击只是重新进入确认态，不删除。
      vi.advanceTimersByTime(3000);
      // 定时器回调同步改 ref，但 DOM 刷新在 nextTick，先等一拍再断言。
      await wrapper.vm.$nextTick();
      expect(removeButton().classes()).not.toContain("is-armed");
      await removeButton().trigger("click");
      expect(remove).not.toHaveBeenCalled();
      expect(removeButton().classes()).toContain("is-armed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarms the confirm state when switching the selected preset", async () => {
    const remove = vi.spyOn(ldapApi, "presetsRemove").mockResolvedValue({ success: true });
    await mountPresets([savedPreset, { id: "other", name: "Other" }]);
    await presetSelect().setValue(savedPreset.id);
    await removeButton().trigger("click");
    expect(removeButton().classes()).toContain("is-armed");
    await presetSelect().setValue("other");
    expect(removeButton().classes()).not.toContain("is-armed");
    await removeButton().trigger("click");
    expect(remove).not.toHaveBeenCalled();
  });

  it("restores protocol defaults and derives the builder from filter, ignoring old fixture conditions", async () => {
    await mountPresets([{ ...savedPreset, conditions: { kind: "clause", attribute: "uid", operator: "equals", value: "stale" } } as LdapSearchPreset]);
    await presetSelect().setValue(savedPreset.id);
    expect(wrapper.find(".qb-preview").text()).toBe("(uid=old)");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("run")?.[0][0]).toMatchObject({ filter: "(uid=old)", baseDn: "", sizeLimit: "0" });
  });
});

describe("SearchForm preset grouping and entry actions (F11)", () => {
  const groupedPresets: LdapSearchPreset[] = [
    { id: "g1", name: "Team users", filter: "(objectClass=person)", group: "Team" },
    { id: "g2", name: "Team groups", filter: "(objectClass=group)", group: "Team" },
    { id: "u1", name: "Loose", filter: "(uid=*)" },
  ];

  const actionButton = (name: "rename" | "duplicate" | "group") => wrapper.find(`.search-presets .preset-${name}`);

  it("renders presets grouped by group with ungrouped last as its own section", async () => {
    await mountPresets(groupedPresets);
    const groups = wrapper.findAll("optgroup");
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.attributes("label"))).toEqual(["Team", t("presetActions.ungrouped")]);
    expect(groups[0].findAll("option").map((option) => option.text())).toEqual(["Team users", "Team groups"]);
    expect(groups[1].findAll("option").map((option) => option.text())).toEqual(["Loose"]);
  });

  it("duplicates the selected preset with a copy name and lets the server regenerate the id", async () => {
    const save = vi.spyOn(ldapApi, "presetsSave").mockImplementation(async (preset) => ({ success: true, preset: { ...preset, id: "copy-id" } }));
    await mountPresets([{ ...savedPreset, group: "Ops" }]);
    await presetSelect().setValue(savedPreset.id);
    await actionButton("duplicate").trigger("click");
    await flushPromises();
    // id 传空（sidecar 重新生成），副本名 = 原名 + " (2)"，分组与原内容沿用。
    expect(save.mock.calls[0][0]).toMatchObject({ id: "", name: "People (2)", group: "Ops", filter: savedPreset.filter, scope: savedPreset.scope });
    // 保存后选中的是副本（服务端返回的新 id）。
    expect((presetSelect().element as HTMLSelectElement).value).toBe("copy-id");
    expect((wrapper.find(".preset-input").element as HTMLInputElement).value).toBe("People (2)");
  });

  it("increments the duplicate suffix until the copy name is unique", async () => {
    const save = vi.spyOn(ldapApi, "presetsSave").mockImplementation(async (preset) => ({ success: true, preset: { ...preset, id: `copy:${preset.name}` } }));
    await mountPresets();
    await presetSelect().setValue(savedPreset.id);
    await actionButton("duplicate").trigger("click");
    await flushPromises();
    expect(save.mock.calls[0][0]).toMatchObject({ id: "", name: "People (2)" });
    // 重新选中原始预设再复制一次：现有集合里 "People (2)" 已被占用，
    // 后缀应递增到 " (3)"，而不是叠出第二条同名 "People (2)"。
    await presetSelect().setValue(savedPreset.id);
    await actionButton("duplicate").trigger("click");
    await flushPromises();
    expect(save.mock.calls[1][0]).toMatchObject({ id: "", name: "People (3)" });
    // 原名 + 两份副本在下拉中各占一条，无重名。
    const names = presetSelect().findAll("option").map((option) => option.text());
    expect(names.slice(1)).toEqual(["People", "People (2)", "People (3)"]);
  });

  it("renames via the inline editor, keeps the id and updates the option label", async () => {
    const save = vi.spyOn(ldapApi, "presetsSave").mockImplementation(async (preset) => ({ success: true, preset }));
    await mountPresets();
    await presetSelect().setValue(savedPreset.id);
    await actionButton("rename").trigger("click");
    const editor = wrapper.find(".preset-editor input");
    expect((editor.element as HTMLInputElement).value).toBe("People");
    await editor.setValue("People renamed");
    await editor.trigger("keydown.enter");
    await flushPromises();
    expect(save.mock.calls[0][0]).toMatchObject({ id: savedPreset.id, name: "People renamed" });
    expect(presetSelect().text()).toContain("People renamed");
    expect(wrapper.find(".preset-editor").exists()).toBe(false);
  });

  it("sets and clears the group through the inline editor (empty = ungrouped)", async () => {
    const save = vi.spyOn(ldapApi, "presetsSave").mockImplementation(async (preset) => ({ success: true, preset }));
    await mountPresets();
    await presetSelect().setValue(savedPreset.id);
    await actionButton("group").trigger("click");
    const editor = wrapper.find(".preset-editor input");
    expect(editor.attributes("placeholder")).toBe(t("presetActions.groupPlaceholder"));
    await editor.setValue("Ops");
    await editor.trigger("keydown.enter");
    await flushPromises();
    expect(save.mock.calls[0][0]).toMatchObject({ id: savedPreset.id, group: "Ops" });
    expect(wrapper.findAll("optgroup").map((group) => group.attributes("label"))).toEqual(["Ops"]);
    // 再次打开编辑器应预填当前分组；清空提交 = 回到未分组（不携带 group）。
    await actionButton("group").trigger("click");
    expect((wrapper.find(".preset-editor input").element as HTMLInputElement).value).toBe("Ops");
    await wrapper.find(".preset-editor input").setValue("");
    await wrapper.find(".preset-editor input").trigger("keydown.enter");
    await flushPromises();
    expect(save.mock.calls[1][0]).not.toHaveProperty("group");
    expect(wrapper.findAll("optgroup").map((group) => group.attributes("label"))).toEqual([t("presetActions.ungrouped")]);
  });

  it("carries the selected preset group through ordinary form saves", async () => {
    const save = vi.spyOn(ldapApi, "presetsSave").mockImplementation(async (preset) => ({ success: true, preset }));
    await mountPresets([{ ...savedPreset, group: "Ops" }]);
    await presetSelect().setValue(savedPreset.id);
    await wrapper.find(".qb-value").setValue("new");
    await saveButton().trigger("click");
    await flushPromises();
    expect(save.mock.calls[0][0]).toMatchObject({ id: savedPreset.id, name: "People", filter: "(uid=new)", group: "Ops" });
  });

  it("disables the entry actions until a preset is selected", async () => {
    await mountPresets();
    for (const name of ["rename", "duplicate", "group"] as const) {
      expect(actionButton(name).attributes("disabled")).toBeDefined();
    }
    await presetSelect().setValue(savedPreset.id);
    for (const name of ["rename", "duplicate", "group"] as const) {
      expect(actionButton(name).attributes("disabled")).toBeUndefined();
    }
  });
});
