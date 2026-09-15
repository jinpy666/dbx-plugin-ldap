// lib/builtinSchema 单测：内置兜底表——常用属性语法信息、别名索引、
// 常用对象类 must/may、展示名清单。
import { describe, expect, it } from "vitest";
import { LDAP_SYNTAX } from "./valueKinds";
import { BUILTIN_ATTRIBUTES, BUILTIN_OBJECT_CLASSES, builtinAttributeInfo, builtinAttributeNames } from "./builtinSchema";

describe("BUILTIN_ATTRIBUTES", () => {
  it("indexes definitions by lowercase name with alias keys", () => {
    expect(BUILTIN_ATTRIBUTES["cn"].name).toBe("commonName");
    expect(BUILTIN_ATTRIBUTES["commonname"].names).toContain("commonName");
    expect(BUILTIN_ATTRIBUTES["sn"].name).toBe("surname");
    expect(BUILTIN_ATTRIBUTES["userid"].name).toBe("uid");
  });

  it("carries syntax semantics for kind-driving attributes", () => {
    expect(BUILTIN_ATTRIBUTES["createtimestamp"].syntax).toBe(LDAP_SYNTAX.generalizedTime);
    expect(BUILTIN_ATTRIBUTES["entryuuid"].syntax).toBe(LDAP_SYNTAX.uuid);
    expect(BUILTIN_ATTRIBUTES["member"].syntax).toBe(LDAP_SYNTAX.dn);
    expect(BUILTIN_ATTRIBUTES["uidnumber"].syntax).toBe(LDAP_SYNTAX.integer);
    expect(BUILTIN_ATTRIBUTES["supportedcontrol"].syntax).toBe(LDAP_SYNTAX.oid);
    expect(BUILTIN_ATTRIBUTES["objectguid"].noUserModification).toBe(true);
  });

  it("builtinAttributeInfo resolves aliases case-insensitively", () => {
    expect(builtinAttributeInfo("MAIL")?.name).toBe("mail");
    expect(builtinAttributeInfo("  uidNumber ")).toBeDefined();
    expect(builtinAttributeInfo("noSuchAttribute")).toBeUndefined();
  });
});

describe("BUILTIN_OBJECT_CLASSES", () => {
  it("covers core / posix / AD shapes with must attributes", () => {
    expect(BUILTIN_OBJECT_CLASSES["person"].must).toEqual(["sn", "cn"]);
    expect(BUILTIN_OBJECT_CLASSES["posixaccount"].must).toContain("homeDirectory");
    expect(BUILTIN_OBJECT_CLASSES["organizationalunit"].must).toEqual(["ou"]);
  });

  it("keeps auxiliary attributes in may lists", () => {
    expect(BUILTIN_OBJECT_CLASSES["inetorgperson"].may).toContain("jpegPhoto");
    expect(BUILTIN_OBJECT_CLASSES["posixgroup"].may).toContain("memberUid");
  });
});

describe("builtinAttributeNames", () => {
  it("returns deduplicated display names", () => {
    const names = builtinAttributeNames();
    const lower = names.map((name) => name.toLowerCase());
    expect(new Set(lower).size).toBe(names.length);
    expect(names).toContain("objectClass");
    expect(names).toContain("sAMAccountName");
  });
});
