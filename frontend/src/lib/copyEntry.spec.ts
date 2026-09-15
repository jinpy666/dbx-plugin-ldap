// lib/copyEntry 纯函数单测：RDN 拆解与值清空、密码/系统/NO-USER-MODIFICATION
// 属性剔除与 notes、objectClass 保留、父 DN 沿用/覆盖。
import { describe, expect, it } from "vitest";
import { prepareCopyEntry } from "./copyEntry";

const source = {
  dn: "cn=alice,ou=people,dc=demo,dc=dbx",
  attributes: {
    objectClass: ["top", "person", "inetOrgPerson"],
    cn: ["alice"],
    sn: ["Alice"],
    mail: ["alice@demo.dbx"],
    userPassword: ["{SSHA}abc123"],
    entryUUID: ["3f4a…"],
    createTimestamp: ["20250101000000Z"],
    whenChanged: ["20250101000000Z"],
    seen: ["20260101000000Z"],
  },
};

describe("prepareCopyEntry", () => {
  it("keeps objectClass and writable attributes, blanks the RDN attribute value", () => {
    const draft = prepareCopyEntry(source);
    expect(draft.parentDn).toBe("ou=people,dc=demo,dc=dbx");
    expect(draft.rdn).toBe("cn=");
    expect(draft.attributes.objectClass).toEqual(["top", "person", "inetOrgPerson"]);
    expect(draft.attributes.sn).toEqual(["Alice"]);
    expect(draft.attributes.cn).toEqual([""]);
    expect(draft.attributes.mail).toEqual(["alice@demo.dbx"]);
  });

  it("strips password hashes and system/operational attributes with notes", () => {
    const draft = prepareCopyEntry(source);
    expect(draft.attributes.userPassword).toBeUndefined();
    expect(draft.attributes.entryUUID).toBeUndefined();
    expect(draft.attributes.createTimestamp).toBeUndefined();
    expect(draft.attributes.whenChanged).toBeUndefined();
    expect(draft.skipped).toEqual(["userPassword", "entryUUID", "createTimestamp", "whenChanged"]);
  });

  it("strips NO-USER-MODIFICATION attributes via schema attributeInfo", () => {
    const withSchema = prepareCopyEntry(
      { dn: source.dn, attributes: { ...source.attributes, seen: ["x"], seenRaw: ["y"] } },
      { attributeInfo: { seen: { noUserModification: true } } },
    );
    expect(withSchema.attributes.seen).toBeUndefined();
    expect(withSchema.attributes.seenRaw).toEqual(["y"]);
    expect(withSchema.skipped).toContain("seen");
  });

  it("honours an explicit target parent DN", () => {
    const draft = prepareCopyEntry(source, { parentDn: "ou=archive,dc=demo,dc=dbx" });
    expect(draft.parentDn).toBe("ou=archive,dc=demo,dc=dbx");
  });

  it("handles non-RDN-first attribute casing for RDN blanking", () => {
    const draft = prepareCopyEntry({ dn: "uid=bob,dc=demo,dc=dbx", attributes: { uid: ["bob"], cn: ["Bob"] } });
    expect(draft.rdn).toBe("uid=");
    expect(draft.attributes.uid).toEqual([""]);
    expect(draft.attributes.cn).toEqual(["Bob"]);
  });
});
