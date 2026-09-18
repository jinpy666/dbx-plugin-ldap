// @vitest-environment happy-dom
// WorkbenchToolbar 组件测试：只读门禁——导入是写入口，按钮受 canWrite 控制
//（与 DnTree 菜单 / ResultTable 批量条同语义）；只读时禁用且不发出 openImport。
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import WorkbenchToolbar from "./WorkbenchToolbar.vue";
import { t } from "../lib/i18n";

const tracked: VueWrapper[] = [];

function mountToolbar(props: { canWrite?: boolean; ready?: boolean } = {}) {
  const wrapper = mount(WorkbenchToolbar, {
    props: {
      ready: props.ready ?? true,
      showSpinner: false,
      identityText: "ldap://demo",
      protocolBadge: "LDAP",
      serverBadge: "",
      canWrite: props.canWrite ?? true,
      recentEntries: [],
      exportable: false,
      exportTitle: "",
    },
  });
  tracked.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const importButton = (wrapper: VueWrapper) => {
  const label = t("ldap.importEntry.toolbar");
  const button = wrapper.findAll("button").find((b) => b.text() === label);
  if (!button) throw new Error(`import button not found (label=${label})`);
  return button;
};

describe("WorkbenchToolbar", () => {
  it("keeps the import button enabled and clickable when writable", async () => {
    const wrapper = mountToolbar({ canWrite: true });
    const button = importButton(wrapper);
    expect((button.element as HTMLButtonElement).disabled).toBe(false);
    await button.trigger("click");
    expect(wrapper.emitted("openImport")).toHaveLength(1);
  });

  it("disables the import button for read-only connections", async () => {
    const wrapper = mountToolbar({ canWrite: false });
    const button = importButton(wrapper);
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    await button.trigger("click");
    expect(wrapper.emitted("openImport")).toBeUndefined();
  });
});
