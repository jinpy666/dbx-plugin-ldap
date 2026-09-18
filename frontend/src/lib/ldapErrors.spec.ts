import { describe, expect, it } from "vitest";
import { friendlyLdapError, parseLdapErrorMeta } from "./ldapErrors";

describe("friendlyLdapError", () => {
    it("maps the go-ldap network error (original runtime bug) to a friendly message", () => {
        const mapped = friendlyLdapError(
            'dial ldap: LDAP Result Code 200 "Network Error": parse "ldaps://[ldaps:%2F%2Fdc]:636": invalid URL escape "%2F"',
        );
        expect(mapped).not.toContain("Result Code");
        expect(mapped.length).toBeGreaterThan(0);
    });

    it("maps invalid credentials", () => {
        expect(friendlyLdapError('LDAP Result Code 49 "Invalid Credentials": password wrong')).not.toBe("");
    });

    it("maps no such object", () => {
        expect(friendlyLdapError('search: LDAP Result Code 32 "No Such Object": dn mismatch')).not.toBe("");
    });

    it("maps tls certificate failures ahead of network rules", () => {
        expect(friendlyLdapError("tls: failed to verify certificate: x509: certificate signed by unknown authority")).not.toBe("");
    });

    it("maps dial timeouts to the network message", () => {
        expect(friendlyLdapError("dial tcp 10.0.0.1:636: i/o timeout")).not.toBe("");
    });

    it("maps connection lost / closed transport failures to the network message (P2-1)", () => {
        const raw = "connection lost (fixture error injection)";
        expect(friendlyLdapError(raw)).not.toBe(raw);
        expect(friendlyLdapError(raw)).toBe(friendlyLdapError("connection reset"));
        expect(friendlyLdapError("ldap: connection closed unexpectedly")).not.toContain("connection closed");
    });

    it("passes unknown messages through unchanged", () => {
        const raw = "some completely unknown sidecar failure";
        expect(friendlyLdapError(raw)).toBe(raw);
    });

    it("handles empty input", () => {
        expect(friendlyLdapError("")).toBe("");
    });
});

describe("parseLdapErrorMeta (后端 [ldap-code=..] 前缀契约)", () => {
    it("parses code and matchedDn from the machine-readable prefix", () => {
        const meta = parseLdapErrorMeta(
            '[ldap-code=65] [ldap-matched=dc=example,dc=com] LDAP Result Code 65 "Object Class Violation": missing must',
        );
        expect(meta.resultCode).toBe(65);
        expect(meta.matchedDn).toBe("dc=example,dc=com");
    });

    it("parses the code prefix without matchedDn", () => {
        const meta = parseLdapErrorMeta(
            '[ldap-code=68] LDAP Result Code 68 "Entry Already Exists": cn=dup,ou=people',
        );
        expect(meta.resultCode).toBe(68);
        expect(meta.matchedDn).toBeUndefined();
    });

    it("returns an empty object for messages without the prefix", () => {
        expect(parseLdapErrorMeta('LDAP Result Code 49 "Invalid Credentials": password wrong')).toEqual({});
        expect(parseLdapErrorMeta("plain sidecar failure")).toEqual({});
        expect(parseLdapErrorMeta("")).toEqual({});
    });
});

describe("friendlyLdapError 对结果码 68 / 带前缀消息的行为", () => {
    it("maps result code 68 (entry already exists) to the localized message", () => {
        const raw = 'LDAP Result Code 68 "Entry Already Exists": cn=dup,ou=people';
        const mapped = friendlyLdapError(raw);
        expect(mapped).not.toBe("");
        expect(mapped).not.toBe(raw);
    });

    it("maps the [ldap-code=68] prefixed message the same as the plain text form", () => {
        const raw = '[ldap-code=68] LDAP Result Code 68 "Entry Already Exists": cn=dup,ou=people';
        const plain = 'LDAP Result Code 68 "Entry Already Exists": cn=dup,ou=people';
        expect(friendlyLdapError(raw)).toBe(friendlyLdapError(plain));
        expect(friendlyLdapError(raw)).not.toBe(raw);
    });

    it("still maps prefixed code-49 messages via the original invalidCredentials rule", () => {
        const raw = '[ldap-code=49] LDAP Result Code 49 "Invalid Credentials": password wrong';
        const plain = 'LDAP Result Code 49 "Invalid Credentials": password wrong';
        expect(friendlyLdapError(raw)).toBe(friendlyLdapError(plain));
        expect(friendlyLdapError(raw)).not.toBe(raw);
    });

    it("keeps non-prefixed behavior unchanged (unknown pass-through)", () => {
        const raw = "some completely unknown sidecar failure";
        expect(friendlyLdapError(raw)).toBe(raw);
    });
});
