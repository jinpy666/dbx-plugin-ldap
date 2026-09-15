// lib/schemaCache 单测：deriveSchemaMetadata 双形状兼容（raw RFC 4512 定义串 /
// sidecar 结构体）、语法语义解析、attributeInfo 别名索引、serverInfo 透传，
// 以及 useLdapSchemaCache 的 attributeInfo/serverInfo 装载。
import { describe, expect, it } from "vitest";
import { deriveSchemaMetadata, useLdapSchemaCache } from "./schemaCache";

const GENERALIZED_TIME = "1.3.6.1.4.1.1466.115.121.1.24";
const DN_OID = "1.3.6.1.4.1.1466.115.121.1.12";

describe("deriveSchemaMetadata raw string shape (mock / 旧 sidecar)", () => {
  it("parses NAME / MUST / MAY from RFC 4512 definitions", () => {
    const metadata = deriveSchemaMetadata(
      ["( 2.5.4.3 NAME ( 'cn' 'commonName' ) SUP name )", `( 2.5.4.4 NAME 'sn' EQUALITY caseIgnoreMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{32768} )`],
      ["( 2.5.6.6 NAME 'person' SUP top STRUCTURAL MUST ( sn $ cn ) MAY userPassword )"],
    );
    expect(metadata.attributeNames).toEqual(["cn", "commonName", "sn"]);
    expect(metadata.objectClassAttributes["person"]).toEqual({ must: ["sn", "cn"], may: ["userPassword"] });
  });

  it("derives syntax info from raw definitions (strips {len}, boolean flags)", () => {
    const metadata = deriveSchemaMetadata(
      [
        `( 1.2.3.4 NAME 'aTime' SYNTAX ${GENERALIZED_TIME} SINGLE-VALUE )`,
        `( 1.2.3.5 NAME 'aRef' SYNTAX ${DN_OID} NO-USER-MODIFICATION )`,
      ],
      [],
    );
    expect(metadata.attributeInfo?.["atime"]).toEqual({ syntax: GENERALIZED_TIME, singleValue: true });
    expect(metadata.attributeInfo?.["aref"]).toEqual({ syntax: DN_OID, noUserModification: true });
  });
});

describe("deriveSchemaMetadata sidecar struct shape (阶段1 真实格式)", () => {
  it("consumes {oid,name,names,syntax,...} objects directly", () => {
    const metadata = deriveSchemaMetadata(
      [
        { oid: "1.2.3.9", name: "whenCreated", names: ["whenCreated"], syntax: GENERALIZED_TIME, noUserModification: true },
        { oid: "1.2.3.10", name: "cn", names: ["cn", "commonName"], syntax: "1.3.6.1.4.1.1466.115.121.1.15", equality: "caseIgnoreMatch" },
      ],
      [
        { oid: "2.5.6.6", name: "person", names: ["person"], must: ["sn", "cn"], may: ["userPassword"] },
      ],
    );
    expect(metadata.attributeNames).toEqual(["whenCreated", "cn", "commonName"]);
    expect(metadata.attributeInfo?.["whencreated"]).toEqual({ syntax: GENERALIZED_TIME, singleValue: false, noUserModification: true });
    expect(metadata.attributeInfo?.["commonname"]?.equality).toBe("caseIgnoreMatch");
    expect(metadata.objectClassAttributes["person"]).toEqual({ must: ["sn", "cn"], may: ["userPassword"] });
  });

  it("indexes aliases into attributeInfo", () => {
    const metadata = deriveSchemaMetadata([{ oid: "1.1", name: "cn", names: ["cn", "commonName"] }], []);
    expect(metadata.attributeInfo?.["cn"]).toBeDefined();
    expect(metadata.attributeInfo?.["commonname"]).toBe(metadata.attributeInfo?.["cn"]);
  });

  it("passes serverInfo through", () => {
    const metadata = deriveSchemaMetadata([], [], { dialect: "ad", vendorName: "Microsoft Corporation.", productName: "" });
    expect(metadata.serverInfo).toEqual({ dialect: "ad", vendorName: "Microsoft Corporation.", productName: "" });
  });

  it("handles non-array garbage inputs", () => {
    const metadata = deriveSchemaMetadata(null, undefined);
    expect(metadata.attributeNames).toEqual([]);
    expect(metadata.objectClassAttributes).toEqual({});
  });
});

describe("useLdapSchemaCache attributeInfo/serverInfo loading", () => {
  it("exposes attributeInfo and serverInfo after ensureLoaded", async () => {
    const cache = useLdapSchemaCache({
      ttlMs: 60_000,
      loader: async () =>
        deriveSchemaMetadata([{ oid: "1.1", name: "cn", names: ["cn"], syntax: "1.3.6.1.4.1.1466.115.121.1.15" }], [], { dialect: "openldap" }),
    });
    const payload = await cache.ensureLoaded("conn-x");
    expect(payload?.serverInfo?.dialect).toBe("openldap");
    expect(cache.serverInfo.value?.dialect).toBe("openldap");
    expect(cache.attributeInfo.value["cn"]?.syntax).toBe("1.3.6.1.4.1.1466.115.121.1.15");
  });
});
