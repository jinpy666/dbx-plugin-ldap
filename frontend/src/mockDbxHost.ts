/**
 * Visual fixture host bridge for the LDAP workbench (mock.html).
 *
 * Mirrors the ssh-sftp mockDbxHost pattern: an in-memory directory + a
 * `window.dbxPlugin` implementation so the workbench runs in a plain browser
 * (pnpm dev → /mock.html). URL params:
 *   ?theme=light|dark   appearance scheme (default dark)
 *   ?locale=zh-CN|en|…  workbench locale (default zh-CN)
 *   ?err=1              ldap/search always rejects (error-state fixture)
 *   ?noconn=1           host context has no connectionId (init error fixture)
 *   ?ro=1               readOnly connection (write actions disabled; write
 *                       attempts emit a denied `ldap/audit` event first, then
 *                       reject — mirrors the backend write-policy branch)
 */
import "./style.css";
import { parseRdnAttributes, splitFirstDnRdn } from "./lib/dn";
import { unescapeLdapFilterValue, validateLDAPFilter } from "./lib/ldapFilter";

const eventListeners = new Set<(event: DbxPluginEvent) => void>();
const appearanceListeners = new Set<(appearance: DbxPluginAppearance) => void>();
const contextListeners = new Set<(context: Record<string, unknown>) => void>();

const params = new URLSearchParams(location.search);
const readOnly = params.get("ro") === "1";

const context: Record<string, unknown> = {
  connectionId: params.get("noconn") === "1" ? "" : "visual-connection",
  workbenchId: "visual-workbench",
  restored: false,
  connection: {
    name: "Demo Directory",
    host: "ldap.demo.internal",
    port: 389,
    username: "cn=admin,dc=demo,dc=dbx",
    color: "#8b5cf6",
    readOnly,
    baseDn: "dc=demo,dc=dbx",
  },
};

const light = params.get("theme") === "light";
// 与 DBX globals.css 的 :root（pearl 浅色）和 .dark 规范块保持一致。
const appearance: DbxPluginAppearance = {
  colorScheme: light ? "light" : "dark",
  colors: light
    ? { background: "rgb(255 255 255)", foreground: "rgb(10 10 10)", muted: "rgb(245 245 245)", mutedForeground: "rgb(115 115 115)", accent: "rgb(245 245 245)", accentForeground: "rgb(23 23 23)", border: "rgb(229 229 229)", destructive: "rgb(231 0 11)" }
    : { background: "rgb(19 20 22)", foreground: "rgb(215 215 219)", muted: "rgb(42 42 45)", mutedForeground: "rgb(151 152 157)", accent: "rgb(46 47 51)", accentForeground: "rgb(221 221 226)", border: "rgb(110 110 114 / 0.28)", destructive: "rgb(243 98 95)" },
  terminal: { fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13 },
};

// 镜像宿主 1.1 theme 通道形状（colors 反查 --color-* 令牌），与真实宿主一致。
const theme: DbxPluginTheme = {
  appearance: appearance.colorScheme,
  tokens: Object.fromEntries(
    Object.entries(appearance.colors).map(([key, value]) => [`--color-${key.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`)}`, value]),
  ),
};

// -- in-memory directory ------------------------------------------------------

interface MockEntry {
  dn: string;
  attributes: Record<string, string[]>;
}

const BASE_DN = "dc=demo,dc=dbx";
const directory = new Map<string, MockEntry>();

function put(dn: string, attributes: Record<string, string[]>) {
  directory.set(dn.toLowerCase(), { dn, attributes });
}

function get(dn: string): MockEntry | undefined {
  return directory.get(dn.toLowerCase());
}

function attributeKey(attributes: MockEntry["attributes"], name: string): string {
  return Object.keys(attributes).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
}

function selectAttributes(attributes: MockEntry["attributes"], requested: unknown, typesOnly = false, rootDse = false): MockEntry["attributes"] {
  const names = Array.isArray(requested) ? requested.map((name) => String(name).trim().toLowerCase()).filter(Boolean) : [];
  // Directory fixtures contain user attributes; RootDSE metadata is operational
  // except objectClass. dn is entry metadata, not an alias for '*'.
  return Object.fromEntries(Object.entries(attributes)
    .filter(([name]) => names.includes(name.toLowerCase()) ||
      (rootDse && name.toLowerCase() !== "objectclass" ? names.includes("+") : names.length === 0 || names.includes("*")))
    .map(([name, values]) => [name, typesOnly ? [] : [...values]]));
}

put(BASE_DN, { dc: ["demo"], o: ["Demo Organization"], objectClass: ["dcObject", "organization"] });
put(`ou=people,${BASE_DN}`, { ou: ["people"], objectClass: ["organizationalUnit"] });
put(`ou=groups,${BASE_DN}`, { ou: ["groups"], cn: ["groups"], objectClass: ["organizationalUnit"] });
// managedBy→用户 DN（AD 的 OU 管理者语义）：条目关联视图 DN 引用 / 被引用两区
// 的 fixture——正查直读本条目 managedBy，反查 (managedBy=<DN>) 通用等值求值可命中。
put(`ou=services,${BASE_DN}`, { ou: ["services"], managedBy: [`uid=user0000,ou=people,${BASE_DN}`], objectClass: ["organizationalUnit"] });
put(`cn=ldap,ou=services,${BASE_DN}`, { cn: ["ldap"], objectClass: ["applicationProcess"] });
put(`cn=web,ou=services,${BASE_DN}`, { cn: ["web"], objectClass: ["applicationProcess"] });
put(`cn=admins,ou=groups,${BASE_DN}`, { cn: ["admins"], memberUid: ["user1", "user2", "user3"], objectClass: ["groupOfNames"] });
put(`cn=devs,ou=groups,${BASE_DN}`, { cn: ["devs"], memberUid: ["user4"], objectClass: ["groupOfNames"] });
// groupOfNames 条目（member 存成员 DN）：条目关联视图 Members/Member Of 的
// fixture——(member=<DN>) 子树反查无需改过滤器求值即可命中。
put(`cn=team-a,ou=groups,${BASE_DN}`, {
  cn: ["team-a"],
  member: [
    `uid=user0000,ou=people,${BASE_DN}`,
    `uid=user0001,ou=people,${BASE_DN}`,
    `uid=user0002,ou=people,${BASE_DN}`,
  ],
  objectClass: ["groupOfNames"],
});

for (let index = 0; index < 1000; index += 1) {
  const uid = `user${String(index).padStart(4, "0")}`;
  put(`uid=${uid},ou=people,${BASE_DN}`, {
    uid: [uid],
    cn: [`User ${index}`],
    sn: [`Surname${index}`],
    mail: [`${uid}@demo.internal`],
    telephoneNumber: [`+1 555 0${String(index).padStart(4, "0")}`],
    objectClass: ["inetOrgPerson", "organizationalPerson", "person", "top"],
  });
}

// -- RFC 4515 filter evaluation (fixture-grade) -------------------------------

type EntryMatcher = (entry: MockEntry) => boolean;
const integerValue = (value: string): bigint | null => /^(?:0|-?[1-9][0-9]*)$/u.test(value) ? BigInt(value) : null;

function compileFilterItem(attribute: string, operator: string, rawValue: string): EntryMatcher {
  const values = (entry: MockEntry) => entry.attributes[attributeKey(entry.attributes, attribute)] ?? [];
  if (operator === "~=" || operator === ":=" ||
      (operator !== "=" && !["uidnumber", "gidnumber"].includes(attribute.toLowerCase()))) {
    throw new Error("LDAP filter matching rule is not implemented in the fixture");
  }
  if (operator === ">=" || operator === "<=") {
    const expected = integerValue(unescapeLdapFilterValue(rawValue));
    return (entry) => expected !== null && values(entry).some((value) => {
      const actual = integerValue(value);
      return actual !== null && (operator === ">=" ? actual >= expected : actual <= expected);
    });
  }
  if (rawValue === "*") return (entry) => values(entry).length > 0;
  if (!rawValue.includes("*")) {
    const expected = unescapeLdapFilterValue(rawValue).toLowerCase();
    return (entry) => values(entry).some((value) => value.toLowerCase() === expected);
  }
  const parts = rawValue.split("*").map(unescapeLdapFilterValue).map((part) => part.toLowerCase());
  return (entry) => values(entry).some((value) => {
    const text = value.toLowerCase();
    let cursor = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === "") continue;
      const found = text.indexOf(part, cursor);
      if (found < 0) return false;
      if (index === 0 && found !== 0) return false;
      cursor = found + part.length;
    }
    if (parts[parts.length - 1] !== "" && !text.endsWith(parts[parts.length - 1])) return false;
    return true;
  });
}

function compileFilter(filter: string): EntryMatcher {
  const text = filter.trim();
  if (!validateLDAPFilter(text)) throw new Error("invalid LDAP filter");
  let position = 0;
  // Compile every leaf before scanning entries. A matching OR branch or an
  // empty directory must not hide a matching rule the fixture cannot emulate.
  const parse = (): EntryMatcher => {
    position += 1; // opening parenthesis; structure was validated above
    const operator = text[position];
    if (operator === "&" || operator === "|") {
      position += 1;
      const children: EntryMatcher[] = [];
      while (text[position] === "(") children.push(parse());
      position += 1;
      return (entry) => operator === "&" ? children.every((child) => child(entry)) : children.some((child) => child(entry));
    }
    if (operator === "!") {
      position += 1;
      const child = parse();
      position += 1;
      return (entry) => !child(entry);
    }
    const close = text.indexOf(")", position);
    const item = /^([^=]*?)(>=|<=|~=|:=|=)([\s\S]*)$/u.exec(text.slice(position, close));
    if (!item) throw new Error("invalid LDAP filter");
    position = close + 1;
    return compileFilterItem(item[1], item[2], item[3]);
  };
  return parse();
}

function dnInSearchScope(dn: string, baseDn: string, scope: string): boolean {
  if (scope === "base") return dn.toLowerCase() === baseDn.toLowerCase();
  if (scope === "one") return splitFirstDnRdn(dn).parentDn.toLowerCase() === baseDn.toLowerCase();
  return dnWithinBase(dn, baseDn);
}

function needsAliasDereference(baseDn: string, scope: string, mode: string): boolean {
  const finding = mode === "finding" || mode === "always";
  const searching = mode === "searching" || mode === "always";
  if (!finding && !searching) return false;
  for (const entry of directory.values()) {
    const classes = entry.attributes[attributeKey(entry.attributes, "objectClass")] ?? [];
    if (classes.some((value) => value.toLowerCase() === "alias")) {
      // Finding may encounter an alias anywhere in the base's ancestor path.
      // Searching only dereferences aliases below the base, within the scope.
      if ((finding && dnWithinBase(baseDn, entry.dn)) ||
          (searching && entry.dn.toLowerCase() !== baseDn.toLowerCase() && dnInSearchScope(entry.dn, baseDn, scope))) {
        return true;
      }
    }
  }
  return false;
}

function dnWithinBase(dn: string, baseDn: string): boolean {
  const a = dn.toLowerCase();
  const b = baseDn.toLowerCase();
  return a === b || a.endsWith(`,${b}`);
}

function search(params_: Record<string, unknown>) {
  if (params.get("err") === "1") throw new Error("connection lost (fixture error injection)");
  const baseDn = String(params_.baseDn ?? "").trim() || BASE_DN;
  const filter = String(params_.filter ?? "").trim() || "(objectClass=*)";
  const matches = compileFilter(filter);
  const scope = String(params_.scope ?? "sub").trim().toLowerCase();
  const paged = Number(params_.pageSize) > 0;
  const sizeLimit = Math.max(0, Number(params_.sizeLimit) || 0);
  const limit = paged ? sizeLimit || 500 : sizeLimit;
  // Resolution remains unsupported; unrelated aliases must not reject a query.
  if (needsAliasDereference(baseDn, scope, String(params_.derefAliases ?? "never").trim().toLowerCase())) {
    throw new Error("alias dereferencing is not implemented in the fixture");
  }
  const matched: MockEntry[] = [];
  // 非分页路径的截断标志：预读确认真溢出后才置位（恰好等于上限不算截断）。
  let overflowed = false;
  for (const entry of directory.values()) {
    if (!dnInSearchScope(entry.dn, baseDn, scope)) continue;
    if (!matches(entry)) continue;
    if (limit > 0 && matched.length >= limit && !paged) {
      // 非分页 sizeLimit 命中：对齐真实 sidecar 聚合语义——条目照给前 limit
      // 条 + truncated 标志，不再抛 Size Limit Exceeded 硬错误（DnPicker 等
      // 只读浏览遇到大 OU 时降级为截断展示而非报错）。
      overflowed = true;
      break;
    }
    matched.push(entry);
    if (limit > 0 && matched.length >= limit && paged) break;
  }
  const entries = matched.map((entry) => ({
    dn: entry.dn,
    attributes: selectAttributes(entry.attributes, params_.attributes, params_.typesOnly === true),
  }));
  // 分页路径保持 Go pagedSearchEntries 的 exact-limit 标志（达上限即
  // truncated）；非分页路径以预读结果诚实置位。pageSize 是传输页大小，
  // 不是 UI 页。服务端分页控件特有故障（如 OpenLDAP sizeLimit 交互）不做模拟。
  return { entries, count: entries.length, truncated: paged ? entries.length >= limit : overflowed, baseDn, filter };
}

interface SearchSession {
  entries: MockEntry[];
  pageSize: number;
  position: number;
}

const searchSessions = new Map<string, SearchSession>();
let nextSearchSessionId = 1;

// The fixture mirrors the sidecar's cursor protocol so the large People OU
// demonstrates true continuation instead of repeatedly re-reading page one.
function startSearchSession(params_: Record<string, unknown>) {
  if (params.get("err") === "1") throw new Error("connection lost (fixture error injection)");
  const baseDn = String(params_.baseDn ?? "").trim() || BASE_DN;
  const filter = String(params_.filter ?? "").trim() || "(objectClass=*)";
  const matches = compileFilter(filter);
  const scope = String(params_.scope ?? "sub").trim().toLowerCase();
  const pageSize = Math.max(1, Number(params_.pageSize) || 500);
  if (needsAliasDereference(baseDn, scope, String(params_.derefAliases ?? "never").trim().toLowerCase())) {
    throw new Error("alias dereferencing is not implemented in the fixture");
  }
  const entries = Array.from(directory.values()).filter((entry) => dnInSearchScope(entry.dn, baseDn, scope) && matches(entry));
  const searchId = `fixture-search-${nextSearchSessionId++}`;
  searchSessions.set(searchId, { entries, pageSize, position: 0 });
  return nextSearchSession({ ...params_, searchId });
}

function nextSearchSession(params_: Record<string, unknown>) {
  const searchId = String(params_.searchId ?? "");
  const session = searchSessions.get(searchId);
  if (!session) throw new Error("search session not found or expired");
  const page = session.entries.slice(session.position, session.position + session.pageSize);
  session.position += page.length;
  const hasMore = session.position < session.entries.length;
  if (!hasMore) searchSessions.delete(searchId);
  return {
    searchId,
    entries: page.map((entry) => ({
      dn: entry.dn,
      attributes: selectAttributes(entry.attributes, params_.attributes, params_.typesOnly === true),
    })),
    hasMore,
  };
}

function cancelSearchSession(params_: Record<string, unknown>) {
  searchSessions.delete(String(params_.searchId ?? ""));
  return { success: true };
}

// ldap/count（A-LDAP 契约：scope=one，上限 5000）——直接子条目精确计数，
// 不受 search sizeLimit 截断影响；超上限折算为 truncated:true。
function countChildren(params_: Record<string, unknown>): { count: number; truncated: boolean } {
  if (params.get("err") === "1") throw new Error("connection lost (fixture error injection)");
  const baseDn = String(params_.baseDn ?? "").trim() || BASE_DN;
  const filter = String(params_.filter ?? "").trim() || "(objectClass=*)";
  const matches = compileFilter(filter);
  const limit = 5000;
  let count = 0;
  let truncated = false;
  for (const entry of directory.values()) {
    if (!dnInSearchScope(entry.dn, baseDn, "one")) continue;
    if (!matches(entry)) continue;
    count += 1;
    if (count >= limit) {
      truncated = true;
      break;
    }
  }
  return { count, truncated };
}

// -- schema fixture (RFC 4512 descriptions) -----------------------------------

const attributeTypeDefinitions = [
  "( 2.5.4.3 NAME ( 'cn' 'commonName' ) SUP name )",
  "( 2.5.4.4 NAME ( 'sn' 'surname' ) SUP name )",
  "( 2.5.4.12 NAME 'title' SUP name )",
  "( 2.5.4.41 NAME 'name' EQUALITY caseIgnoreMatch SUBSTR caseIgnoreSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{32768} )",
  "( 2.5.4.42 NAME ( 'givenName' 'gn' ) SUP name )",
  "( 0.9.2342.19200300.100.1.1 NAME ( 'uid' 'userid' ) EQUALITY caseIgnoreMatch SUBSTR caseIgnoreSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{256} )",
  "( 1.3.6.1.1.1.1.0 NAME 'uidNumber' EQUALITY integerMatch ORDERING integerOrderingMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.27 SINGLE-VALUE )",
  "( 1.3.6.1.1.1.1.1 NAME 'gidNumber' EQUALITY integerMatch ORDERING integerOrderingMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.27 SINGLE-VALUE )",
  "( 0.9.2342.19200300.100.1.3 NAME ( 'mail' 'rfc822Mailbox' ) EQUALITY caseIgnoreIA5Match SUBSTR caseIgnoreIA5SubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.26{256} )",
  "( 2.5.4.0 NAME 'objectClass' EQUALITY objectIdentifierMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.38 )",
  "( 2.5.4.10 NAME ( 'o' 'organizationName' ) EQUALITY caseIgnoreMatch SUBSTR caseIgnoreSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{64} )",
  "( 2.5.4.11 NAME ( 'ou' 'organizationalUnitName' ) EQUALITY caseIgnoreMatch SUBSTR caseIgnoreSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{64} )",
  "( 2.5.4.7 NAME ( 'l' 'localityName' ) SUP name )",
  "( 2.5.4.20 NAME 'telephoneNumber' EQUALITY telephoneNumberMatch SUBSTR telephoneNumberSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.50{32} )",
  "( 2.5.4.31 NAME 'member' SUP distinguishedName )",
  "( 2.5.4.49 NAME 'distinguishedName' EQUALITY distinguishedNameMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.12 )",
  "( 2.5.4.50 NAME 'uniqueMember' EQUALITY nameAndOptionalUID SYNTAX 1.3.6.1.4.1.1466.115.121.1.34 )",
  // AD managedBy（OID 1.2.840.113556.1.4.218，DN 语法、单值）：DN 引用正查识别 fixture。
  "( 1.2.840.113556.1.4.218 NAME 'managedBy' EQUALITY distinguishedNameMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.12 SINGLE-VALUE )",
  "( 2.16.840.1.113730.3.1.241 NAME 'displayName' SUP name )",
  "( 2.5.4.18 NAME 'seeAlso' SUP distinguishedName )",
  "( 2.5.4.13 NAME 'description' EQUALITY caseIgnoreMatch SUBSTR caseIgnoreSubstringsMatch SYNTAX 1.3.6.1.4.1.1466.115.121.1.15{1024} )",
];

const objectClassDefinitions = [
  "( 2.5.6.0 NAME 'top' ABSTRACT MUST objectClass )",
  "( 2.5.6.4 NAME 'organization' SUP top STRUCTURAL MUST o MAY ( userPassword $ searchGuide $ seeAlso $ businessCategory $ x500UniqueIdentifier $ preferredDeliveryMethod ) )",
  "( 2.5.6.5 NAME 'organizationalUnit' SUP top STRUCTURAL MUST ou MAY ( userPassword $ searchGuide $ seeAlso $ businessCategory ) )",
  "( 2.5.6.6 NAME 'person' SUP top STRUCTURAL MUST ( sn $ cn ) MAY ( userPassword $ telephoneNumber $ seeAlso $ description ) )",
  "( 2.5.6.7 NAME 'organizationalPerson' SUP person STRUCTURAL MAY ( title $ x121Address $ registeredAddress $ destinationIndicator $ preferredDeliveryMethod $ telexNumber $ teletexTerminalIdentifier $ telephoneNumber $ internationaliSDNNumber $ facsimileTelephoneNumber $ street $ postOfficeBox $ postalCode $ postalAddress $ physicalDeliveryOfficeName $ ou $ st $ l ) )",
  "( 2.16.840.1.113730.3.2.2 NAME 'inetOrgPerson' SUP organizationalPerson STRUCTURAL MAY ( audio $ businessCategory $ carLicense $ departmentNumber $ displayName $ employeeNumber $ employeeType $ givenName $ homePhone $ homePostalAddress $ initials $ jpegPhoto $ labeledURI $ mail $ manager $ mobile $ o $ pager $ photo $ roomNumber $ secretary $ uid $ userCertificate $ x500uniqueIdentifier $ preferredLanguage $ userSMIMECertificate $ userPKCS12 ) )",
  "( 2.5.6.9 NAME 'groupOfNames' SUP top STRUCTURAL MUST ( cn $ member ) MAY ( businessCategory $ seeAlso $ owner $ ou $ o $ description ) )",
  "( 2.5.6.1 NAME 'alias' SUP top STRUCTURAL MUST aliasedObjectName )",
  "( 2.5.6.2 NAME 'country' SUP top STRUCTURAL MUST c MAY ( searchGuide $ description ) )",
  "( 2.5.6.3 NAME 'locality' SUP top STRUCTURAL MUST l MAY ( searchGuide $ description ) )",
  "( 1.3.6.1.4.1.1466.115.121.1.15 NAME 'applicationProcess' SUP top STRUCTURAL MUST cn MAY ( seeAlso $ ou $ l $ description ) )",
  "( 2.5.20.1 NAME 'subschema' AUXILIARY MAY ( dITContentRules $ dITStructureRules $ namingContexts $ subordinateSuffix $ objectClasses $ attributeTypes $ matchingRules $ matchingRuleUse ) )",
];

// 五分类 Schema（F2b）fixture：三类补充定义，供 SchemaPanel 页签与明细走查。
const matchingRuleDefinitions = [
  { oid: "2.5.13.2", names: ["caseIgnoreMatch"], desc: "case ignore matching of Directory String", syntax: "1.3.6.1.4.1.1466.115.121.1.15" },
  { oid: "2.5.13.5", names: ["caseExactMatch"], desc: "case exact matching of Directory String", syntax: "1.3.6.1.4.1.1466.115.121.1.15" },
  { oid: "2.5.13.14", names: ["integerMatch"], desc: "integer matching", syntax: "1.3.6.1.4.1.1466.115.121.1.27" },
];
const matchingRuleUseDefinitions = [
  { oid: "2.5.13.2", names: ["caseIgnoreMatch"], attributeTypes: ["cn", "sn", "uid"] },
];
const ldapSyntaxDefinitions = [
  { oid: "1.3.6.1.4.1.1466.115.121.1.15", desc: "Directory String" },
  { oid: "1.3.6.1.4.1.1466.115.121.1.27", desc: "Integer" },
];

// -- request / invoke ----------------------------------------------------------

const request: DbxPluginApi["request"] = async <T = unknown>(method: string) =>
  (method === "host.getContext" ? context : null) as T;

// 事件注入（与 sidecar emitter.Event 同面）：denied audit fixture 用。
function emitEvent(method: string, eventParams: Record<string, unknown>) {
  for (const listener of eventListeners) listener({ method, params: eventParams } as DbxPluginEvent);
}

// readOnly 下写操作被策略拒绝：先发 denied audit 事件（App.vue showError 横幅
// 与 audit.jsonl 的 denied 语义对应），再抛业务错误（与后端 write-policy 分支
// 行为一致：AuditRecord{Action:"write-policy", Result:"denied"}）。
function denyWrite(target: string): never {
  emitEvent("ldap/audit", {
    connectionId: context.connectionId,
    action: "write-policy",
    target,
    result: "denied",
    detail: "connection is read-only (fixture)",
  });
  throw new Error("connection is read-only (fixture)");
}

const invoke: DbxPluginApi["invoke"] = async <T = unknown>(method: string, rawParams?: unknown) => {
  const input = (rawParams ?? {}) as Record<string, unknown>;
  let result: unknown = { success: true };
  if (method === "ldap/search") result = search(input);
  else if (method === "ldap/search/start") result = startSearchSession(input);
  else if (method === "ldap/search/next") result = nextSearchSession(input);
  else if (method === "ldap/search/cancel") result = cancelSearchSession(input);
  else if (method === "ldap/entry/get") {
    const entry = get(String(input.dn ?? ""));
    if (!entry) throw new Error(`entry not found: ${input.dn}`);
    result = { entry: { dn: entry.dn, attributes: selectAttributes(entry.attributes, input.attributes, input.typesOnly === true) } };
  } else if (method === "ldap/rootDse") {
    result = {
      attributes: selectAttributes({
        objectClass: ["top"],
        namingContexts: [BASE_DN],
        supportedLDAPVersion: ["3"],
        supportedControl: ["1.2.840.113556.1.4.319", "1.3.6.1.4.1.4203.1.10.1", "1.3.6.1.1.22"],
        supportedExtension: ["1.3.6.1.4.1.4203.1.11.1", "1.3.6.1.4.1.4203.1.11.3"],
        supportedSASLMechanisms: ["SIMPLE", "EXTERNAL"],
        subschemaSubentry: ["cn=Subschema"],
        vendorName: ["FixtureLDAP"],
        vendorVersion: ["FixtureLDAP/1.0"],
        productName: ["FixtureLDAP Server"],
      }, input.attributes, false, true),
    };
  } else if (method === "ldap/check") {
    // 连接体检（连接面板/F12 服务器信息用）：fixture 环境总是可达，
    // network 段给固定小延迟、bind 段按 fixture 放行。契约同后端 check.go。
    result = { ok: true, network: { ok: true, latencyMs: 1 }, bind: { ok: true } };
  } else if (method === "ldap/schema")
    result = {
      attributeTypes: attributeTypeDefinitions,
      objectClasses: objectClassDefinitions,
      matchingRules: matchingRuleDefinitions,
      matchingRuleUses: matchingRuleUseDefinitions,
      ldapSyntaxes: ldapSyntaxDefinitions,
    };
  else if (method === "ldap/count") result = countChildren(input);
  else if (method === "ldap/entry/childrenCount") {
    const dn = String(input.dn ?? "").trim();
    if (!dn) throw new Error("dn is required");
    result = countChildren({ baseDn: dn });
  }
  else if (method === "ldap/entry/add") {
    if (readOnly) denyWrite(String(input.dn ?? ""));
    const dn = String(input.dn ?? "");
    if (get(dn)) throw new Error(`entry already exists: ${dn}`);
    if (!dnWithinBase(dn, BASE_DN)) throw new Error(`base DN allowlist rejected: ${dn}`);
    put(dn, Object.fromEntries(Object.entries((input.attributes ?? {}) as Record<string, string[]>)));
  } else if (method === "ldap/entry/modify") {
    if (readOnly) denyWrite(String(input.dn ?? ""));
    const entry = get(String(input.dn ?? ""));
    if (!entry) throw new Error(`entry not found: ${input.dn}`);
    const changes = (input.changes ?? []) as Array<Record<string, unknown>>;
    if (!changes.length) throw new Error("changes is required");
    // LDAP modifications are atomic, including when a later change fails.
    const attributes = selectAttributes(entry.attributes, []);
    for (const [index, change] of changes.entries()) {
      const name = String(change.attribute ?? "").trim();
      if (!name) throw new Error(`change ${index} attribute is required`);
      const attribute = attributeKey(attributes, name);
      const operation = String(change.operation ?? "").trim().toLowerCase();
      const values = Array.isArray(change.values) ? (change.values as string[]).map(String) : [];
      const previous = attributes[attribute] ?? [];
      if (operation === "add" || operation === "replace") {
        if (!values.length || values.some((value) => !value.trim())) throw new Error(`attribute ${JSON.stringify(name)} requires non-empty values`);
        if (new Set(values).size !== values.length || (operation === "add" && values.some((value) => previous.includes(value)))) {
          throw new Error("LDAP attribute or value exists");
        }
        attributes[attribute] = operation === "add" ? [...previous, ...values] : values;
      } else if (operation === "delete") {
        if (!previous.length || values.some((value) => !previous.includes(value))) throw new Error("LDAP no such attribute");
        const remaining = values.length ? previous.filter((value) => !values.includes(value)) : [];
        if (remaining.length) attributes[attribute] = remaining;
        else delete attributes[attribute];
      } else throw new Error(`change ${index} operation must be add, replace, or delete`);
    }
    entry.attributes = attributes;
  } else if (method === "ldap/entry/compare") {
    // Compare（RFC 4511 §4.10）：按 caseIgnoreMatch 目录字符串默认规则比较
    // 属性首值；属性缺失/无值返回 match:false（compareFalse 走成功通道，非错误）。
    const entry = get(String(input.dn ?? ""));
    if (!entry) throw new Error(`entry not found: ${input.dn}`);
    const attribute = String(input.attribute ?? "").trim();
    if (!attribute) throw new Error("attribute is required");
    const values = Object.entries(entry.attributes).find(
      ([name]) => name.toLowerCase() === attribute.toLowerCase(),
    )?.[1] ?? [];
    result = { match: (values[0] ?? "").toLowerCase() === String(input.value ?? "").toLowerCase() };
  } else if (method === "ldap/whoami") {
    result = { authzId: "dn:cn=admin,dc=demo,dc=dbx" };
  } else if (method === "ldap/entry/passwdModify") {
    if (readOnly) denyWrite(String(input.dn ?? ""));
    const dn = String(input.identity ?? input.dn ?? "");
    const entry = get(dn);
    if (!entry) throw new Error(`entry not found: ${dn}`);
    // 密码值不落盘明文：写固定占位哈希（明文仅存在于请求参数内）。
    entry.attributes["userPassword"] = ["{SSHA}fixture-digest"];
    result = { success: true };
  } else if (method === "ldap/entry/delete") {
    if (readOnly) denyWrite(String(input.dn ?? ""));
    const dn = String(input.dn ?? "");
    if (!get(dn)) throw new Error(`entry not found: ${dn}`);
    // recursive=true（子树删除，N1）：fixture 简化版——收集目标子树全部 DN
    // 一次删除，不模拟 Tree Delete 控件/逐条回退分叉，也不设后端 1000 条
    // 上限（fixture 数据集远小于上限）。成功发一条聚合审计记录，与后端
    // subtreeDeleteAuditRecord 同形（action "subtree_delete"、deletedCount
    // 含目标自身）。
    if (input.recursive === true) {
      const targets: string[] = [];
      for (const entry of directory.values()) {
        if (dnWithinBase(entry.dn, dn)) targets.push(entry.dn);
      }
      for (const target of targets) directory.delete(target.toLowerCase());
      emitEvent("ldap/audit", {
        connectionId: context.connectionId,
        action: "subtree_delete",
        target: dn,
        result: "ok",
        deletedCount: targets.length,
      });
    } else {
      directory.delete(dn.toLowerCase());
    }
  } else if (method === "ldap/entry/modifyDn") {
    if (readOnly) denyWrite(String(input.dn ?? ""));
    const dn = String(input.dn ?? "");
    const entry = get(dn);
    if (!entry) throw new Error(`entry not found: ${dn}`);
    const newRdn = String(input.newRdn ?? "");
    const newNaming = parseRdnAttributes(newRdn);
    const oldNaming = parseRdnAttributes(splitFirstDnRdn(dn).rdn);
    const parentDn = String(input.newSuperior ?? "").trim() || splitFirstDnRdn(dn).parentDn;
    if (!get(parentDn)) throw new Error(`entry not found: ${parentDn}`);
    if (dnWithinBase(parentDn, dn)) throw new Error("cannot move an entry below itself");
    const newDn = `${newRdn},${parentDn}`;
    if (!dnWithinBase(newDn, BASE_DN)) throw new Error(`base DN allowlist rejected: ${newDn}`);
    if (get(newDn) && newDn.toLowerCase() !== dn.toLowerCase()) throw new Error(`entry already exists: ${newDn}`);
    const attributes = selectAttributes(entry.attributes, []);
    for (const { attribute, value } of newNaming) {
      const key = attributeKey(attributes, attribute);
      if (!(attributes[key] ?? []).includes(value)) attributes[key] = [...(attributes[key] ?? []), value];
    }
    if (input.deleteOldRdn === true) {
      for (const { attribute, value } of oldNaming) {
        if (newNaming.some((ava) => ava.attribute.toLowerCase() === attribute.toLowerCase() && ava.value === value)) continue;
        const key = attributeKey(attributes, attribute);
        const values = (attributes[key] ?? []).filter((oldValue) => oldValue !== value);
        if (values.length) attributes[key] = values;
        else delete attributes[key];
      }
    }
    const subtree = [...directory.values()].filter((child) => dnWithinBase(child.dn, dn));
    entry.attributes = attributes;
    for (const child of subtree) directory.delete(child.dn.toLowerCase());
    for (const child of subtree) put(child.dn.slice(0, child.dn.length - dn.length) + newDn, child.attributes);
  } else if (method === "ldap/connections/statuses") {
    // 字段名与后端契约一致：status（三态）+ unix 毫秒 lastUsedAt。
    result = { statuses: [{ connectionId: String(context.connectionId), status: "connected", readOnly, lastUsedAt: Date.now() }] };
  } else if (method === "ldap/presets/list") {
    result = { presets: JSON.parse(localStorage.getItem("ldap-mock-presets") ?? "[]") };
  } else if (method === "ldap/presets/save") {
    const presets = JSON.parse(localStorage.getItem("ldap-mock-presets") ?? "[]") as unknown[];
    const incoming = (input.preset ?? {}) as Record<string, unknown>;
    const name = String(incoming.name ?? "").trim();
    if (!name) throw new Error("preset name is required");
    // 镜像 Go LDAPSearchPreset：只存协议字段，conditions 不会往返。
    const preset = {
      id: String(incoming.id ?? "").trim() || crypto.randomUUID(),
      name,
      ...(incoming.baseDn ? { baseDn: incoming.baseDn } : {}),
      ...(incoming.filter ? { filter: incoming.filter } : {}),
      ...(incoming.scope ? { scope: incoming.scope } : {}),
      ...(Array.isArray(incoming.attributes) && incoming.attributes.length ? { attributes: [...incoming.attributes] } : {}),
      ...(incoming.sizeLimit ? { sizeLimit: incoming.sizeLimit } : {}),
    };
    const index = presets.findIndex((item) => (item as Record<string, unknown>).id === preset.id);
    if (index >= 0) presets[index] = preset;
    else presets.push(preset);
    localStorage.setItem("ldap-mock-presets", JSON.stringify(presets));
    result = { success: true, preset };
  } else if (method === "ldap/presets/remove") {
    const id = String(input.id ?? "").trim();
    if (!id) throw new Error("Missing preset id");
    const presets = JSON.parse(localStorage.getItem("ldap-mock-presets") ?? "[]") as Array<Record<string, unknown>>;
    if (!presets.some((preset) => preset.id === id)) throw new Error(`preset ${JSON.stringify(id)} is not found`);
    localStorage.setItem("ldap-mock-presets", JSON.stringify(presets.filter((preset) => preset.id !== id)));
    result = { success: true };
  } else if (method === "ldap/ui/state/report") {
    // MCP UI intent 回报（M1）：镜像 sidecar 校验——带 intentId 时 status
    // 必须是 applied|rejected；无 intentId 为快照型（恒 success）。
    const status = String(input.status ?? "");
    const intentId = String(input.intentId ?? "").trim();
    if (intentId && status !== "applied" && status !== "rejected") throw new Error("status must be applied or rejected");
    result = { success: true };
  } else {
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
  return result as T;
};

// Current host callbacks plus optional legacy callbacks for compatibility fixtures.
window.dbxPlugin = {
  ready: Promise.resolve(context),
  context,
  appearance,
  theme,
  locale: params.get("locale") || "zh-CN",
  request,
  invoke,
  notify: async () => undefined,
  sendBinary: async () => undefined,
  onEvent: (listener) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  },
  onBinary: () => () => undefined,
  onAppearanceChange: (listener) => {
    appearanceListeners.add(listener);
    listener(appearance);
    return () => appearanceListeners.delete(listener);
  },
  onLocaleChange: () => () => undefined,
  onContext: (listener) => {
    contextListeners.add(listener);
    return () => contextListeners.delete(listener);
  },
  onContextChange: (listener) => {
    contextListeners.add(listener);
    listener(context);
    return () => contextListeners.delete(listener);
  },
  decodeBase64: (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  encodeBase64: (value) => {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  },
  workbenchState: { set: async () => undefined },
  clipboard: {
    readText: async () => clipboardWrites.at(-1) ?? "",
    writeText: async (text: string) => {
      clipboardWrites.push(text);
    },
  },
  // 宿主 host.storage mock（Host API 1.2，pluginHostBridge storage 命名空间同形）：
  // 与真实 web 宿主同形由 localStorage 兜底（键名不变；字符串值原样、对象 JSON
  // 编码），刷新/重开不丢——ui_test walkthrough 断言依赖该语义；opaque origin
  // 等不可用场景退化为内存 Map。get 未命中返回 null，set(undefined) 归一化为 null。
  capabilities: { storage: true },
  storage: (() => {
    let ls: Storage | null = null;
    try {
      window.localStorage.setItem("__dbx_mock_storage_probe__", "1");
      window.localStorage.removeItem("__dbx_mock_storage_probe__");
      ls = window.localStorage;
    } catch {
      ls = null;
    }
    const mem = new Map<string, string>();
    const write = (key: string, value: unknown) => {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      if (ls) ls.setItem(key, raw);
      else mem.set(key, raw);
    };
    const read = (key: string): unknown => {
      const raw = ls ? ls.getItem(key) : (mem.get(key) ?? null);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" ? parsed : raw;
      } catch {
        return raw;
      }
    };
    return {
      get: async (key: string) => read(key),
      set: async (key: string, value: unknown) => {
        write(key, value === undefined ? null : value);
        return null;
      },
      delete: async (key: string) => {
        if (ls) ls.removeItem(key);
        else mem.delete(key);
        return null;
      },
    };
  })(),
};

// 走查注入：ui_test 经 window.dbxPlugin.emitUiIntent 发 ldap/ui/intent
// （vitest 直接走模块导出）。mock 专用钩子不属于宿主桥契约面，用
// Object.assign 挂载避免污染 DbxPluginApi 类型（函数声明提升，此处引用安全）。
const clipboardWrites: string[] = [];
Object.assign(window.dbxPlugin, { emitUiIntent, clipboardWrites });

export { context, appearance };

/** 测试/走查注入：按 sidecar `ldap/ui/intent` 事件形状发一条 intent
 * （mock 与真实 emitter.Event 同面；useUiIntent 消费后回报
 * ldap/ui/state/report）。 */
export function emitUiIntent(message: { intentId: string; action: string; params?: Record<string, unknown> }) {
  emitEvent("ldap/ui/intent", {
    intentId: message.intentId,
    action: message.action,
    params: message.params ?? {},
  });
}
