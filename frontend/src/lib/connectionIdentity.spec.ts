import { describe, expect, it } from "vitest";
import {
  connectionIdentityText,
  protocolBadge,
  serverBadgeLabel,
  toolbarTint,
  type ConnectionSummary,
} from "./connectionIdentity";

describe("connectionIdentityText", () => {
  it("joins username, host and port", () => {
    const connection: ConnectionSummary = { host: "ldap.example.com", port: 636, username: "admin" };
    expect(connectionIdentityText(connection, "c1")).toBe("admin@ldap.example.com:636");
  });

  it("falls back to connection name then connectionId and omits empty port", () => {
    expect(connectionIdentityText({ name: "prod-ldap" }, "c1")).toBe("prod-ldap");
    expect(connectionIdentityText({}, "c9")).toBe("c9");
  });
});

describe("protocolBadge", () => {
  it("derives LDAPS from tls_mode and labels GSSAPI for kerberos", () => {
    expect(protocolBadge({ external_config: { tls_mode: "ldaps", auth_type: "kerberos" } })).toBe("LDAPS · GSSAPI");
  });

  it("treats port 636 as LDAPS even without tls_mode", () => {
    expect(protocolBadge({ port: 636 })).toBe("LDAPS");
  });

  it("labels starttls and falls unknown auth types back to Simple", () => {
    expect(protocolBadge({ external_config: { tls_mode: "starttls", auth_type: "unauthenticated" } })).toBe("LDAP+TLS · Simple");
    expect(protocolBadge({ external_config: { tls_mode: "none" } })).toBe("LDAP");
  });

  it("returns empty when nothing is derivable and survives malformed config", () => {
    expect(protocolBadge({})).toBe("");
    expect(protocolBadge({ external_config: "garbage" as unknown as Record<string, unknown> })).toBe("");
  });
});

describe("serverBadgeLabel", () => {
  it("prefers vendor name and falls back to the dialect label", () => {
    expect(serverBadgeLabel({ vendorName: "Apache Software Foundation", dialect: "ad" })).toBe("Apache Software Foundation");
    expect(serverBadgeLabel({ dialect: "openldap" })).toBe("OpenLDAP");
    expect(serverBadgeLabel({ dialect: "unknown" })).toBe("");
    expect(serverBadgeLabel(undefined)).toBe("");
  });
});

describe("toolbarTint", () => {
  it("uses a softer tint in light scheme than in dark", () => {
    const light = toolbarTint("#7c3aed", "light");
    const dark = toolbarTint("#7c3aed", "dark");
    expect(light?.backgroundColor).toContain("/ 0.05)");
    expect(dark?.backgroundColor).toContain("/ 0.1)");
    expect(light?.boxShadow).toContain("inset");
    expect(light?.boxShadow).toContain("/ 0.12)");
    expect(dark?.boxShadow).toContain("/ 0.18)");
  });

  it("passes non-hex colors through color-mix", () => {
    const style = toolbarTint("rgb(124 58 237)", "dark");
    expect(style?.backgroundColor).toContain("color-mix");
  });

  it("returns undefined without a connection color", () => {
    expect(toolbarTint(undefined, "dark")).toBeUndefined();
  });
});
