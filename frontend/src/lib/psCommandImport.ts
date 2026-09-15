/**
 * PowerShell AD/QAD 命令行 → 搜索表单导入解析器。
 *
 * 支持 `Get-ADUser / Get-ADGroup / Get-ADComputer / Get-ADObject` 与
 * `Get-QADUser / Get-QADGroup / Get-QADComputer / Get-QADObject` 的常见参数：
 * - `-Filter '…'`（PS Filter 语法 → RFC 4515，见 convertPsFilter）
 * - `-LdapFilter '…'`（Get-QAD，直接 RFC 4515）
 * - `-SearchBase dn` / `-SearchRoot dn` → baseDn
 * - `-SearchScope Base|OneLevel|Subtree` → base|one|sub（children 同 sub）
 * - `-SizeLimit n` / `-ResultSetSize n` → sizeLimit
 * - `-Properties a,b,c`（`*` 忽略）→ attributes
 * - 位置参数 Identity（Get-ADUser jsmith）→ sAMAccountName/name 等值过滤
 *     （Get-ADGroup/Get-QADGroup → cn，Get-ADComputer → sAMAccountName）
 *
 * 返回结构对齐 ldapSearchCommand.ts（ok/search/notes/reason），不认识的
 * 参数进 ignored；PS Filter 转换不了的操作符记 notes 后降级。纯函数。
 */

export interface PsCommandSearch {
  baseDn: string;
  scope: "base" | "one" | "sub";
  filter: string;
  attributes: string[];
  sizeLimit?: number;
}

export type PsCommandReason = "empty" | "unknownCommand" | "missingValue" | "filter" | "identity";

export interface PsCommandResult {
  ok: boolean;
  search: PsCommandSearch;
  notes: string[];
  ignored: string[];
  reason?: PsCommandReason;
  value?: string;
}

const CMDLET_CLASSES: Record<string, string> = {
  "get-aduser": "user",
  "get-adgroup": "group",
  "get-adcomputer": "computer",
  "get-adobject": "",
  "get-qaduser": "user",
  "get-qadgroup": "group",
  "get-qadcomputer": "computer",
  "get-qadobject": "",
};

/** shell 风格分词：单/双引号分组（PS Filter 常被单引号包裹）；括号独立成词。 */
function tokenize(command: string): string[] {
  const joined = command.replace(/`\r?\n/gu, " ").replace(/\\\r?\n/gu, " ");
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  const flush = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (const char of joined) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(" || char === ")") {
      flush();
      tokens.push(char);
      continue;
    }
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

const SCOPES: Record<string, "base" | "one" | "sub"> = {
  base: "base",
  onelevel: "one",
  subtree: "sub",
};

const VALUE_FLAGS = new Set(["-filter", "-ldapfilter", "-searchbase", "-searchroot", "-searchscope", "-sizelimit", "-resultsetsize", "-properties", "-identity"]);

// -- PS Filter → RFC 4515 ------------------------------------------------------

const COMPARISON_OPS: Record<string, { op: string; negateFallback?: boolean }> = {
  "-eq": { op: "=" },
  "-ceq": { op: "=" },
  "-ieq": { op: "=" },
  "-like": { op: "=" },
  "-clike": { op: "=" },
  "-ilike": { op: "=" },
  "-ne": { op: "!=" },
  "-notlike": { op: "!=" },
  "-ge": { op: ">=" },
  "-ge_desc": { op: ">=" },
  "-le": { op: "<=" },
  "-gt": { op: ">", negateFallback: true }, // LDAP 无 >：(!(attr<=v))
  "-lt": { op: "<", negateFallback: true }, // LDAP 无 <：(!(attr>=v))
};

/** 属性名归一：常见 PS 显示名 → LDAP 名（不认识的保持原样）。 */
function normalizePsAttribute(name: string): string {
  const lower = name.toLowerCase();
  const map: Record<string, string> = {
    samaccountname: "sAMAccountName",
    surname: "sn",
    emailaddress: "mail",
    displayname: "displayName",
    userprincipalname: "userPrincipalName",
    distinguishedname: "entryDN",
    name: "name",
    enabled: "userAccountControl",
    objectclass: "objectClass",
  };
  return map[lower] ?? name;
}

function escapeValue(value: string, escapeStar: boolean): string {
  let out = value.replace(/\\/gu, "\\5c").replace(/\(/gu, "\\28").replace(/\)/gu, "\\29").replace(/\0/gu, "\\00");
  // -eq 是精确匹配：`*` 必须转义成字面量；-like 保留通配语义（RFC 4515 子串）
  if (escapeStar) out = out.replace(/\*/gu, "\\2a");
  return out;
}

interface PsFilterOutcome {
  filter: string;
  notes: string[];
}

/** 比较/逻辑表达式递归下降。tokens 为展平后的 token 序列。 */
function parsePsFilterExpression(tokens: string[], start: number, end: number, notes: string[]): PsFilterOutcome | null {
  // 递归处理：or（最低）→ and → not → 原子（括号 / 比较）
  let depth = 0;
  for (let i = end - 1; i >= start; i--) {
    const token = tokens[i];
    if (token === ")") depth++;
    else if (token === "(") depth--;
    else if (depth === 0 && (token.toLowerCase() === "-or" || token.toLowerCase() === "-xor")) {
      const left = parsePsFilterExpression(tokens, start, i, notes);
      const right = parsePsFilterExpression(tokens, i + 1, end, notes);
      if (!left || !right) return null;
      return { filter: `(|${left.filter}${right.filter})`, notes };
    }
  }
  depth = 0;
  for (let i = end - 1; i >= start; i--) {
    const token = tokens[i];
    if (token === ")") depth++;
    else if (token === "(") depth--;
    else if (depth === 0 && token.toLowerCase() === "-and") {
      const left = parsePsFilterExpression(tokens, start, i, notes);
      const right = parsePsFilterExpression(tokens, i + 1, end, notes);
      if (!left || !right) return null;
      return { filter: `(&${left.filter}${right.filter})`, notes };
    }
  }
  // -not <atom>
  if (tokens[start]?.toLowerCase() === "-not") {
    const inner = parsePsFilterExpression(tokens, start + 1, end, notes);
    if (!inner) return null;
    return { filter: `(!${inner.filter})`, notes };
  }
  // 括号原子
  if (tokens[start] === "(" && tokens[end - 1] === ")") {
    return parsePsFilterExpression(tokens, start + 1, end - 1, notes);
  }
  // 比较：attr -op value
  if (end - start === 3) {
    const [attribute, operator, value] = tokens.slice(start, end);
    const spec = COMPARISON_OPS[operator.toLowerCase()];
    if (!spec) {
      notes.push(`op:${operator}`);
      return null;
    }
    const attr = normalizePsAttribute(attribute);
    // -like/-notlike 家族保留 `*` 通配语义；其余（-eq 精确匹配等）转义为字面量
    const escaped = escapeValue(value, !operator.toLowerCase().includes("like"));
    if (spec.negateFallback) {
      const fallbackOp = spec.op === ">" ? "<=" : ">=";
      notes.push(`op:${operator}`);
      return { filter: `(!(${attr}${fallbackOp}${escaped}))`, notes };
    }
    if (spec.op === "!=") return { filter: `(!(${attr}=${escaped}))`, notes };
    return { filter: `(${attr}${spec.op}${escaped})`, notes };
  }
  notes.push("filter-shape");
  return null;
}

/** PS Filter 串（含可选 {} 包裹）→ RFC 4515。不可解析返回 null。 */
export function convertPsFilter(filterText: string, notes: string[]): string | null {
  let text = String(filterText ?? "").trim();
  if (text.startsWith("{") && text.endsWith("}")) text = text.slice(1, -1).trim();
  if (!text) return null;
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const outcome = parsePsFilterExpression(tokens, 0, tokens.length, notes);
  return outcome?.filter ?? null;
}

// -- 命令行解析主体 --------------------------------------------------------------

export function parsePsAdCommand(command: string): PsCommandResult {
  const base = (): PsCommandSearch => ({ baseDn: "", scope: "sub", filter: "", attributes: [] });
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return { ok: false, search: base(), notes: [], ignored: [], reason: "empty" };

  const tokens = tokenize(trimmed);
  // 管道左侧 cmdlet；`| fl` 等管道尾部丢弃
  const pipeIndex = tokens.indexOf("|");
  const commandTokens = pipeIndex >= 0 ? tokens.slice(0, pipeIndex) : tokens;
  const cmdlet = (commandTokens[0] ?? "").toLowerCase();
  const objectClass = CMDLET_CLASSES[cmdlet];
  if (objectClass === undefined) {
    return { ok: false, search: base(), notes: [], ignored: [], reason: "unknownCommand", value: commandTokens[0] };
  }

  const notes: string[] = [];
  const ignored: string[] = [];
  const search = base();

  let filterText: string | null = null;
  let ldapFilterText: string | null = null;
  let identity: string | null = null;
  // PS 位置参数规则：Identity 是第 0 个位置参数，必须出现在任何命名参数
  // 之前；命名参数之后的裸 token 只是未知参数的值（如 -Credential foo）。
  let sawNamedParameter = false;

  for (let i = 1; i < commandTokens.length; i++) {
    const token = commandTokens[i];
    const lower = token.toLowerCase();
    if (!token.startsWith("-")) {
      if (!sawNamedParameter && identity == null) identity = token;
      else ignored.push(token);
      continue;
    }
    sawNamedParameter = true;
    if (!VALUE_FLAGS.has(lower)) {
      // -Properties *、-LDAPOnly 等无值/未知开关：连带取值处理过于冒险，
      // 已知布尔类直接忽略，其余记 ignored。
      ignored.push(token);
      continue;
    }
    const next = commandTokens[i + 1];
    if (next === undefined) return { ok: false, search: base(), notes, ignored, reason: "missingValue", value: token };
    i++;
    if (lower === "-filter") filterText = next;
    else if (lower === "-ldapfilter") ldapFilterText = next;
    else if (lower === "-searchbase" || lower === "-searchroot") search.baseDn = next;
    else if (lower === "-searchscope") {
      const mapped = SCOPES[next.toLowerCase()];
      if (!mapped) return { ok: false, search: base(), notes, ignored, reason: "missingValue", value: token };
      search.scope = mapped;
    } else if (lower === "-sizelimit" || lower === "-resultsetsize") {
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0) return { ok: false, search: base(), notes, ignored, reason: "missingValue", value: token };
      search.sizeLimit = parsed;
    } else if (lower === "-properties") {
      if (next.trim() !== "*") search.attributes = next.split(",").map((name) => name.trim()).filter(Boolean);
    } else if (lower === "-identity") {
      identity = next;
    }
  }

  if (ldapFilterText != null) {
    // 用户显式给出的过滤器保持原样（不隐式追加 objectClass）
    search.filter = ldapFilterText.trim();
  } else if (filterText != null) {
    const converted = convertPsFilter(filterText, notes);
    if (converted == null) {
      return { ok: false, search: base(), notes, ignored, reason: "filter", value: filterText };
    }
    search.filter = converted;
  } else if (identity != null) {
    // Identity → 等值过滤（user/computer → sAMAccountName + name，group → cn + name），
    // 并叠加 cmdlet 隐含的 objectClass 约束（与 AD 模块语义一致）
    const escaped = escapeValue(identity, true);
    let identityFilter: string;
    if (objectClass === "group") identityFilter = `(|(cn=${escaped})(name=${escaped}))`;
    else if (objectClass === "computer" || objectClass === "user") identityFilter = `(|(sAMAccountName=${escaped})(name=${escaped}))`;
    else identityFilter = `(name=${escaped})`;
    search.filter = objectClass ? `(&(objectClass=${objectClass})${identityFilter})` : identityFilter;
  } else {
    search.filter = objectClass ? `(objectClass=${objectClass})` : "(objectClass=*)";
  }

  if (!search.baseDn) notes.push("noSearchBase");

  return { ok: true, search, notes, ignored };
}
