import { describe, expect, it } from "vitest";
import { missingRequiredAttributes, validateValueKind } from "./entryValidation";
import type { AttributeValueKind } from "./valueKinds";

const person = { objectClass: ["top", "person"], cn: ["Alice"], sn: ["A"] };

describe("editor MUST preflight", () => {
  it("requires objectClass and known MUST attributes for new entries", () => {
    expect(missingRequiredAttributes({})).toEqual(["objectClass"]);
    expect(missingRequiredAttributes({ objectClass: ["person"] })).toEqual(["cn", "sn"]);
  });

  it("detects removal or blanking of a previously visible required value", () => {
    expect(missingRequiredAttributes({ ...person, sn: [] }, person)).toEqual(["sn"]);
    expect(missingRequiredAttributes({ ...person, objectClass: [" "] }, person)).toEqual(["objectClass"]);
  });

  it("does not demand existing MUST attributes that were hidden or unreadable", () => {
    const partial = { objectClass: ["person", "simpleSecurityObject"], cn: ["Alice"] };
    expect(missingRequiredAttributes({ ...partial, description: ["Updated"] }, partial)).toEqual([]);
  });

  it("tracks newly introduced requirements and releases them when a class is removed", () => {
    expect(missingRequiredAttributes({ ...person, objectClass: ["person", "groupOfNames"] }, person)).toEqual(["member"]);
    expect(missingRequiredAttributes(person, person)).toEqual([]);
    expect(missingRequiredAttributes({ ...person, objectClass: ["person", "simpleSecurityObject"] }, person)).toEqual([]);
  });

  it("matches case and attribute options without changing their values", () => {
    expect(missingRequiredAttributes({ OBJECTCLASS: ["PERSON"], "CN;lang-en": ["Alice"], SN: ["A"] })).toEqual([]);
  });

  it("uses custom schema MUST and SUP inheritance", () => {
    const schema = {
      objectClassAttributes: { child: { must: [], may: [] }, parent: { must: ["employeeNumber"], may: [] } },
      rawObjectClasses: ["( 1.2.3 NAME 'child' SUP parent STRUCTURAL )"],
    };
    expect(missingRequiredAttributes({ objectClass: ["child"] }, undefined, schema)).toEqual(["employeeNumber"]);
  });
});

describe("validateValueKind", () => {
  it("passes well-formed integer values and rejects non-integers", () => {
    expect(validateValueKind("integer", "123")).toBeNull();
    expect(validateValueKind("integer", "-42")).toBeNull();
    const warning = validateValueKind("integer", "12.5");
    expect(warning).toEqual({ key: "editor.valueKindWarning", params: { kind: "integer" } });
    expect(validateValueKind("integer", "12a")).not.toBeNull();
  });

  it("accepts only uppercase TRUE/FALSE booleans", () => {
    expect(validateValueKind("boolean", "TRUE")).toBeNull();
    expect(validateValueKind("boolean", "FALSE")).toBeNull();
    expect(validateValueKind("boolean", "true")).not.toBeNull();
  });

  it("delegates datetime checks to the GeneralizedTime parser", () => {
    expect(validateValueKind("datetime", "20240102030405Z")).toBeNull();
    expect(validateValueKind("datetime", "20240102030405+0800")).toBeNull();
    expect(validateValueKind("datetime", "2024-01-02")).not.toBeNull();
    // 日历非法（2 月 31 日）也算不通过。
    expect(validateValueKind("datetime", "20240231000000Z")).not.toBeNull();
  });

  it("uses the DN heuristics for dn values", () => {
    expect(validateValueKind("dn", "cn=alice,dc=example,dc=com")).toBeNull();
    expect(validateValueKind("dn", "not a dn")).not.toBeNull();
  });

  it("requires plain digits for AD FILETIME", () => {
    expect(validateValueKind("filetime", "133630080000000000")).toBeNull();
    expect(validateValueKind("filetime", "1.3e17")).not.toBeNull();
  });

  it("checks RFC 4122 UUID shape", () => {
    expect(validateValueKind("uuid", "550e8400-e29b-41d4-a716-446655440000")).toBeNull();
    expect(validateValueKind("uuid", "{550e8400-e29b-41d4-a716-446655440000}")).not.toBeNull();
  });

  it("requires dotted-decimal OIDs", () => {
    expect(validateValueKind("oid", "2.16.840.1.113730.3.4.2")).toBeNull();
    expect(validateValueKind("oid", "control-oid")).not.toBeNull();
  });

  it("skips kinds without a strict shape and tolerates blank values", () => {
    for (const kind of ["text", "binary", "uac", "guid", "sid"] as const) {
      expect(validateValueKind(kind, "anything at all")).toBeNull();
    }
    // password 不是 valueKinds 注册表的 kind（编辑器层特判），default 分支容错。
    expect(validateValueKind("password" as AttributeValueKind, "anything at all")).toBeNull();
    expect(validateValueKind("integer", "")).toBeNull();
    expect(validateValueKind("integer", "   ")).toBeNull();
  });
});
