// lib/psCommandImport 纯函数单测：Get-AD*/Get-QAD* 命令 → 搜索表单条件。
// 覆盖：参数映射（-Filter/-SearchBase/-SearchScope/-SizeLimit/-Properties）、
// PS Filter → RFC 4515（-eq/-like/-ne/-and/-or/-not/通配符/引号）、
// -LdapFilter 直通、Identity 位置参数、objectClass 隐含约束、错误分支。
import { describe, expect, it } from "vitest";
import { convertPsFilter, parsePsAdCommand } from "./psCommandImport";

describe("parsePsAdCommand basics", () => {
  it("maps -SearchBase/-SearchScope/-SizeLimit/-Properties", () => {
    const result = parsePsAdCommand(
      "Get-ADUser -Filter 'sn -eq \"Smith\"' -SearchBase 'OU=People,DC=demo,DC=dbx' -SearchScope OneLevel -SizeLimit 100 -Properties mail,displayName",
    );
    expect(result.ok).toBe(true);
    expect(result.search).toEqual({
      baseDn: "OU=People,DC=demo,DC=dbx",
      scope: "one",
      filter: "(sn=Smith)",
      attributes: ["mail", "displayName"],
      sizeLimit: 100,
    });
  });

  it("rejects non-AD cmdlets", () => {
    expect(parsePsAdCommand("Get-Process | fl").reason).toBe("unknownCommand");
    expect(parsePsAdCommand("").reason).toBe("empty");
  });

  it("collects unknown switches into ignored without failing", () => {
    const result = parsePsAdCommand("Get-ADUser -Filter 'name -eq \"a\"' -Credential foo -Server dc1");
    expect(result.ok).toBe(true);
    expect(result.ignored).toEqual(["-Credential", "foo", "-Server", "dc1"]);
  });
});

describe("PS Filter conversion", () => {
  it("converts -eq / -like with wildcards", () => {
    expect(convertPsFilter('SamAccountName -like "j*"', [])).toBe("(sAMAccountName=j*)");
    expect(convertPsFilter('sn -eq "Smith"', [])).toBe("(sn=Smith)");
  });

  it("converts -ne into negation and -and/-or into &/|", () => {
    expect(convertPsFilter('sn -ne "Smith"', [])).toBe("(!(sn=Smith))");
    expect(convertPsFilter('sn -eq "A" -and givenName -eq "B"', [])).toBe("(&(sn=A)(givenName=B))");
    expect(convertPsFilter('sn -eq "A" -or sn -eq "B"', [])).toBe("(|(sn=A)(sn=B))");
  });

  it("converts -not and brace blocks", () => {
    expect(convertPsFilter('{-not (Enabled -eq "True")}', [])).toBe("(!(userAccountControl=True))");
  });

  it("downgrades -gt/-lt with a note via negated fallback", () => {
    const notes: string[] = [];
    expect(convertPsFilter("badPwdCount -gt 3", notes)).toBe("(!(badPwdCount<=3))");
    expect(notes.join()).toContain("op:-gt");
  });

  it("escapes LDAP special characters in values", () => {
    expect(convertPsFilter('cn -eq "a(b)c"', [])).toBe("(cn=a\\28b\\29c)");
  });

  it("returns null for unparseable filters", () => {
    expect(convertPsFilter('sn -weird "x"', [])).toBeNull();
  });
});

describe("Get-QAD support", () => {
  it("maps -SearchRoot and passes -LdapFilter through verbatim", () => {
    const result = parsePsAdCommand(
      "Get-QADUser -SearchRoot 'OU=People,DC=demo,DC=dbx' -LdapFilter '(objectClass=inetOrgPerson)' -SizeLimit 50",
    );
    expect(result.ok).toBe(true);
    expect(result.search.baseDn).toBe("OU=People,DC=demo,DC=dbx");
    expect(result.search.filter).toBe("(objectClass=inetOrgPerson)");
    expect(result.search.sizeLimit).toBe(50);
  });
});

describe("identity handling", () => {
  it("positional identity becomes an sAMAccountName/name OR filter wrapped with objectClass", () => {
    const result = parsePsAdCommand("Get-ADUser jsmith -SearchBase 'DC=demo,DC=dbx'");
    expect(result.ok).toBe(true);
    expect(result.search.filter).toBe("(&(objectClass=user)(|(sAMAccountName=jsmith)(name=jsmith)))");
  });

  it("group identity targets cn/name", () => {
    const result = parsePsAdCommand("Get-ADGroup 'Dev Team' -SearchBase 'DC=demo,DC=dbx'");
    expect(result.search.filter).toBe("(&(objectClass=group)(|(cn=Dev Team)(name=Dev Team)))");
  });

  it("filter-less command falls back to objectClass-only", () => {
    const result = parsePsAdCommand("Get-ADUser -SearchBase 'DC=demo,DC=dbx'");
    expect(result.search.filter).toBe("(objectClass=user)");
  });
});
