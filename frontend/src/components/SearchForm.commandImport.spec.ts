// @vitest-environment happy-dom
// SearchForm ldapsearch command import (M5-a UI test track): paste a
// documented command, apply it onto the form fields, surface dropped
// bind/connection options and parse failures. Network calls (presets/schema)
// reject harmlessly without a dbxPlugin host bridge.
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SearchForm from "./SearchForm.vue";

async function mountForm() {
  const wrapper = mount(SearchForm, { props: { baseDn: "dc=demo,dc=dbx" } });
  await wrapper.vm.$nextTick();
  return wrapper;
}

async function openCommandPanel(wrapper: Awaited<ReturnType<typeof mountForm>>) {
  await wrapper.find(".command-import > button").trigger("click");
  return wrapper.find(".command-import textarea");
}

const baseInput = (wrapper: Awaited<ReturnType<typeof mountForm>>) => wrapper.find("input.mono");
const scopeSelect = (wrapper: Awaited<ReturnType<typeof mountForm>>) => wrapper.find("select");

describe("SearchForm ldapsearch command import", () => {
  it("fills the search fields from a documented command and reports dropped bind options", async () => {
    const wrapper = await mountForm();
    const textarea = await openCommandPanel(wrapper);
    await textarea.setValue(
      'ldapsearch -x -LLL -H ldap://ldap.example.com -D "cn=admin,dc=example,dc=com" -w secret -b "dc=example,dc=com" -s one -z 100 "(uid=jin)" mail cn',
    );
    await wrapper.find(".command-actions button").trigger("click");
    expect((baseInput(wrapper).element as HTMLInputElement).value).toBe("dc=example,dc=com");
    expect((scopeSelect(wrapper).element as HTMLSelectElement).value).toBe("one");
    expect((wrapper.findAll(".search-extra input")[0].element as HTMLInputElement).value).toBe("mail, cn");
    expect((wrapper.findAll(".search-extra input")[1].element as HTMLInputElement).value).toBe("100");
    expect(wrapper.find(".qb-preview").text()).toBe("(uid=jin)");
    expect(wrapper.find(".command-warn").text()).toContain("-H");
    expect(wrapper.emitted("notify")).toHaveLength(1);
  });

  it("surfaces parse failures without touching the current form values", async () => {
    const wrapper = await mountForm();
    const textarea = await openCommandPanel(wrapper);
    await textarea.setValue("ldapsearch -f filters.txt");
    await wrapper.find(".command-actions button").trigger("click");
    expect(wrapper.find(".command-import .form-error").exists()).toBe(true);
    expect((baseInput(wrapper).element as HTMLInputElement).value).toBe("dc=demo,dc=dbx");
    expect(wrapper.emitted("notify")).toBeUndefined();
  });

  it("applies the children scope as subtree with a warning note", async () => {
    const wrapper = await mountForm();
    const textarea = await openCommandPanel(wrapper);
    await textarea.setValue("ldapsearch -x -b dc=example,dc=com -s children");
    await wrapper.find(".command-actions button").trigger("click");
    expect((scopeSelect(wrapper).element as HTMLSelectElement).value).toBe("sub");
    expect(wrapper.findAll(".command-warn")).toHaveLength(2);
  });
});
