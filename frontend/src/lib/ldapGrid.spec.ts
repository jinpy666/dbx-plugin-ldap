// @vitest-environment happy-dom
// ldapGrid 纯函数测试：行/列映射（dn 首列、多值连接、保留字段防覆盖）、
// 单元格显示截断与 tooltip 上限、页大小与列布局持久化、ag-grid 七语文案键集。
import { beforeEach, describe, expect, it } from "vitest";
import {
  AG_GRID_LOCALE_KEYS,
  CELL_TEXT_LIMIT,
  CELL_TITLE_LIMIT,
  DEFAULT_PAGE_SIZE,
  agGridLocaleText,
  cellTitleText,
  copyRowText,
  joinValues,
  loadColumnState,
  loadPreferredPageSize,
  resultColumns,
  saveColumnState,
  savePreferredPageSize,
  toResultRows,
  truncateCellText,
} from "./ldapGrid";
import { workbenchLocale } from "./i18n";
import type { LdapEntry } from "./api";

beforeEach(() => {
  localStorage.clear();
  workbenchLocale.value = "zh-CN";
});

describe("toResultRows", () => {
  it("maps entries to row VMs with dn as the stable row id and joined multi-values", () => {
    const entries: LdapEntry[] = [
      { dn: "cn=alice,dc=demo,dc=dbx", attributes: { cn: ["alice"], mail: ["a@x", "b@x"] } },
      { dn: "cn=bob,dc=demo,dc=dbx", attributes: { cn: [] } },
    ];
    const rows = toResultRows(entries);
    expect(rows[0]).toMatchObject({ id: entries[0].dn, dn: entries[0].dn, cn: "alice", mail: "a@x | b@x" });
    // 空数组 → 空串（筛选面板的 blank 选项可命中）；缺列不落键（ag-grid 同样按空值过滤）
    expect(rows[1].cn).toBe("");
    expect(rows[1].mail).toBeUndefined();
  });

  it("never lets an attribute overwrite the reserved id/dn row fields", () => {
    const rows = toResultRows([{ dn: "cn=x,dc=demo,dc=dbx", attributes: { id: ["evil"], cn: ["x"] } }]);
    expect(rows[0].id).toBe("cn=x,dc=demo,dc=dbx");
    // 保留字段不落 VM，但列仍会渲染（值为空）
    expect(resultColumns(["id", "cn"]).map((def) => def.field)).toEqual(["dn", "cn"]);
  });
});

describe("copyRowText", () => {
  it("serializes the displayed row fields in order", () => {
    expect(copyRowText({ dn: "cn=alice", cn: "alice", mail: "a@example.com" }, ["dn", "cn", "mail"])).toBe("cn=alice\talice\ta@example.com");
    expect(copyRowText({ dn: "cn=alice" }, ["dn", "mail"])).toBe("cn=alice\t");
  });
});

describe("resultColumns", () => {
  it("puts dn first with an ascending default sort and makes every column filterable", () => {
    const defs = resultColumns(["objectClass", "cn", "mail"]);
    expect(defs.map((def) => def.field)).toEqual(["dn", "objectClass", "cn", "mail"]);
    expect(defs[0].sort).toBe("asc");
    for (const def of defs) {
      expect(def.sortable).toBe(true);
      expect(def.resizable).toBe(true);
      expect(def.filter).toBe("agTextColumnFilter");
    }
  });

  it("truncates the displayed cell text but keeps full values for filtering and tooltips", () => {
    const [dnCol, mailCol] = resultColumns(["mail"]);
    const long = "A".repeat(300);
    const formatCell = dnCol.valueFormatter as (params: { value?: unknown }) => string;
    expect(formatCell({ value: long })).toBe(`${"A".repeat(CELL_TEXT_LIMIT - 1)}…`);
    // 底层字段值是全文：文本筛选（contains）按全文匹配
    expect((mailCol as { tooltipValueGetter?: (params: { value?: unknown }) => string }).tooltipValueGetter?.({ value: long })).toBe(long);
  });

  it("caps the tooltip at 2000 characters and omits it for empty cells", () => {
    expect(cellTitleText("B".repeat(CELL_TITLE_LIMIT + 1))).toBe(`${"B".repeat(CELL_TITLE_LIMIT)}…`);
    expect(cellTitleText("")).toBe("");
    expect(truncateCellText("short")).toBe("short");
    expect(joinValues([])).toBe("");
  });
});

describe("pagination page size persistence", () => {
  it("stores and reloads the preferred page size per table key", () => {
    expect(loadPreferredPageSize("result")).toBe(DEFAULT_PAGE_SIZE);
    savePreferredPageSize("result", 100);
    expect(loadPreferredPageSize("result")).toBe(100);
    expect(loadPreferredPageSize("other")).toBe(DEFAULT_PAGE_SIZE);
  });

  it("ignores invalid stored values", () => {
    localStorage.setItem("dbx-ldap-grid-pagesize-result", "not-a-number");
    expect(loadPreferredPageSize("result")).toBe(DEFAULT_PAGE_SIZE);
    localStorage.setItem("dbx-ldap-grid-pagesize-result", "0");
    expect(loadPreferredPageSize("result")).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("column state persistence", () => {
  it("round-trips the column layout", () => {
    expect(loadColumnState("result")).toBeNull();
    saveColumnState("result", [{ colId: "dn", width: 220, hide: false }]);
    expect(loadColumnState("result")).toEqual([{ colId: "dn", width: 220, hide: false }]);
  });

  it("treats malformed payloads as absent", () => {
    localStorage.setItem("dbx-ldap-grid-colstate-result", "{oops");
    expect(loadColumnState("result")).toBeNull();
    localStorage.setItem("dbx-ldap-grid-colstate-result", JSON.stringify(["not-an-object"]));
    expect(loadColumnState("result")).toBeNull();
    localStorage.setItem("dbx-ldap-grid-colstate-result", JSON.stringify([{ width: 10 }]));
    expect(loadColumnState("result")).toBeNull(); // colId 缺失视为无效
  });
});

describe("agGridLocaleText", () => {
  it("covers the full locale key set for all seven workbench locales without gaps", () => {
    const locales = ["en", "zh-CN", "zh-TW", "es", "it", "ja", "pt-BR"] as const;
    for (const locale of locales) {
      workbenchLocale.value = locale;
      const text = agGridLocaleText();
      expect(Object.keys(text).sort()).toEqual([...AG_GRID_LOCALE_KEYS].sort());
      for (const value of Object.values(text)) expect(value.trim()).not.toBe("");
    }
    // 默认跟随工作台 locale：zh-CN 的过滤面板文案
    workbenchLocale.value = "zh-CN";
    expect(agGridLocaleText().filterOoo).toBe("过滤…");
  });
});
