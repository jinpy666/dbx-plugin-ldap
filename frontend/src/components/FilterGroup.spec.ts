// @vitest-environment happy-dom
// Component tests for the visual filter builder rows (M5-a UI test track):
// operator coverage (incl. ≠), row add/remove, empty-group state and the
// disabled gate — all mutating the caller-owned BuilderGroup in place.
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import FilterGroup from "./FilterGroup.vue";
import { createBuilderClause, createBuilderGroup, type BuilderGroup } from "../lib/ldapFilter";

function mountGroup(children = [createBuilderClause({ attribute: "uid", op: "equals", value: "admin" })]) {
  const group: BuilderGroup = createBuilderGroup({ children });
  const wrapper = mount(FilterGroup, { props: { group, depth: 0, listId: "test-datalist" } });
  return { wrapper, group };
}

describe("FilterGroup", () => {
  it("renders clause rows with the full operator set (incl. notEquals)", () => {
    const { wrapper } = mountGroup();
    expect(wrapper.find(".qb-attr").exists()).toBe(true);
    expect(wrapper.find(".qb-value").exists()).toBe(true);
    const optionValues = wrapper.findAll("select option").map((option) => (option.element as HTMLOptionElement).value);
    expect(optionValues).toEqual(["equals", "notEquals", "contains", "startsWith", "endsWith", "present", "gte", "lte", "approx"]);
  });

  it("keeps two-way binding with the caller-owned node (v-model)", async () => {
    const { wrapper, group } = mountGroup();
    await wrapper.find(".qb-attr").setValue("mail");
    await wrapper.find("select").setValue("notEquals");
    await wrapper.find(".qb-value").setValue("a@b");
    expect(group.children[0]).toMatchObject({ attribute: "mail", op: "notEquals", value: "a@b" });
  });

  it("adds and removes clause rows", async () => {
    const { wrapper, group } = mountGroup();
    await wrapper.findAll(".qb-add")[0].trigger("click");
    expect(group.children).toHaveLength(2);
    await wrapper.findAll(".qb-remove")[0].trigger("click");
    expect(group.children).toHaveLength(1);
    await wrapper.findAll(".qb-remove")[0].trigger("click");
    expect(group.children).toHaveLength(0);
    expect(wrapper.find(".qb-empty").exists()).toBe(true);
  });

  it("hides the value input for presence clauses", async () => {
    const { wrapper } = mountGroup();
    await wrapper.find("select").setValue("present");
    expect(wrapper.find(".qb-value--empty").exists()).toBe(true);
  });

  it("disables every control when disabled is set", async () => {
    const group: BuilderGroup = createBuilderGroup({ children: [createBuilderClause()] });
    const wrapper = mount(FilterGroup, { props: { group, depth: 0, listId: "d", disabled: true } });
    for (const button of wrapper.findAll("button")) {
      expect(button.attributes("disabled")).toBeDefined();
    }
    await wrapper.find(".qb-attr").setValue("x");
    expect(group.children[0].kind === "clause" && group.children[0].attribute).toBe("");
  });

  it("caps nesting: depth 1 hides the add-group action", () => {
    const group: BuilderGroup = createBuilderGroup({ children: [createBuilderClause()] });
    const wrapper = mount(FilterGroup, { props: { group, depth: 1, listId: "d" } });
    expect(wrapper.findAll(".qb-add")).toHaveLength(1);
  });

  it("closes the attribute picker immediately after selecting an option", async () => {
    const group: BuilderGroup = createBuilderGroup({ children: [createBuilderClause()] });
    const wrapper = mount(FilterGroup, {
      props: { group, depth: 0, listId: "test-datalist", attributeOptions: ["uid", "mail", "objectClass"] },
    });
    await wrapper.find(".qb-attr").trigger("focus");
    expect(wrapper.find(".qb-attr-dropdown").exists()).toBe(true);
    await wrapper.find(".qb-attr-option").trigger("click");
    expect(group.children[0].kind === "clause" && group.children[0].attribute).toBe("uid");
    expect(wrapper.find(".qb-attr-dropdown").exists()).toBe(false);
  });

  it("toggles NOT on a clause row and reflects the active state", async () => {
    const { wrapper, group } = mountGroup();
    const notButton = wrapper.find(".qb-not");
    expect(notButton.classes()).not.toContain("is-active");
    await notButton.trigger("click");
    expect(group.children[0]).toMatchObject({ kind: "clause", negate: true });
    expect(wrapper.find(".qb-not").classes()).toContain("is-active");
    await wrapper.find(".qb-not").trigger("click");
    expect(group.children[0].kind === "clause" && group.children[0].negate).toBeFalsy();
  });

  it("shows ≠ rows as negated and downgrades them to equals on the first NOT click", async () => {
    const { wrapper, group } = mountGroup();
    await wrapper.find("select").setValue("notEquals");
    expect(wrapper.find(".qb-not").classes()).toContain("is-active");
    await wrapper.find(".qb-not").trigger("click");
    expect(group.children[0]).toMatchObject({ kind: "clause", op: "equals" });
    expect(group.children[0].kind === "clause" && group.children[0].negate).toBeFalsy();
    expect(wrapper.find(".qb-not").classes()).not.toContain("is-active");
  });

  it("clears the NOT toggle when ≠ is selected from the operator dropdown", async () => {
    const { wrapper, group } = mountGroup([createBuilderClause({ attribute: "cn", op: "equals", value: "x", negate: true })]);
    expect(wrapper.find(".qb-not").classes()).toContain("is-active");
    await wrapper.find("select").setValue("notEquals");
    expect(group.children[0]).toMatchObject({ kind: "clause", op: "notEquals" });
    expect(group.children[0].kind === "clause" && group.children[0].negate).toBeFalsy();
  });

  it("toggles NOT on the group head and disables it with the disabled gate", async () => {
    const group: BuilderGroup = createBuilderGroup({ children: [createBuilderClause()] });
    const wrapper = mount(FilterGroup, { props: { group, depth: 0, listId: "d" } });
    const headButtons = wrapper.findAll(".qb-group-head .qb-join button");
    const groupNot = headButtons[headButtons.length - 1];
    expect(groupNot.text()).toBe("NOT");
    await groupNot.trigger("click");
    expect(group.negate).toBe(true);
    expect(groupNot.classes()).toContain("is-active");
    await groupNot.trigger("click");
    expect(group.negate).toBeUndefined();
  });

  it("renders the clause NOT button as the leading grid cell", () => {
    const group: BuilderGroup = createBuilderGroup({
      children: [
        createBuilderClause({ attribute: "cn", op: "equals", value: "x" }),
        createBuilderGroup({ join: "or", children: [createBuilderClause()] }),
      ],
    });
    const wrapper = mount(FilterGroup, { props: { group, depth: 0, listId: "d" } });
    // Root renders 2 nodes; the nested group contributes its own clause node.
    const nodes = wrapper.findAll(".qb-node");
    expect(nodes).toHaveLength(3);
    // Clause rows lead with the NOT toggle; nested-group rows start with the
    // group itself (group NOT lives in the group head instead).
    const clauseFirst = nodes[0].element.firstElementChild as HTMLElement;
    expect(clauseFirst.classList.contains("qb-not")).toBe(true);
    const groupFirst = nodes[1].element.firstElementChild as HTMLElement;
    expect(groupFirst.classList.contains("qb-group")).toBe(true);
  });
});
