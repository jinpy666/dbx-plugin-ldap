// lib/valueKinds 纯函数单测：值类型注册表（对齐 Apache Directory Studio
// plugins/valueeditors/plugin.xml 绑定表）——属性名绑定优先、语法 OID 次之、
// text 兜底；名字绑定修正 schema 语法不准的 ADS 场景（entryUUID 等）。
import { describe, expect, it } from "vitest";
import { LDAP_SYNTAX, attributeValueKind, isBinaryKind } from "./valueKinds";

describe("attributeValueKind name bindings", () => {
  it("binds AD FILETIME attributes by name (ADS ActiveDirectoryTimeValueEditor set)", () => {
    for (const name of ["pwdLastSet", "accountExpires", "lastLogoff", "lastLogon", "lastLogonTimestamp", "badPasswordTime", "lockoutTime"]) {
      expect(attributeValueKind(name)).toBe("filetime");
    }
    // 大小写不敏感
    expect(attributeValueKind("PWDLASTSET")).toBe("filetime");
  });

  it("binds MSAD binary identifiers by name even when schema says octetString", () => {
    expect(attributeValueKind("objectGUID", { syntax: LDAP_SYNTAX.octetString })).toBe("guid");
    expect(attributeValueKind("objectSid", { syntax: LDAP_SYNTAX.octetString })).toBe("sid");
  });

  it("binds entryUUID by name over an inaccurate octetString schema syntax (ADS rationale)", () => {
    expect(attributeValueKind("entryUUID", { syntax: LDAP_SYNTAX.octetString })).toBe("uuid");
    expect(attributeValueKind("ipauniqueid")).toBe("uuid");
  });

  it("binds supported* operational attributes as OID", () => {
    for (const name of ["supportedControl", "supportedExtension", "supportedFeatures", "supportedCapabilities"]) {
      expect(attributeValueKind(name)).toBe("oid");
    }
  });

  it("binds userAccountControl to the uac bitmask kind even with integer schema syntax", () => {
    expect(attributeValueKind("userAccountControl", { syntax: LDAP_SYNTAX.integer })).toBe("uac");
  });

  it("falls back to common DN reference names when schema is unavailable", () => {
    expect(attributeValueKind("member")).toBe("dn");
    expect(attributeValueKind("memberOf")).toBe("dn");
    expect(attributeValueKind("manager")).toBe("dn");
    expect(attributeValueKind("distinguishedName")).toBe("dn");
  });

  it("applies suffix rules for certificate/photo families", () => {
    expect(attributeValueKind("userCertificate", { syntax: LDAP_SYNTAX.octetString })).toBe("binary");
    expect(attributeValueKind("x509Certificate")).toBe("binary");
    expect(attributeValueKind("thumbnailPhoto")).toBe("binary");
  });
});

describe("attributeValueKind syntax bindings", () => {
  it("binds RFC syntax OIDs to kinds", () => {
    expect(attributeValueKind("someTime", { syntax: LDAP_SYNTAX.generalizedTime })).toBe("datetime");
    expect(attributeValueKind("someTime", { syntax: LDAP_SYNTAX.utcTime })).toBe("datetime");
    expect(attributeValueKind("someRef", { syntax: LDAP_SYNTAX.dn })).toBe("dn");
    expect(attributeValueKind("someRef", { syntax: LDAP_SYNTAX.nameAndOptionalUID })).toBe("dn");
    expect(attributeValueKind("someFlag", { syntax: LDAP_SYNTAX.boolean })).toBe("boolean");
    expect(attributeValueKind("someInt", { syntax: LDAP_SYNTAX.integer })).toBe("integer");
    expect(attributeValueKind("someOid", { syntax: LDAP_SYNTAX.oid })).toBe("oid");
    expect(attributeValueKind("someId", { syntax: LDAP_SYNTAX.uuid })).toBe("uuid");
  });

  it("does NOT mistake IA5 String (.26) for a time syntax (mail/uid/dc are IA5)", () => {
    // 回归：UTC Time 是 .53；.26 = IA5 String 必须保持 text
    expect(LDAP_SYNTAX.utcTime).toBe("1.3.6.1.4.1.1466.115.121.1.53");
    expect(attributeValueKind("mail", { syntax: LDAP_SYNTAX.ia5String })).toBe("text");
    expect(attributeValueKind("uid", { syntax: "1.3.6.1.4.1.1466.115.121.1.26" })).toBe("text");
  });

  it("maps octetString to binary (guid/sid names already captured earlier)", () => {
    expect(attributeValueKind("someOpaque", { syntax: LDAP_SYNTAX.octetString })).toBe("binary");
  });

  it("strips nothing here — caller passes bare OID; {len} suffix falls back to text", () => {
    // 后端已剥离 {len}；此处守卫“带修饰的 OID 不参与精确匹配”的契约
    expect(attributeValueKind("dirString", { syntax: `${LDAP_SYNTAX.integer}{64}` })).toBe("text");
  });
});

describe("attributeValueKind fallback", () => {
  it("returns text for unknown names without syntax info", () => {
    expect(attributeValueKind("description")).toBe("text");
    expect(attributeValueKind("", undefined)).toBe("text");
    expect(attributeValueKind("sn", { equality: "caseIgnoreMatch" })).toBe("text");
  });

  it("name binding wins over syntax binding (ADS ValueEditorManager order)", () => {
    // entryUUID 在部分服务器 schema 中是 octetString → 名字绑定修正
    expect(attributeValueKind("entryUUID", { syntax: LDAP_SYNTAX.octetString })).toBe("uuid");
  });
});

describe("isBinaryKind", () => {
  it("treats binary/guid/sid as binary-backed kinds", () => {
    expect(isBinaryKind("binary")).toBe(true);
    expect(isBinaryKind("guid")).toBe(true);
    expect(isBinaryKind("sid")).toBe(true);
    expect(isBinaryKind("text")).toBe(false);
    expect(isBinaryKind("integer")).toBe(false);
  });
});
