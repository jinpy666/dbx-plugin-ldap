// lib/entryFormats 纯函数单测：格式识别（LDIF / PS Format-List）、LDIF 解析
// 复用、PS 块解析（属性行/续行/集合/字节数组）、PS→LDAP 名映射、计算属性
// 剔除、GUID/SID 显示串转 base64、多对象分块。
import { describe, expect, it } from "vitest";
import { bytesToBase64, base64ToBytes } from "./binaryValue";
import { detectEntryFormat, parseEntriesFromText, parsePowerShellFormatList } from "./entryFormats";
import { formatObjectGuid, formatObjectSid } from "./entryFormats";

describe("detectEntryFormat", () => {
  it("identifies LDIF by dn: lines", () => {
    expect(detectEntryFormat("dn: cn=a,dc=x\ncn: a\n")).toBe("ldif");
    expect(detectEntryFormat("version: 1\ndn:: Y249YQ==\n")).toBe("ldif");
  });

  it("identifies PowerShell Format-List output", () => {
    expect(detectEntryFormat("DistinguishedName : CN=a,DC=x\nObjectClass : user\n")).toBe("ps-format-list");
  });

  it("returns unknown for garbage/empty", () => {
    expect(detectEntryFormat("")).toBe("unknown");
    expect(detectEntryFormat("hello world")).toBe("unknown");
  });
});

describe("parseEntriesFromText (ldif path)", () => {
  it("reuses the RFC 2849 parser incl. base64 values", () => {
    const result = parseEntriesFromText("dn: cn=a,dc=x\ncn:: YWxpY2U=\nsn: A\n");
    expect(result.format).toBe("ldif");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].attributes.cn).toEqual(["alice"]);
  });

  it("surfaces LDIF errors as notes", () => {
    // 形似 LDIF（有 dn: 行）但值非法 base64
    const result = parseEntriesFromText("dn: cn=a,dc=x\nsn:: !!!\n");
    expect(result.format).toBe("ldif");
    expect(result.entries).toHaveLength(0);
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

describe("parseEntriesFromText (ps-format-list path)", () => {
  const sample = [
    "DistinguishedName : CN=Alice Smith,OU=People,DC=demo,DC=dbx",
    "GivenName         : Alice",
    "Surname           : Smith",
    "DisplayName       : Alice Smith",
    "SamAccountName    : alice",
    "EmailAddress      : alice@demo.dbx",
    "ObjectClass       : {top, person, organizationalPerson, user}",
    "Enabled           : True",
    "CanonicalName     : demo.dbx/People/Alice Smith",
    "whenChanged       : 9/14/2026 11:00:00 PM",
    "ObjectGUID        : 12345678-1234-1234-1234-123456789abc",
    "",
    "DistinguishedName : CN=Dev Team,OU=Groups,DC=demo,DC=dbx",
    "ObjectClass       : {top, group}",
    "SamAccountName    : dev-team",
    "MemberOf          : {CN=All,OU=Groups,DC=demo,DC=dbx}",
  ].join("\n");

  it("splits blank-line separated objects", () => {
    const result = parseEntriesFromText(sample);
    expect(result.format).toBe("ps-format-list");
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].dn).toBe("CN=Alice Smith,OU=People,DC=demo,DC=dbx");
    expect(result.entries[1].dn).toBe("CN=Dev Team,OU=Groups,DC=demo,DC=dbx");
  });

  it("maps PS display names to LDAP attribute names", () => {
    const result = parseEntriesFromText(sample);
    const alice = result.entries[0];
    expect(alice.attributes.sn).toEqual(["Smith"]);
    expect(alice.attributes.mail).toEqual(["alice@demo.dbx"]);
    expect(alice.attributes.sAMAccountName).toEqual(["alice"]);
    expect(alice.attributes.givenName).toEqual(["Alice"]);
  });

  it("expands {a, b} collections into multi-values (objectClass kept)", () => {
    const result = parseEntriesFromText(sample);
    expect(result.entries[0].attributes.objectClass).toEqual(["top", "person", "organizationalPerson", "user"]);
    expect(result.entries[1].attributes.objectClass).toEqual(["top", "group"]);
  });

  it("drops PS computed/system properties and reports them in notes", () => {
    const result = parseEntriesFromText(sample);
    const alice = result.entries[0];
    expect(alice.attributes.Enabled).toBeUndefined();
    expect(alice.attributes.CanonicalName).toBeUndefined();
    expect(alice.attributes.whenChanged).toBeUndefined();
    expect(result.notes.join("\n")).toContain("Enabled");
    expect(result.notes.join("\n")).toContain("CanonicalName");
  });

  it("converts objectGUID display string to base64 binary (round-trip)", () => {
    const result = parseEntriesFromText(sample);
    const base64 = result.entries[0].attributes.objectGUID![0];
    const guid = formatObjectGuid(base64ToBytes(base64));
    expect(guid).toBe("12345678-1234-1234-1234-123456789abc");
  });

  it("converts SID S-1-… strings to base64 binary", () => {
    const result = parseEntriesFromText(
      "DistinguishedName : CN=a,DC=x\nobjectSid         : S-1-5-32-544\n",
    );
    const base64 = result.entries[0].attributes.objectSID![0];
    expect(formatObjectSid(base64ToBytes(base64))).toBe("S-1-5-32-544");
  });

  it("flags entries without a DN via warnings", () => {
    const result = parseEntriesFromText("GivenName : Alice\n");
    expect(result.entries[0].dn).toBe("");
    expect(result.entries[0].warnings).toContain("dn");
  });

  it("treats byte-array dumps as binary base64", () => {
    const bytes = Uint8Array.from([1, 5, 0, 0, 0, 5, 21, 0, 0, 0]);
    const dump = `{${bytes.join(", ")}}`;
    const result = parseEntriesFromText(`DistinguishedName : CN=a,DC=x\nThumbnail : ${dump}\n`);
    expect(result.entries[0].attributes.Thumbnail).toEqual([bytesToBase64(bytes)]);
  });
});

describe("parsePowerShellFormatList (Quest Get-QAD shapes)", () => {
  it("maps DN alias and skips Quest-only properties", () => {
    const result = parsePowerShellFormatList(
      "DN              : CN=bob,DC=demo,DC=dbx\nType            : user\nNTAccountName   : DEMO\\bob\nDisplayName     : Bob\n",
    );
    expect(result.entries[0].dn).toBe("CN=bob,DC=demo,DC=dbx");
    expect(result.entries[0].attributes.displayName).toEqual(["Bob"]);
    expect(result.entries[0].attributes.Type).toBeUndefined();
    expect(result.notes.join("\n")).toContain("NTAccountName");
  });
});

describe("entryFormats edge cases (回归补强)", () => {
  it("keeps PS values that contain colons (Description : a: b)", () => {
    const result = parseEntriesFromText("DistinguishedName : CN=a,DC=x\nDescription       : relay: 25 # mail\n");
    expect(result.entries[0].attributes.description).toEqual(["relay: 25 # mail"]);
  });

  it("flags an unparseable objectGUID string as a warning without emitting the attribute", () => {
    const result = parseEntriesFromText("DistinguishedName : CN=a,DC=x\nObjectGUID        : not-a-guid\n");
    expect(result.entries[0].attributes.objectGUID).toBeUndefined();
    expect(result.entries[0].warnings.join("\n")).toContain("objectGUID");
  });

  it("treats short numeric PS values as text (byte-array rule needs >=8 bytes)", () => {
    const result = parseEntriesFromText("DistinguishedName : CN=a,DC=x\nuidNumber         : 1000\n");
    expect(result.entries[0].attributes.uidNumber).toEqual(["1000"]);
  });

  it("propagates multi-line continuation values (PS wrapped long strings)", () => {
    const result = parseEntriesFromText(
      "DistinguishedName : CN=a,DC=x\nDescription       : first line\n  second line\n",
    );
    expect(result.entries[0].attributes.description).toEqual(["first line second line"]);
  });

  it("detects LDIF even when a PS-looking line appears after the dn: line", () => {
    expect(detectEntryFormat("dn: cn=a,dc=x\nObjectClass : user\n")).toBe("ldif");
  });
});
