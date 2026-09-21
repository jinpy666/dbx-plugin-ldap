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

// code-first 精确码表（[ldap-code=NNN] 前缀存在时的权威映射）。曾用文本
// 正则 `result code 20` 直接匹配原文，前缀碰撞把 200/206 等码误判成 20
//（"属性或值已存在"）——LDAP-DEV 打开报"属性或值已存在"实为 206 空密码
// 懒绑定，2026-09-21 修复：带码消息一律走本表精确命中，文本正则仅兜底
// 无码消息，且全部加 (?!\d) 防前缀碰撞。
const CODE_RULES: Readonly<Record<number, string>> = {
    4: "err.sizeLimit",
    8: "err.strongAuth",
    10: "err.referral",
    11: "err.adminLimit",
    19: "err.constraint",
    20: "err.attributeExists",
    21: "err.invalidAttrSyntax",
    32: "err.noSuchObject",
    34: "err.invalidDn",
    49: "err.invalidCredentials",
    53: "err.unwilling",
    68: "err.entryExists",
    200: "err.network",
    // 206 = go-ldap 客户端拒绝（bind.go ErrorEmptyPassword）：绑定密码为空
    // 的懒绑定（如宿主未送达密钥/连接未存密码），此前被误显示为 code 20。
    206: "err.emptyPassword",
};

// TLS 证书类单独前置：码 200 网络错误的原文常带 x509/TLS handshake 细节，
// 证书类文案对用户更有指导性，优先级高于任何精确码映射。
const TLS_PATTERN = /certificate|x509|unknown authority|tls.*handshake/i;

const RULES: ReadonlyArray<{ pattern: RegExp; key: string }> = [
    // 结果码 10（Referral）：机器可读前缀或 go-ldap 原文均可命中；放在通用
    // network/timeout 规则之前，保证 referral 优先归类。
    { pattern: /ldap-code=10(?!\d)|\breferral\b/i, key: "err.referral" },
    { pattern: /result code 49(?!\d)|invalid credentials/i, key: "err.invalidCredentials" },
    { pattern: /result code 32(?!\d)|no such object/i, key: "err.noSuchObject" },
    { pattern: /result code 34(?!\d)|invalid dn syntax/i, key: "err.invalidDn" },
    { pattern: /result code 206(?!\d)|empty password not allowed/i, key: "err.emptyPassword" },
    { pattern: /result code 20(?!\d)|attribute or value exists/i, key: "err.attributeExists" },
    { pattern: /result code 19(?!\d)|constraint violation/i, key: "err.constraint" },
    { pattern: /result code 21(?!\d)|invalid attribute syntax/i, key: "err.invalidAttrSyntax" },
    { pattern: /result code 4(?!\d)|size limit exceeded/i, key: "err.sizeLimit" },
    { pattern: /administr?ative limit|result code 11(?!\d)/i, key: "err.adminLimit" },
    { pattern: /result code 53(?!\d)|unwilling to perform/i, key: "err.unwilling" },
    { pattern: /result code 8(?!\d)|strong(?:er)? auth(?:entication)? required/i, key: "err.strongAuth" },
    // 网络类先于通用超时：dial i/o timeout 归为"无法连接"更贴切；
    // "connection lost/closed"（连接中断，含传输层意外断开）同归网络类
    //（UI 扫描 P2-1：此前英文原文透传三处横幅）。
    {
        pattern: /result code 200(?!\d)|network error|connection (?:refused|reset|lost|closed)|no such host|broken pipe|i\/o timeout|eof/i,
        key: "err.network",
    },
    { pattern: /timeout|timed out|deadline exceeded/i, key: "err.timeout" },
    // entryAlreadyExists（结果码 68）：机器可读前缀或文本形态均可命中；
    // 追加在末尾，保持既有 13 组规则的相对顺序不变
    { pattern: /ldap-code=68(?!\d)|result code 68(?!\d)|entry already exists/i, key: "err.entryExists" },
];

export interface LdapErrorMeta {
    resultCode?: number;
    matchedDn?: string;
    /** 结果码 10 的引用 URI（bizError 前缀最多携带 5 条）。 */
    referrals?: string[];
}

// 后端契约前缀（backend/main.go bizError 注入）：[ldap-code=<十进制>]（必有）、
// " [ldap-matched=<DN>]"（仅 DN 非空时）。DN 内不含 "]"；空值视为无。
const CODE_PREFIX = /\[ldap-code=(\d+)\]/;
const MATCHED_PREFIX = /\[ldap-matched=([^\]]+)\]/;
const REFERRAL_PREFIX = /\[ldap-referral=([^\]]+)\]/;

// parseLdapErrorMeta 解析后端注入的 [ldap-code=..]/[ldap-matched=..] 前缀，
// 无前缀（或空 matchedDn）时返回不含对应字段的对象。
export const parseLdapErrorMeta = (message: string): LdapErrorMeta => {
    const raw = String(message ?? "");
    const meta: LdapErrorMeta = {};
    const code = CODE_PREFIX.exec(raw);
    if (code) meta.resultCode = Number(code[1]);
    const matched = MATCHED_PREFIX.exec(raw);
    if (matched) meta.matchedDn = matched[1];
    const referral = REFERRAL_PREFIX.exec(raw);
    if (referral) {
        const uris = referral[1].split("|").map((uri) => uri.trim()).filter(Boolean);
        if (uris.length > 0) meta.referrals = uris;
    }
    return meta;
};

export const friendlyLdapError = (message: string): string => {
    const raw = String(message ?? "");
    if (TLS_PATTERN.test(raw)) return t("err.tls");
    // code-first：后端 [ldap-code=NNN] 前缀存在时按精确码命中（杜绝 20/200/206
    // 这类前缀碰撞）；无码消息回落到锚定后的文本规则。
    const meta = parseLdapErrorMeta(raw);
    if (meta.resultCode !== undefined && CODE_RULES[meta.resultCode]) {
        return t(CODE_RULES[meta.resultCode]);
    }
    for (const rule of RULES) {
        if (rule.pattern.test(raw)) return t(rule.key);
    }
    return raw;
};
