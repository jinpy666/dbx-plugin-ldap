// Ported from tiny-rdm ldapExporter.test.js (core cases).
import { describe, expect, it } from "vitest";
import {
  extractEntryAttributeNames,
  getEntryAttributeValues,
  serializeEntriesToCsv,
  serializeEntriesToJson,
} from "./ldapExporter";

const ENTRIES = [
  { dn: "cn=a,dc=com", attributes: { cn: ["a"], objectClass: ["top", "person"], mail: ["a@x", "a@y"] } },
  { dn: "cn=b,dc=com", attributes: { cn: ["b"], uid: "b" } },
];

describe("getEntryAttributeValues", () => {
  it("returns arrays for multivalued and scalars", () => {
    expect(getEntryAttributeValues(ENTRIES[0], "mail")).toEqual(["a@x", "a@y"]);
    expect(getEntryAttributeValues(ENTRIES[1], "uid")).toEqual(["b"]);
  });

  it("is case-insensitive", () => {
    expect(getEntryAttributeValues(ENTRIES[0], "CN")).toEqual(["a"]);
    expect(getEntryAttributeValues(ENTRIES[0], "MAIL")).toEqual(["a@x", "a@y"]);
  });

  it("returns empty for unknown attributes", () => {
    expect(getEntryAttributeValues(ENTRIES[0], "nope")).toEqual([]);
    expect(getEntryAttributeValues(ENTRIES[0], "")).toEqual([]);
  });
});

describe("extractEntryAttributeNames", () => {
  it("collects the union in first-seen order", () => {
    expect(extractEntryAttributeNames(ENTRIES)).toEqual(["cn", "objectClass", "mail", "uid"]);
  });
});

describe("serializeEntriesToCsv", () => {
  it("headers dn + attribute union, CRLF rows", () => {
    const csv = serializeEntriesToCsv(ENTRIES);
    const [header, rowA, rowB] = csv.split("\r\n");
    expect(header).toBe("dn,cn,objectClass,mail,uid");
    // dn contains a comma → RFC 4180 quoting
    // 多值拼接含 `|` 分隔符 → 加引号示意结构（见 multivalue separator quoting 用例）。
    expect(rowA).toBe('"cn=a,dc=com",a,"top|person","a@x|a@y",');
    expect(rowB).toBe('"cn=b,dc=com",b,,,b');
  });

  it("quotes cells containing separators or quotes", () => {
    const csv = serializeEntriesToCsv([{ dn: "cn=x", attributes: { note: ['has "quote"'] } }]);
    expect(csv.split("\r\n")[1]).toContain('"has ""quote"""');
  });

  it("supports pinned columns and no header", () => {
    const csv = serializeEntriesToCsv(ENTRIES, { columns: ["cn"], includeHeader: false });
    expect(csv.split("\r\n")[0]).toBe('"cn=a,dc=com",a');
  });

  it("resolves pinned columns case-insensitively", () => {
    const csv = serializeEntriesToCsv(ENTRIES, { columns: ["CN", "Mail"], includeHeader: false });
    expect(csv.split("\r\n")[0]).toBe('"cn=a,dc=com",a,"a@x|a@y"');
  });
});

describe("serializeEntriesToJson", () => {
  it("normalises to dn + attributes shape", () => {
    const json = serializeEntriesToJson([{ DN: "cn=x", attrs: { cn: "x" } }]);
    expect(JSON.parse(json)).toEqual([{ dn: "cn=x", attributes: { cn: "x" } }]);
  });

  it("pretty-prints by default", () => {
    expect(serializeEntriesToJson([{ dn: "d", attributes: {} }], { pretty: false })).toBe('[{"dn":"d","attributes":{}}]');
    expect(serializeEntriesToJson([{ dn: "d", attributes: {} }])).toContain('\n');
  });
});

describe("serializeEntriesToCsv formula injection", () => {
  it("neutralises spreadsheet formula prefixes in cells", () => {
    const csv = serializeEntriesToCsv([
      {
        dn: "cn=x",
        attributes: {
          note: "=cmd|'/c calc'!A0",
          desc: "+SUM(A1)",
          title: "-not_a_flag",
          mail: "@evil",
        },
      },
    ]);
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+SUM(A1)");
    expect(csv).toContain("'-not_a_flag");
    expect(csv).toContain("'@evil");
  });
});

describe("serializeEntriesToCsv formula injection scope", () => {
  it("preserves negative numbers and E.164 phone prefixes", () => {
    const csv = serializeEntriesToCsv([
      { dn: "cn=x", attributes: { num: "-5", phone: "+8613800000000" } },
    ]);
    expect(csv).toContain(",-5");
    expect(csv).toContain(",+8613800000000");
  });

  it("still neutralises executable +/- operands", () => {
    const csv = serializeEntriesToCsv([
      { dn: "cn=x", attributes: { f1: "+A1", f2: "-SUM(A1)" } },
    ]);
    expect(csv).toContain("'+A1");
    expect(csv).toContain("'-SUM(A1)");
  });
});

describe("extractEntryAttributeNames case-insensitive union", () => {
  it("dedupes case-variant attribute names across entries (keeps first spelling)", () => {
    expect(
      extractEntryAttributeNames([
        { dn: "cn=a,dc=x", attributes: { cn: ["a"], mail: ["a@x"] } },
        { dn: "cn=b,dc=x", attributes: { CN: ["b"], Mail: ["b@x"] } },
      ]),
    ).toEqual(["cn", "mail"]);
    // 两列不会各自填同一份值（旧实现产出 dn,cn,mail,CN,Mail 五列）。
  });
});

describe("serializeEntriesToCsv multivalue separator quoting", () => {
  it("quotes cells containing the multivalue separator so structure is visible", () => {
    const csv = serializeEntriesToCsv([{ dn: "cn=a,dc=x", attributes: { cn: ["a|b"] } }]);
    // 单值 a|b 现在被引号包裹：与无结构文本可区分（彻底区分多值仍是已知限制）。
    expect(csv).toContain('"a|b"');
  });
});
