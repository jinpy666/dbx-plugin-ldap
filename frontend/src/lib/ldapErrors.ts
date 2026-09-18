/**
 * Friendly LDAP error mapping. Sidecar errors surface raw go-ldap strings
 * ("ldap search: LDAP Result Code 49 \"Invalid Credentials\": ..."), which
 * users cannot act on. `friendlyLdapError` maps the common result codes /
 * transport failures to localized, actionable text and passes anything
 * unknown through unchanged.
 *
 * 与后端契约（backend/main.go bizError）：错误携带 go-ldap 结果码时，
 * message 前缀为 "[ldap-code=<十进制>]"，matchedDN 非空再追加
 * " [ldap-matched=<DN>]"，原始错误串完整保留。`parseLdapErrorMeta`
 * 负责前缀的结构化解析（code-first）；`friendlyLdapError` 的规则仍按
 * 原文文本匹配，因此带前缀的消息同样能命中既有规则。
 */
import { t } from "./i18n";

const RULES: ReadonlyArray<{ pattern: RegExp; key: string }> = [
    // TLS 优先于 network：证书类错误也带 connection/handshake 字样
    { pattern: /certificate|x509|unknown authority|tls.*handshake/i, key: "err.tls" },
    { pattern: /result code 49|invalid credentials/i, key: "err.invalidCredentials" },
    { pattern: /result code 32|no such object/i, key: "err.noSuchObject" },
    { pattern: /result code 34|invalid dn syntax/i, key: "err.invalidDn" },
    { pattern: /result code 20|attribute or value exists/i, key: "err.attributeExists" },
    { pattern: /result code 19|constraint violation/i, key: "err.constraint" },
    { pattern: /result code 21|invalid attribute syntax/i, key: "err.invalidAttrSyntax" },
    { pattern: /result code 4|size limit exceeded/i, key: "err.sizeLimit" },
    { pattern: /administr?ative limit|result code 11/i, key: "err.adminLimit" },
    { pattern: /result code 53|unwilling to perform/i, key: "err.unwilling" },
    { pattern: /result code 8|strong(?:er)? auth(?:entication)? required/i, key: "err.strongAuth" },
    // 网络类先于通用超时：dial i/o timeout 归为"无法连接"更贴切；
    // "connection lost/closed"（连接中断，含传输层意外断开）同归网络类
    //（UI 扫描 P2-1：此前英文原文透传三处横幅）。
    {
        pattern: /result code 200|network error|connection (?:refused|reset|lost|closed)|no such host|broken pipe|i\/o timeout|eof/i,
        key: "err.network",
    },
    { pattern: /timeout|timed out|deadline exceeded/i, key: "err.timeout" },
    // entryAlreadyExists（结果码 68）：机器可读前缀或文本形态均可命中；
    // 追加在末尾，保持既有 13 组规则的相对顺序不变
    { pattern: /ldap-code=68|result code 68|entry already exists/i, key: "err.entryExists" },
];

export interface LdapErrorMeta {
    resultCode?: number;
    matchedDn?: string;
}

// 后端契约前缀（backend/main.go bizError 注入）：[ldap-code=<十进制>]（必有）、
// " [ldap-matched=<DN>]"（仅 DN 非空时）。DN 内不含 "]"；空值视为无。
const CODE_PREFIX = /\[ldap-code=(\d+)\]/;
const MATCHED_PREFIX = /\[ldap-matched=([^\]]+)\]/;

// parseLdapErrorMeta 解析后端注入的 [ldap-code=..]/[ldap-matched=..] 前缀，
// 无前缀（或空 matchedDn）时返回不含对应字段的对象。
export const parseLdapErrorMeta = (message: string): LdapErrorMeta => {
    const raw = String(message ?? "");
    const meta: LdapErrorMeta = {};
    const code = CODE_PREFIX.exec(raw);
    if (code) meta.resultCode = Number(code[1]);
    const matched = MATCHED_PREFIX.exec(raw);
    if (matched) meta.matchedDn = matched[1];
    return meta;
};

export const friendlyLdapError = (message: string): string => {
    const raw = String(message ?? "");
    for (const rule of RULES) {
        if (rule.pattern.test(raw)) return t(rule.key);
    }
    return raw;
};
