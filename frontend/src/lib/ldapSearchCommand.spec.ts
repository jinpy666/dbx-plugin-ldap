import { describe, expect, it } from "vitest";
import { parseLdapSearchCommand } from "./ldapSearchCommand";

describe("parseLdapSearchCommand", () => {
    it("parses a full documented command into search fields", () => {
        const result = parseLdapSearchCommand(
            'ldapsearch -x -LLL -H ldap://ldap.example.com -D "cn=admin,dc=example,dc=com" -w secret -b "dc=example,dc=com" -s one "(uid=jin)" mail cn',
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.search).toEqual({
            baseDn: "dc=example,dc=com",
            scope: "one",
            filter: "(uid=jin)",
            attributes: ["mail", "cn"],
            sizeLimit: undefined,
            typesOnly: false,
            derefAliases: undefined,
        });
        // Bind options are dropped: the workbench uses the saved connection.
        expect(result.ignoredConnection).toEqual(["-H", "-D", "-w", "-x"]);
        expect(result.ignoredUnsupported).toEqual(["-LLL"]);
    });

    it("never leaks the bind password into the parsed result", () => {
        const result = parseLdapSearchCommand('ldapsearch -x -w "p@ss word" -b dc=example,dc=com "(objectClass=*)"');
        expect(result.ok).toBe(true);
        expect(JSON.stringify(result)).not.toContain("p@ss word");
    });

    it("joins backslash line continuations from pasted multi-line commands", () => {
        const result = parseLdapSearchCommand(
            '$ ldapsearch -x \\\n  -b dc=example,dc=com \\\n  "(mail=*@example.com)" \\\n  mail',
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.search.baseDn).toBe("dc=example,dc=com");
        expect(result.search.filter).toBe("(mail=*@example.com)");
        expect(result.search.attributes).toEqual(["mail"]);
    });

    it("treats the first token as the program name (paths, Windows, prompts)", () => {
        for (const command of [
            "ldapsearch -b dc=example,dc=com",
            "/usr/bin/ldapsearch -b dc=example,dc=com",
            '"C:\\tools\\ldapsearch.exe" -b dc=example,dc=com',
        ]) {
            const result = parseLdapSearchCommand(command);
            expect(result.ok, command).toBe(true);
            if (!result.ok) continue;
            expect(result.search.baseDn).toBe("dc=example,dc=com");
        }
    });

    it("defaults to match-all and keeps attributes empty when absent", () => {
        const result = parseLdapSearchCommand("ldapsearch -b dc=example,dc=com");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.search.filter).toBe("(objectClass=*)");
        expect(result.search.attributes).toEqual([]);
    });

    it("maps -s children to subtree with a note", () => {
        const result = parseLdapSearchCommand("ldapsearch -b dc=example,dc=com -s children");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.search.scope).toBe("sub");
        expect(result.notes).toContain("scopeChildren");
    });

    it("maps -a deref values onto the form vocabulary", () => {
        expect(parseLdapSearchCommand("ldapsearch -b dc=x -a search").ok &&
            parseLdapSearchCommand("ldapsearch -b dc=x -a search").search.derefAliases).toBe("searching");
        expect(parseLdapSearchCommand("ldapsearch -b dc=x -a find").ok &&
            parseLdapSearchCommand("ldapsearch -b dc=x -a find").search.derefAliases).toBe("finding");
        expect(parseLdapSearchCommand("ldapsearch -b dc=x -a always").ok &&
            parseLdapSearchCommand("ldapsearch -b dc=x -a always").search.derefAliases).toBe("always");
        expect(parseLdapSearchCommand("ldapsearch -b dc=x -a never").ok &&
            parseLdapSearchCommand("ldapsearch -b dc=x -a never").search.derefAliases).toBe("never");
    });

    it("maps -A and -z onto typesOnly and sizeLimit", () => {
        const result = parseLdapSearchCommand("ldapsearch -A -z 100 -b dc=example,dc=com");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.search.typesOnly).toBe(true);
        expect(result.search.sizeLimit).toBe(100);
    });

    it("collects unsupported options without dropping positional values", () => {
        const result = parseLdapSearchCommand(
            "ldapsearch -o ldif-wrap=no -l 30 -E pr=100/noprompt -v -c -u -t -b dc=example,dc=com (uid=a) mail",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.ignoredUnsupported).toEqual(["-o", "-l", "-E", "-v", "-c", "-u", "-t"]);
        expect(result.search.filter).toBe("(uid=a)");
        expect(result.search.attributes).toEqual(["mail"]);
    });

    it("handles clustered boolean flags like -xLLL", () => {
        const result = parseLdapSearchCommand("ldapsearch -xLLL -b dc=example,dc=com");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.ignoredConnection).toContain("-x");
        expect(result.ignoredUnsupported).toContain("-L");
    });

    it("rejects -f (filter file) with an explicit reason", () => {
        const result = parseLdapSearchCommand("ldapsearch -x -b dc=example,dc=com -f filters.txt");
        expect(result).toMatchObject({ ok: false, reason: "filterFile", flag: "-f" });
    });

    it("rejects an invalid scope value", () => {
        const result = parseLdapSearchCommand("ldapsearch -b dc=example,dc=com -s sideways");
        expect(result).toMatchObject({ ok: false, reason: "scope", value: "sideways" });
    });

    it("rejects a non-numeric size limit", () => {
        const result = parseLdapSearchCommand("ldapsearch -b dc=example,dc=com -z lots");
        expect(result).toMatchObject({ ok: false, reason: "sizeLimit", value: "lots" });
    });

    it("rejects a malformed filter with the offending text", () => {
        const result = parseLdapSearchCommand("ldapsearch -b dc=example,dc=com (uid=unclosed");
        expect(result).toMatchObject({ ok: false, reason: "filter", value: "(uid=unclosed" });
    });

    it("rejects an option left without its value", () => {
        const result = parseLdapSearchCommand("ldapsearch -b");
        expect(result).toMatchObject({ ok: false, reason: "missingValue", flag: "-b" });
    });

    it("rejects empty input", () => {
        expect(parseLdapSearchCommand("   ")).toMatchObject({ ok: false, reason: "empty" });
    });

    it("treats -- as the end of options", () => {
        const result = parseLdapSearchCommand("ldapsearch -b dc=example,dc=com -- (uid=a)");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.search.filter).toBe("(uid=a)");
    });
});
