// @vitest-environment happy-dom
// SchemaPanel workbench UI tests (M5-a UI test track): load-on-open via the
// schema cache, keyword filtering over the active category, empty/error/loading
// states, forced refresh (refresh=true bypass) and close affordances, plus the
// F2b five-category tabs (matching rules / uses / syntaxes).
// ldapApi is mocked in-file; no host bridge or network is involved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ldapApi, type SchemaResult } from "../lib/api";

vi.mock("../lib/api", () => ({
  ldapApi: {
    schema: vi.fn(),
  },
}));

import SchemaPanel from "./SchemaPanel.vue";
import { resetSchemaCacheForTests } from "../lib/schemaCache";

const schemaMock = vi.mocked(ldapApi.schema);

const SCHEMA_PAYLOAD: SchemaResult = {
  attributeTypes: ["( 1.2.3 NAME 'cn' DESC 'common name' )", "( 1.2.4 NAME ( 'uid' 'userId' ) )"],
  objectClasses: ["( 1.2.5 NAME 'person' MUST ( cn $ sn ) MAY ( userPassword $ telephoneNumber ) )"],
};

interface PanelProps {
  open: boolean;
  connectionId?: string;
}

function mountPanel(props: PanelProps) {
  return mount(SchemaPanel, { props: { connectionId: "conn-1", ...props } });
}

type PanelWrapper = Awaited<ReturnType<typeof mountPanel>>;

const tracked: PanelWrapper[] = [];

function trackPanel(props: PanelProps): PanelWrapper {
  const wrapper = mountPanel(props);
  tracked.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

beforeEach(() => {
  // J-8：schema 缓存为模块级共享单例，清空以保证每个用例都从冷缓存拉取。
  resetSchemaCacheForTests();
  schemaMock.mockReset();
  schemaMock.mockResolvedValue(SCHEMA_PAYLOAD);
});

const searchInput = (wrapper: PanelWrapper) => wrapper.find(".settings-field input");
const refreshButton = (wrapper: PanelWrapper) => wrapper.find(".settings-field .toolbar-button");
const columns = (wrapper: PanelWrapper) => wrapper.findAll(".schema-col");
// F2b 分类页签：切换分类后列表列（columns[0]）随之变化，明细列始终在末列。
const tabs = (wrapper: PanelWrapper) => wrapper.findAll("[role='tab']");
async function activateTab(wrapper: PanelWrapper, label: string) {
  const tab = tabs(wrapper).find((item) => item.text() === label);
  expect(tab, `tab "${label}" should exist`).toBeDefined();
  await tab!.trigger("click");
}
// 明细卡（Master-Details 末列）。
const detailsPane = (wrapper: PanelWrapper) => wrapper.find(".schema-detail-col");
const pressEscape = () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

describe("SchemaPanel", () => {
  it("renders nothing and loads nothing while closed", () => {
    const wrapper = trackPanel({ open: false });
    expect(wrapper.find(".modal-backdrop").exists()).toBe(false);
    expect(schemaMock).not.toHaveBeenCalled();
  });

  it("loads the schema on open and renders the active category list (F2b 页签化)", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    expect(schemaMock).toHaveBeenCalledTimes(1);
    expect(schemaMock).toHaveBeenNthCalledWith(1, false);
    expect(wrapper.find("h2").text()).toBe("Schema");
    // 默认页签为属性类型；旧 payload 不含三类定义 → 仅两个基础页签。
    expect(tabs(wrapper).map((tab) => tab.text())).toEqual(["属性类型", "对象类"]);
    expect(columns(wrapper)[0].find("h3").text()).toBe("属性类型 (3)");
    expect(columns(wrapper)[0].findAll("li").map((li) => li.text())).toEqual(["cn", "uid", "userId"]);
    // 切到对象类页签：MUST/MAY 列表照旧渲染。
    await activateTab(wrapper, "对象类");
    expect(columns(wrapper)[0].find("h3").text()).toBe("对象类 (1)");
    expect(columns(wrapper)[0].find("strong").text()).toBe("person");
    expect(columns(wrapper)[0].findAll(".schema-def")[0].text()).toBe("必填（MUST）: cn, sn");
    expect(columns(wrapper)[0].findAll(".schema-def")[1].text()).toBe("可选（MAY）: userPassword, telephoneNumber");
  });

  it("filters the active list by keyword and shows the no-match fallback for zero hits (P2-4)", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    await searchInput(wrapper).setValue("uid");
    // 关键字按属性名（含别名逐个列出）做子串匹配："userid" 不含 "uid"，
    // 只有 uid 本名命中；userId 用 "user" 前缀可查到。
    expect(columns(wrapper)[0].find("h3").text()).toBe("属性类型 (1)");
    expect(columns(wrapper)[0].findAll("li").map((li) => li.text())).toEqual(["uid"]);
    // 对象类页签 0 命中时不再误显"Schema 为空"，而是"无匹配"（P2-4）。
    await activateTab(wrapper, "对象类");
    expect(columns(wrapper)[0].text()).toContain("没有匹配“uid”的定义");
    await searchInput(wrapper).setValue("");
    expect(columns(wrapper)[0].find("strong").text()).toBe("person");
  });

  it("distinguishes no-match from an empty schema (P2-4)", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    await searchInput(wrapper).setValue("zzz");
    expect(columns(wrapper)[0].text()).toContain("没有匹配“zzz”的定义");
    await activateTab(wrapper, "对象类");
    expect(columns(wrapper)[0].text()).toContain("没有匹配“zzz”的定义");
    expect(columns(wrapper)[0].text()).not.toContain("Schema 为空");
  });

  it("shows the empty state in both tabs and hides the extra tabs when the server has no definitions", async () => {
    schemaMock.mockResolvedValue({ attributeTypes: [], objectClasses: [] });
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    expect(columns(wrapper)[0].find("h3").text()).toBe("属性类型 (0)");
    expect(columns(wrapper)[0].text()).toContain("Schema 为空");
    await activateTab(wrapper, "对象类");
    expect(columns(wrapper)[0].find("h3").text()).toBe("对象类 (0)");
    expect(columns(wrapper)[0].text()).toContain("Schema 为空");
    // 旧 sidecar 未透出三类定义 → 对应页签隐藏（F2b）。
    expect(tabs(wrapper).map((tab) => tab.text())).toEqual(["属性类型", "对象类"]);
  });

  it("does not display OID-only attribute definitions", async () => {
    schemaMock.mockResolvedValue({
      attributeTypes: [
        { oid: "1.2.840.113556.1.4.221", name: "1.2.840.113556.1.4.221", names: [] },
        { oid: "2.5.4.3", name: "cn", names: ["cn"] },
      ],
      objectClasses: [],
    });
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    expect(columns(wrapper)[0].find("h3").text()).toBe("属性类型 (1)");
    expect(columns(wrapper)[0].findAll("li").map((li) => li.text())).toEqual(["cn"]);
    expect(columns(wrapper)[0].text()).not.toContain("1.2.840.113556.1.4.221");
  });

  it("emits error when the initial load fails", async () => {
    schemaMock.mockRejectedValue(new Error("schema boom"));
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    expect(wrapper.emitted("error")?.[0]).toEqual(["schema boom"]);
    expect(wrapper.find(".modal-backdrop").exists()).toBe(true);
  });

  it("marks the refresh icon while a load is in flight", async () => {
    let resolveSchema!: (value: SchemaResult) => void;
    schemaMock.mockImplementation(() => new Promise<SchemaResult>((resolve) => (resolveSchema = resolve)));
    const wrapper = trackPanel({ open: true });
    // loader 经动态 import 调 ldapApi.schema：先 flushPromises 让请求真正
    // 发起（promise 仍 pending，loading 保持 true），再解析。
    await flushPromises();
    expect(wrapper.find(".spinning").exists()).toBe(true);
    resolveSchema(SCHEMA_PAYLOAD);
    await flushPromises();
    expect(wrapper.find(".spinning").exists()).toBe(false);
  });

  it("forces a server round-trip on the refresh button", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    expect(schemaMock).toHaveBeenCalledTimes(1);
    await refreshButton(wrapper).trigger("click");
    await flushPromises();
    expect(schemaMock).toHaveBeenNthCalledWith(2, true);
    expect(schemaMock).toHaveBeenNthCalledWith(3, false);
    expect(columns(wrapper)[0].findAll("li")).toHaveLength(3);
  });

  it("emits error when the forced refresh fails", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    schemaMock.mockRejectedValueOnce(new Error("refresh boom"));
    await refreshButton(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.emitted("error")?.[0]).toEqual(["refresh boom"]);
  });

  it("closes via ✕, footer close and backdrop self-click, not via clicks inside", async () => {
    const wrapper = trackPanel({ open: true });
    await wrapper.find(".modal").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    await wrapper.find(".icon-button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    await wrapper.find("footer button").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(2);
    await wrapper.find(".modal-backdrop").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(3);
  });

  it("closes via Escape once open", async () => {
    const wrapper = trackPanel({ open: false });
    await wrapper.setProps({ open: true });
    await wrapper.vm.$nextTick();
    pressEscape();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});

// -- 明细栏（Master-Details）：选中定义的 OID/语法/匹配规则/值类型、
//    objectClass 的 MUST/MAY/SUP 链与反向引用。fixture 独立于全局
//    SCHEMA_PAYLOAD（既有列计数断言依赖它，不能加行）。
describe("SchemaPanel details pane", () => {
  // inetOrgPerson 的 MAY 引用 employeeNumber（attributeType 反向引用），
  // 其 SUP person（objectClass 反向引用 + SUP 链 person → top）。
  const DETAILS_PAYLOAD: SchemaResult = {
    attributeTypes: [
      "( 1.2.7 NAME 'employeeNumber' DESC 'numerically identifies an employee' SYNTAX 1.3.6.1.4.1.1466.115.121.1.27 EQUALITY caseIgnoreMatch SINGLE-VALUE )",
      "( 1.2.9 NAME 'seeAlso' SYNTAX 1.3.6.1.4.1.1466.115.121.1.12 )",
    ],
    objectClasses: [
      "( 1.2.5 NAME 'person' DESC 'RFC4519 person' SUP top MUST ( cn $ sn ) MAY ( userPassword $ seeAlso ) )",
      "( 1.2.6 NAME 'inetOrgPerson' SUP person MAY ( employeeNumber ) )",
    ],
  };

  beforeEach(() => {
    schemaMock.mockResolvedValue(DETAILS_PAYLOAD);
  });

  it("shows a placeholder before any definition is selected", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    expect(detailsPane(wrapper).exists()).toBe(true);
    // UX-V2：未选中占位是"选择左侧定义查看明细"，而非误导性的"Schema 为空"。
    expect(detailsPane(wrapper).text()).toContain("选择左侧定义查看明细");
    expect(detailsPane(wrapper).text()).not.toContain("Schema 为空");
  });

  it("shows syntax, equality, value kind and referencing class for a selected attributeType", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    const button = columns(wrapper)[0].findAll("button").find((item) => item.text() === "employeeNumber")!;
    await button.trigger("click");
    const details = detailsPane(wrapper).text();
    expect(details).toContain("1.2.7");
    expect(details).toContain("1.3.6.1.4.1.1466.115.121.1.27");
    expect(details).toContain("caseIgnoreMatch");
    // 值类型由 attributeValueKind 推导：integer 语法 OID → integer。
    expect(details).toContain("integer");
    // 反向引用：employeeNumber 被 inetOrgPerson 的 MAY 引用。
    expect(details).toContain("inetOrgPerson");
    // 选中属性与选中类互斥：未选类时 objectClass 明细不渲染。
    expect(details).not.toContain("RFC4519 person");
  });

  it("shows MUST, MAY, the SUP chain and referencing classes for a selected objectClass", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    // F2b 页签化：对象类列表需先切到对应页签（列表列即 columns[0]）。
    await activateTab(wrapper, "对象类");
    const personRow = columns(wrapper)[0].findAll("li").find((item) => item.text().startsWith("person"))!;
    await personRow.trigger("click");
    const details = detailsPane(wrapper).text();
    expect(details).toContain("1.2.5");
    expect(details).toContain("RFC4519 person");
    expect(details).toContain("cn, sn");
    expect(details).toContain("userPassword");
    // SUP 链沿 superior 逐级展开：person → top。
    expect(details).toContain("top");
    // 反向引用：person 被 inetOrgPerson 的 SUP 引用。
    expect(details).toContain("inetOrgPerson");
  });
});

// -- 五分类页签（F2b）：三类补充定义的页签可见性、列表选中交互与明细卡。
//    fixture 独立于全局 SCHEMA_PAYLOAD（列计数断言依赖它，不能加行）。
describe("SchemaPanel five-category tabs (F2b)", () => {
  const F2B_PAYLOAD: SchemaResult = {
    attributeTypes: ["( 1.2.3 NAME 'cn' DESC 'common name' )"],
    objectClasses: ["( 1.2.5 NAME 'person' SUP top )"],
    matchingRules: [{ oid: "2.5.13.2", names: ["caseIgnoreMatch"], desc: "case ignore match", syntax: "1.3.6.1.4.1.1466.115.121.1.15" }],
    matchingRuleUses: [{ oid: "2.5.13.5", names: ["caseExactMatch"], attributeTypes: ["cn", "sn"] }],
    ldapSyntaxes: [{ oid: "1.3.6.1.4.1.1466.115.121.1.12", desc: "LDAP DN" }],
  };

  beforeEach(() => {
    schemaMock.mockResolvedValue(F2B_PAYLOAD);
  });

  it("shows all five tabs when the sidecar returns the three extra categories", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    expect(tabs(wrapper).map((tab) => tab.text())).toEqual(["属性类型", "对象类", "匹配规则", "匹配规则用途", "LDAP 语法"]);
  });

  it("hides the three extra tabs when the sidecar omits them (旧 sidecar 兼容)", async () => {
    // 覆盖内层 beforeEach：回退到不含三类的基线 payload。
    schemaMock.mockResolvedValue(SCHEMA_PAYLOAD);
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    expect(tabs(wrapper).map((tab) => tab.text())).toEqual(["属性类型", "对象类"]);
  });

  it("lists matching rules and shows OID/NAME/DESC/syntax in the detail card", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    await activateTab(wrapper, "匹配规则");
    expect(columns(wrapper)[0].find("h3").text()).toBe("匹配规则 (1)");
    await columns(wrapper)[0].find("button.schema-attribute-button").trigger("click");
    const details = detailsPane(wrapper).text();
    expect(details).toContain("2.5.13.2");
    expect(details).toContain("caseIgnoreMatch");
    expect(details).toContain("case ignore match");
    // 语法 OID 出现在明细卡（SYNTAX 行）。
    expect(details).toContain("1.3.6.1.4.1.1466.115.121.1.15");
  });

  it("shows the applies-to attribute list for a selected matching rule use", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    await activateTab(wrapper, "匹配规则用途");
    expect(columns(wrapper)[0].find("h3").text()).toBe("匹配规则用途 (1)");
    await columns(wrapper)[0].find("button.schema-attribute-button").trigger("click");
    const details = detailsPane(wrapper).text();
    expect(details).toContain("2.5.13.5");
    expect(details).toContain("caseExactMatch");
    // 适用于属性列表（schema.applies 键）：cn、sn 逗号连接。
    expect(details).toContain("适用于属性");
    expect(details).toContain("cn, sn");
  });

  it("shows OID and description for a selected LDAP syntax", async () => {
    const wrapper = trackPanel({ open: true });
    await flushPromises();
    await activateTab(wrapper, "LDAP 语法");
    expect(columns(wrapper)[0].find("h3").text()).toBe("LDAP 语法 (1)");
    await columns(wrapper)[0].find("button.schema-attribute-button").trigger("click");
    const details = detailsPane(wrapper).text();
    expect(details).toContain("1.3.6.1.4.1.1466.115.121.1.12");
    expect(details).toContain("LDAP DN");
  });
});
