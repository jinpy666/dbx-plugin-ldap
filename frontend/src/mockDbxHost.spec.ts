// @vitest-environment happy-dom
// Visual fixture host bridge (mockDbxHost) unit tests for the
// ldap/entry/delete recursive path: the fixture mirrors the backend N1
// behaviour in simplified form (whole-subtree removal + one aggregated
// "subtree_delete" audit record with deletedCount, incl. the target itself).
import { afterAll, describe, expect, it, vi } from "vitest";
import "./mockDbxHost";
import type { LdapSearchPreset } from "./lib/api";

const searchCount = async (baseDn: string) =>
  ((await window.dbxPlugin.invoke<{ entries: unknown[] }>("ldap/search", { baseDn, filter: "(objectClass=*)", scope: "sub" })).entries).length;

const deleteEntry = (params: Record<string, unknown>) => window.dbxPlugin.invoke("ldap/entry/delete", params);

describe("mockDbxHost preset protocol", () => {
  it("returns a canonical single preset, upserts by id, and removes with a success-only response", async () => {
    localStorage.removeItem("ldap-mock-presets");
    try {
      const saved = await window.dbxPlugin.invoke<{ success: boolean; preset: LdapSearchPreset }>("ldap/presets/save", {
        preset: { id: "", name: "  People  ", filter: "(uid=a)", conditions: { stale: true } },
      });
      expect(saved.success).toBe(true);
      expect(saved.preset.id).toBeTruthy();
      expect(saved.preset.name).toBe("People");
      expect(saved).not.toHaveProperty("presets");
      expect(saved.preset).not.toHaveProperty("conditions");
      const updated = await window.dbxPlugin.invoke("ldap/presets/save", { preset: { ...saved.preset, filter: "(uid=b)" } });
      expect(updated).toEqual({ success: true, preset: { ...saved.preset, filter: "(uid=b)" } });
      expect(await window.dbxPlugin.invoke("ldap/presets/list")).toEqual({ presets: [{ ...saved.preset, filter: "(uid=b)" }] });
      expect(await window.dbxPlugin.invoke("ldap/presets/remove", { id: saved.preset.id })).toEqual({ success: true });
      expect(await window.dbxPlugin.invoke("ldap/presets/list")).toEqual({ presets: [] });
    } finally {
      localStorage.removeItem("ldap-mock-presets");
    }
  });

  it("mirrors required-name and missing-preset errors", async () => {
    await expect(window.dbxPlugin.invoke("ldap/presets/save", { preset: { name: " " } })).rejects.toThrow("preset name is required");
    await expect(window.dbxPlugin.invoke("ldap/presets/remove", { id: "" })).rejects.toThrow("Missing preset id");
    await expect(window.dbxPlugin.invoke("ldap/presets/remove", { id: "missing-round5" })).rejects.toThrow("is not found");
  });
});

describe("mockDbxHost ldap/entry/delete", () => {
  it("recursive delete removes the whole subtree and emits one aggregated subtree_delete audit", async () => {
    const events: Array<Record<string, unknown>> = [];
    const off = window.dbxPlugin.onEvent((event) => {
      if (event.type !== "env") events.push(event.params);
    });
    try {
      const target = "ou=services,dc=demo,dc=dbx";
      expect(await searchCount(target)).toBe(3); // ou=services + cn=ldap + cn=web
      await deleteEntry({ dn: target, recursive: true });
      expect(await searchCount(target)).toBe(0);
      const audits = events.filter((event) => event.action === "subtree_delete");
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ target, result: "ok", deletedCount: 3 });
    } finally {
      off();
    }
  });

  it("non-recursive delete removes only the target entry and keeps its siblings", async () => {
    await deleteEntry({ dn: "cn=admins,ou=groups,dc=demo,dc=dbx" });
    expect(await searchCount("cn=admins,ou=groups,dc=demo,dc=dbx")).toBe(0);
    // ou=groups 自身 + devs + team-a 仍在。
    expect(await searchCount("ou=groups,dc=demo,dc=dbx")).toBe(3);
  });

  it("recursive delete is not capped in the fixture (1001-entry people tree goes in one call)", async () => {
    const people = "ou=people,dc=demo,dc=dbx";
    expect(await searchCount(people)).toBe(1001); // ou=people + 1000 users
    await deleteEntry({ dn: people, recursive: true });
    expect(await searchCount(people)).toBe(0);
    // 其他树不受影响。
    expect(await searchCount("ou=groups,dc=demo,dc=dbx")).toBe(3);
  });

  it("delete rejects a missing dn (recursive or not)", async () => {
    await expect(deleteEntry({ dn: "cn=ghost,dc=demo,dc=dbx" })).rejects.toThrow("entry not found");
    await expect(deleteEntry({ dn: "cn=ghost,dc=demo,dc=dbx", recursive: true })).rejects.toThrow("entry not found");
  });
});

describe("mockDbxHost read contracts", () => {
  it("returns direct childrenCount for the requested dn, including a leaf's zero count", async () => {
    const dn = "ou=round4-count,dc=demo,dc=dbx";
    for (const target of [dn, "cn=a," + dn, "cn=b," + dn, "cn=nested,cn=a," + dn]) {
      await window.dbxPlugin.invoke("ldap/entry/add", { dn: target, attributes: { objectClass: ["top"] } });
    }
    try {
      const result = await window.dbxPlugin.invoke("ldap/entry/childrenCount", { dn });
      expect(result).toEqual({ count: 2, truncated: false });
      expect(result).toEqual(await window.dbxPlugin.invoke("ldap/count", { baseDn: dn }));
      expect(await window.dbxPlugin.invoke("ldap/entry/childrenCount", { dn: "cn=b," + dn })).toEqual({ count: 0, truncated: false });
    } finally {
      await deleteEntry({ dn, recursive: true });
    }
  });

  it("rejects a missing childrenCount dn instead of returning a success-shaped object", async () => {
    await expect(window.dbxPlugin.invoke("ldap/entry/childrenCount", { dn: " " })).rejects.toThrow("dn is required");
  });

  it("exposes native onContext without replaying init on subscription", () => {
    const listener = vi.fn();
    expect(window.dbxPlugin.onContext).toBeTypeOf("function");
    const off = window.dbxPlugin.onContext?.(listener);
    expect(listener).not.toHaveBeenCalled();
    expect(off).toBeTypeOf("function");
    off?.();
  });
});

describe("mockDbxHost schema five categories (F2b)", () => {
  it("returns matching rules, uses and syntaxes with the contract shape", async () => {
    const result = (await window.dbxPlugin.invoke("ldap/schema")) as {
      matchingRules?: Array<{ oid: string; names?: string[]; syntax?: string }>;
      matchingRuleUses?: Array<{ attributeTypes?: string[] }>;
      ldapSyntaxes?: Array<{ desc?: string }>;
    };
    expect((result.matchingRules ?? []).length).toBeGreaterThanOrEqual(2);
    const caseIgnore = (result.matchingRules ?? []).find((rule) => rule.names?.includes("caseIgnoreMatch"));
    expect(caseIgnore?.syntax).toBe("1.3.6.1.4.1.1466.115.121.1.15");
    expect(result.matchingRuleUses?.[0]?.attributeTypes).toEqual(["cn", "sn", "uid"]);
    expect((result.ldapSyntaxes ?? []).some((syntax) => syntax.desc === "Directory String")).toBe(true);
  });
});

describe("mockDbxHost extended operations (F3)", () => {
  const branchDn = "ou=ext-ops,dc=demo,dc=dbx";
  const userDn = `uid=extuser,${branchDn}`;
  const invoke = (method: string, params: Record<string, unknown>) => window.dbxPlugin.invoke(method, params);
  const addEntry = (dn: string, attributes: Record<string, string[]>) => invoke("ldap/entry/add", { dn, attributes });

  afterAll(async () => {
    for (const dn of [userDn, branchDn]) {
      await invoke("ldap/entry/delete", { dn }).catch(() => {});
    }
  });

  it("compare matches case-insensitively and reports no-match without erroring", async () => {
    await addEntry(branchDn, { objectClass: ["top"], ou: ["ext-ops"] });
    await addEntry(userDn, { objectClass: ["top"], uid: ["extuser"] });
    expect(await invoke("ldap/entry/compare", { dn: userDn, attribute: "UID", value: "EXTUSER" })).toEqual({ match: true });
    expect(await invoke("ldap/entry/compare", { dn: userDn, attribute: "uid", value: "other" })).toEqual({ match: false });
    expect(await invoke("ldap/entry/compare", { dn: userDn, attribute: "mail", value: "x" })).toEqual({ match: false });
    await expect(invoke("ldap/entry/compare", { dn: "uid=missing,dc=demo,dc=dbx", attribute: "uid", value: "x" })).rejects.toThrow("entry not found");
    await expect(invoke("ldap/entry/compare", { dn: userDn, attribute: "", value: "x" })).rejects.toThrow("attribute is required");
  });

  it("whoami returns the admin authzId", async () => {
    expect(await invoke("ldap/whoami", {})).toEqual({ authzId: "dn:cn=admin,dc=demo,dc=dbx" });
  });

  it("passwdModify writes a hash placeholder and requires an existing entry", async () => {
    await addEntry(userDn, { objectClass: ["top"], uid: ["extuser"] }).catch(() => {});
    expect(await invoke("ldap/entry/passwdModify", { dn: userDn, newPassword: "walkthrough-secret" })).toEqual({ success: true });
    const read = (await invoke("ldap/entry/get", { dn: userDn })) as { entry: { attributes: Record<string, string[]> } };
    expect(read.entry.attributes.userPassword).toEqual(["{SSHA}fixture-digest"]);
    await expect(invoke("ldap/entry/passwdModify", { dn: "uid=missing,dc=demo,dc=dbx", newPassword: "x" })).rejects.toThrow("entry not found");
  });
});
