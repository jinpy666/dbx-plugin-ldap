// lib/schemaCache 单测：deriveSchemaMetadata 双形状兼容（raw RFC 4512 定义串 /
// sidecar 结构体）、语法语义解析、attributeInfo 别名索引、serverInfo 透传；
// useLdapSchemaCache 共享缓存视图（J-8）：attributeInfo/serverInfo 装载、
// 多视图共享命中与 inFlight 去重、TTL 过期重拉、per-connection 隔离、
// invalidate 强刷、规范 loader 超集 payload 形状与失败重试。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveSchemaMetadata,
  resetSchemaCacheForTests,
  setSchemaLoaderForTests,
  setSchemaTtlForTests,
  useLdapSchemaCache,
  type SchemaMetadata,
} from "./schemaCache";

const GENERALIZED_TIME = "1.3.6.1.4.1.1466.115.121.1.24";
const DN_OID = "1.3.6.1.4.1.1466.115.121.1.12";

// -- 模块级共享状态隔离（J-8）：每条用例前后清空缓存/inFlight/loading/error，
// 还原 loader 与 TTL 注入，避免用例间经模块单例串状态。 --------------------------
beforeEach(() => {
  resetSchemaCacheForTests();
  setSchemaLoaderForTests(null);
  setSchemaTtlForTests(null);
});

afterEach(() => {
  resetSchemaCacheForTests();
  setSchemaLoaderForTests(null);
  setSchemaTtlForTests(null);
});

/** 受控 loader：记录每连接调用次数，返回 BASE 的浅拷贝（可按用例覆写字段）。 */
const BASE: SchemaMetadata = {
  attributeNames: ["cn", "sn"],
  objectClassAttributes: { person: { must: ["sn"], may: ["telephoneNumber"] } },
  attributeInfo: { cn: { syntax: "1.3.6.1.4.1.1466.115.121.1.15", equality: "caseIgnoreMatch" } },
  serverInfo: { dialect: "openldap", vendorName: "OpenLDAP" },
  rawAttributeTypes: ["( 2.5.4.3 NAME 'cn' SYNTAX 1.3.6.1.4.1.1466.115.121.1.15 )"],
  rawObjectClasses: ["( 2.5.6.6 NAME 'person' MUST sn )"],
};

function makeCountingLoader(overrides: Partial<SchemaMetadata> = {}) {
  const calls: string[] = [];
  const loader = async (connectionId: string) => {
    calls.push(connectionId);
    return { ...BASE, ...overrides };
  };
  return { calls, loader };
}

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
        { oid: "1.2.840.113556.1.4.221", name: "1.2.840.113556.1.4.221", names: [], syntax: "1.3.6.1.4.1.1466.115.121.1.15" },
      ],
      [
        { oid: "2.5.6.6", name: "person", names: ["person"], must: ["sn", "cn"], may: ["userPassword"] },
      ],
    );
    expect(metadata.attributeNames).toEqual(["whenCreated", "cn", "commonName"]);
    expect(metadata.attributeInfo?.["1.2.840.113556.1.4.221"]?.syntax).toBe("1.3.6.1.4.1.1466.115.121.1.15");
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

describe("deriveSchemaMetadata extra 三类补充定义 (F2b)", () => {
  const EXTRA = {
    matchingRules: [{ oid: "2.5.13.2", names: ["caseIgnoreMatch"], desc: "case ignore match", syntax: "1.3.6.1.4.1.1466.115.121.1.15" }],
    matchingRuleUses: [{ oid: "2.5.13.5", names: ["caseExactMatch"], attributeTypes: ["cn", "sn"] }],
    ldapSyntaxes: [{ oid: DN_OID, desc: "LDAP DN" }],
  };

  it("passes the three extra definition arrays through to metadata", () => {
    const metadata = deriveSchemaMetadata([], [], undefined, EXTRA);
    expect(metadata.matchingRules).toEqual(EXTRA.matchingRules);
    expect(metadata.matchingRuleUses).toEqual(EXTRA.matchingRuleUses);
    expect(metadata.ldapSyntaxes).toEqual(EXTRA.ldapSyntaxes);
  });

  it("keeps the extra arrays undefined for legacy 3-arg callers (向后兼容)", () => {
    const metadata = deriveSchemaMetadata([], []);
    expect(metadata.matchingRules).toBeUndefined();
    expect(metadata.matchingRuleUses).toBeUndefined();
    expect(metadata.ldapSyntaxes).toBeUndefined();
    // 既有字段不受第 4 参缺省影响。
    expect(metadata.attributeNames).toEqual([]);
    expect(metadata.objectClassAttributes).toEqual({});
  });
});

// -- useLdapSchemaCache 共享缓存视图（J-8）--------------------------------------
// 缓存/inFlight 为模块级单例：spec 经 setSchemaLoaderForTests 注入受控 loader
// （记录调用次数），经 setSchemaTtlForTests 缩短 TTL 观察过期重拉。
describe("useLdapSchemaCache 共享缓存视图 (J-8)", () => {
  it("ensureLoaded 后透出 attributeInfo / serverInfo / raw 定义串", async () => {
    setSchemaLoaderForTests(async () => ({ ...BASE }));
    const cache = useLdapSchemaCache();
    const payload = await cache.ensureLoaded("conn-x");
    expect(payload?.serverInfo?.dialect).toBe("openldap");
    expect(cache.serverInfo.value?.dialect).toBe("openldap");
    expect(cache.attributeInfo.value["cn"]?.syntax).toBe("1.3.6.1.4.1.1466.115.121.1.15");
    expect(cache.rawAttributeTypes.value).toEqual(BASE.rawAttributeTypes);
    expect(cache.rawObjectClasses.value).toEqual(BASE.rawObjectClasses);
  });

  it("同连接多视图共享一次拉取（后开视图命中共享缓存并补 apply）", async () => {
    const { calls, loader } = makeCountingLoader();
    setSchemaLoaderForTests(loader);
    const viewA = useLdapSchemaCache();
    const viewB = useLdapSchemaCache();
    const a = await viewA.ensureLoaded("conn-1");
    const b = await viewB.ensureLoaded("conn-1");
    expect(calls).toEqual(["conn-1"]);
    expect(b).toBe(a); // 同一份共享 payload
    expect(viewB.attributeNames.value).toEqual(BASE.attributeNames);
    expect(viewB.objectClassAttributes.value).toEqual(BASE.objectClassAttributes);
    expect(viewB.serverInfo.value?.dialect).toBe("openldap");
  });

  it("并发 ensureLoaded 命中 inFlight 去重（同窗口只拉一次）", async () => {
    const { calls, loader } = makeCountingLoader();
    setSchemaLoaderForTests(loader);
    const viewA = useLdapSchemaCache();
    const viewB = useLdapSchemaCache();
    const [a, b] = await Promise.all([viewA.ensureLoaded("conn-1"), viewB.ensureLoaded("conn-1")]);
    expect(calls).toEqual(["conn-1"]);
    expect(a).toBe(b);
    // 等待方视图在共享 resolve 后也完成 apply，不拿到空列表。
    expect(viewB.attributeInfo.value["cn"]?.equality).toBe("caseIgnoreMatch");
  });

  it("TTL 过期后重拉（窗口内命中不重复拉取）", async () => {
    setSchemaTtlForTests(30);
    const { calls, loader } = makeCountingLoader();
    setSchemaLoaderForTests(loader);
    const view = useLdapSchemaCache();
    await view.ensureLoaded("conn-1");
    await view.ensureLoaded("conn-1"); // 窗口内：共享命中
    expect(calls).toEqual(["conn-1"]);
    await new Promise((resolve) => setTimeout(resolve, 45)); // 越过 30ms TTL
    await view.ensureLoaded("conn-1");
    expect(calls).toEqual(["conn-1", "conn-1"]);
  });

  it("不同连接各自缓存（per-connection 隔离，视图切换跟随当前连接）", async () => {
    const calls: string[] = [];
    setSchemaLoaderForTests(async (connectionId) => {
      calls.push(connectionId);
      return {
        ...BASE,
        serverInfo: { dialect: connectionId === "conn-a" ? "ad" : "openldap" },
        attributeNames: [connectionId === "conn-a" ? "cn" : "uid"],
      };
    });
    const view = useLdapSchemaCache();
    await view.ensureLoaded("conn-a");
    expect(view.serverInfo.value?.dialect).toBe("ad");
    await view.ensureLoaded("conn-b");
    expect(calls).toEqual(["conn-a", "conn-b"]);
    expect(view.serverInfo.value?.dialect).toBe("openldap");
    expect(view.attributeNames.value).toEqual(["uid"]);
    // 切回 conn-a：命中该连接的缓存，不重拉。
    await view.ensureLoaded("conn-a");
    expect(calls).toEqual(["conn-a", "conn-b"]);
    expect(view.serverInfo.value?.dialect).toBe("ad");
    expect(view.attributeNames.value).toEqual(["cn"]);
  });

  it("invalidate 单连接强刷；无参全清", async () => {
    const { calls, loader } = makeCountingLoader();
    setSchemaLoaderForTests(loader);
    const view = useLdapSchemaCache();
    await view.ensureLoaded("conn-1");
    await view.ensureLoaded("conn-2");
    view.invalidate("conn-1"); // 只失效 conn-1
    await view.ensureLoaded("conn-1");
    await view.ensureLoaded("conn-2");
    expect(calls).toEqual(["conn-1", "conn-2", "conn-1"]);
    view.invalidate(); // 全清
    await view.ensureLoaded("conn-1");
    await view.ensureLoaded("conn-2");
    expect(calls).toEqual(["conn-1", "conn-2", "conn-1", "conn-1", "conn-2"]);
  });

  it("loader 失败置 error 且不落缓存；恢复后可重试", async () => {
    let fail = true;
    setSchemaLoaderForTests(async () => {
      if (fail) throw new Error("schema unavailable");
      return { ...BASE };
    });
    const view = useLdapSchemaCache();
    await expect(view.ensureLoaded("conn-1")).rejects.toThrow("schema unavailable");
    expect(view.error.value).toBeInstanceOf(Error);
    fail = false;
    const payload = await view.ensureLoaded("conn-1");
    expect(payload?.attributeNames).toEqual(BASE.attributeNames);
    expect(view.error.value).toBeNull();
  });

  it("视图切换连接后，旧连接迟到的 resolve 不串数据", async () => {
    let resolveA!: (payload: Partial<SchemaMetadata>) => void;
    setSchemaLoaderForTests((connectionId) => {
      if (connectionId === "conn-a") {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve({ ...BASE, serverInfo: { dialect: "openldap" } });
    });
    const view = useLdapSchemaCache();
    const pendingA = view.ensureLoaded("conn-a");
    await view.ensureLoaded("conn-b");
    expect(view.serverInfo.value?.dialect).toBe("openldap");
    resolveA({ ...BASE, serverInfo: { dialect: "ad" } });
    await pendingA;
    // conn-a 的迟到数据不得覆盖已切到 conn-b 的视图。
    expect(view.serverInfo.value?.dialect).toBe("openldap");
  });

  it("规范 loader 超集 payload：基础 + extra 三类 + raw 全字段透出", async () => {
    const extra = {
      matchingRules: [{ oid: "2.5.13.2", names: ["caseIgnoreMatch"], desc: "case ignore match", syntax: "1.3.6.1.4.1.1466.115.121.1.15" }],
      matchingRuleUses: [{ oid: "2.5.13.5", names: ["caseExactMatch"], attributeTypes: ["cn", "sn"] }],
      ldapSyntaxes: [{ oid: DN_OID, desc: "LDAP DN" }],
    };
    // 与 fetchCanonicalSchema 相同的组合：deriveSchemaMetadata 基础字段 + extra 透传。
    const superset = deriveSchemaMetadata(
      [{ oid: "2.5.4.3", name: "cn", names: ["cn", "commonName"], syntax: "1.3.6.1.4.1.1466.115.121.1.15", equality: "caseIgnoreMatch" }],
      [{ oid: "2.5.6.6", name: "person", names: ["person"], must: ["sn"], may: ["cn"] }],
      { dialect: "openldap", vendorName: "OpenLDAP", productName: "" },
      extra,
    );
    setSchemaLoaderForTests(async () => superset);
    const view = useLdapSchemaCache();
    const payload = await view.ensureLoaded("conn-1");
    // 基础字段
    expect(payload?.attributeNames).toEqual(["cn", "commonName"]);
    expect(payload?.objectClassAttributes?.person).toEqual({ must: ["sn"], may: ["cn"] });
    expect(payload?.attributeInfo?.["commonname"]?.syntax).toBe("1.3.6.1.4.1.1466.115.121.1.15");
    expect(payload?.serverInfo?.dialect).toBe("openldap");
    // extra 三类补充定义原样透传
    expect(payload?.matchingRules).toEqual(extra.matchingRules);
    expect(payload?.matchingRuleUses).toEqual(extra.matchingRuleUses);
    expect(payload?.ldapSyntaxes).toEqual(extra.ldapSyntaxes);
    // 视图 refs 同步透出（面板据此渲染分类页签与明细栏）
    expect(view.matchingRules.value).toEqual(extra.matchingRules);
    expect(view.matchingRuleUses.value).toEqual(extra.matchingRuleUses);
    expect(view.ldapSyntaxes.value).toEqual(extra.ldapSyntaxes);
  });

  it("loader 缺省字段时保持空值 / undefined 缺省（向后兼容）", async () => {
    setSchemaLoaderForTests(async () => ({ attributeNames: ["cn"] }));
    const view = useLdapSchemaCache();
    const payload = await view.ensureLoaded("conn-legacy");
    expect(payload?.matchingRules).toBeUndefined();
    expect(payload?.matchingRuleUses).toBeUndefined();
    expect(payload?.ldapSyntaxes).toBeUndefined();
    expect(payload?.rawAttributeTypes).toBeUndefined();
    expect(view.matchingRules.value).toBeUndefined();
    expect(view.rawAttributeTypes.value).toEqual([]);
    expect(view.objectClassAttributes.value).toEqual({});
    expect(view.attributeInfo.value).toEqual({});
  });
});
