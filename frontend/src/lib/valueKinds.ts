/**
 * 值类型注册表（value kind registry）——编辑器分流的统一数据源。
 *
 * 对标 Apache Directory Studio `plugins/valueeditors/plugin.xml` 的绑定模型：
 * 每个值编辑器按「属性名列表 和/或 语法 OID」双重绑定。属性名绑定用于服务器
 * schema 缺失或不准的场景（如 entryUUID 在部分服务器上是 octetString、AD 的
 * FILETIME 属性在 schema 中是 Interval/LargeInteger 语法，与普通计数器 uSN*
 * 同语法，只能按属性名区分——ADS 同样只按名字绑定 AD 时间）。
 *
 * 解析顺序：属性名表（小写精确 + 后缀规则）→ 语法 OID 表 → text 兜底。
 * 纯函数，无 Vue / DOM 依赖。
 */

export type AttributeValueKind =
    | "datetime" // RFC 4517 generalizedTime / utcTime
    | "filetime" // AD FILETIME（Interval/LargeInteger，1601 纪元 100ns）
    | "dn" // DN / nameAndOptionalUID 值（可从目录树选择）
    | "boolean" // TRUE/FALSE
    | "integer" // 整数
    | "guid" // AD objectGUID（二进制，显示为标准 UUID）
    | "sid" // AD objectSid（二进制，显示为 S-1-…）
    | "uuid" // entryUUID 等 RFC UUID 字符串
    | "binary" // 二进制（base64/证书/图像）
    | "oid" // OID（supportedControl 等）
    | "text";

export interface AttributeSyntaxInfo {
    syntax?: string;
    equality?: string;
    singleValue?: boolean;
    noUserModification?: boolean;
}

/** RFC 4512 常用语法 OID（对齐 ADS valueeditors plugin.xml 绑定）。 */
export const LDAP_SYNTAX = {
    generalizedTime: "1.3.6.1.4.1.1466.115.121.1.24",
    utcTime: "1.3.6.1.4.1.1466.115.121.1.26",
    dn: "1.3.6.1.4.1.1466.115.121.1.12",
    nameAndOptionalUID: "1.3.6.1.4.1.1466.115.121.1.34",
    boolean: "1.3.6.1.4.1.1466.115.121.1.7",
    integer: "1.3.6.1.4.1.1466.115.121.1.27",
    jpeg: "1.3.6.1.4.1.1466.115.121.1.28",
    certificate: "1.3.6.1.4.1.1466.115.121.1.8",
    certificateList: "1.3.6.1.4.1.1466.115.121.1.10",
    octetString: "1.3.6.1.4.1.1466.115.121.1.40",
    oid: "1.3.6.1.4.1.1466.115.121.1.38",
    uuid: "1.3.6.1.1.16.1",
} as const;

/**
 * 属性名绑定表（小写键；ADS plugin.xml 中 ActiveDirectoryTimeValueEditor 的
 * 七个 FILETIME 属性 + MSAD GUID/SID + OID/UUID 编辑器的名字绑定）。
 */
const NAME_KINDS: Record<string, AttributeValueKind> = {
    // ActiveDirectoryTimeValueEditor 绑定（FILETIME，仅按名字区分，见文件头说明）
    pwdlastset: "filetime",
    accountexpires: "filetime",
    lastlogoff: "filetime",
    lastlogon: "filetime",
    lastlogontimestamp: "filetime",
    badpasswordtime: "filetime",
    lockouttime: "filetime",
    // MSAD 二进制标识（显示解码，编辑仍走二进制/base64）
    objectguid: "guid",
    objectsid: "sid",
    // UUID
    entryuuid: "uuid",
    ipauniqueid: "uuid",
    // OID 绑定（InPlaceOidValueEditor）
    supportedcontrol: "oid",
    supportedextension: "oid",
    supportedfeatures: "oid",
    supportedcapabilities: "oid",
    // 常见 DN 引用兜底（schema 不可用时；语法 OID 命中不受此表影响）
    member: "dn",
    memberof: "dn",
    manager: "dn",
    managedby: "dn",
    owner: "dn",
    secretary: "dn",
    assistant: "dn",
    seealso: "dn",
    altrecipient: "dn",
    distinguishedname: "dn",
};

/** 后缀规则：*Certificate / *Photo 家族按名字兜底（对齐 ADS 证书编辑器注释：
 * AD/eDirectory/Sun DSEE 的证书属性不携带正确 syntax）。 */
const NAME_SUFFIX_KINDS: ReadonlyArray<readonly [suffix: string, kind: AttributeValueKind]> = [
    ["certificate", "binary"],
    ["photo", "binary"],
];

/** 语法 OID → kind（ADS syntax 绑定子集）。 */
const SYNTAX_KINDS: Record<string, AttributeValueKind> = {
    [LDAP_SYNTAX.generalizedTime]: "datetime",
    [LDAP_SYNTAX.utcTime]: "datetime",
    [LDAP_SYNTAX.dn]: "dn",
    [LDAP_SYNTAX.nameAndOptionalUID]: "dn",
    [LDAP_SYNTAX.boolean]: "boolean",
    [LDAP_SYNTAX.integer]: "integer",
    [LDAP_SYNTAX.jpeg]: "binary",
    [LDAP_SYNTAX.certificate]: "binary",
    [LDAP_SYNTAX.certificateList]: "binary",
    [LDAP_SYNTAX.octetString]: "binary",
    [LDAP_SYNTAX.oid]: "oid",
    [LDAP_SYNTAX.uuid]: "uuid",
};

/**
 * 解析属性值应使用的编辑器类型。name 优先（与 ADS ValueEditorManager 一致：
 * 名字绑定修正 schema 语法不准），其次语法 OID，最后 text 兜底。
 * info 为该属性在 schema（或内置表）中的语法信息，可缺省。
 */
export function attributeValueKind(name: string, info?: AttributeSyntaxInfo | null, dialect?: string): AttributeValueKind {
    void dialect; // 方言保留参数：当前绑定表已按属性名覆盖 AD 特例；后续模板分组使用
    const key = String(name ?? "").trim().toLowerCase();
    if (key) {
        const byName = NAME_KINDS[key];
        if (byName) return byName;
        for (const [suffix, kind] of NAME_SUFFIX_KINDS) {
            if (key.endsWith(suffix)) return kind;
        }
    }
    const syntax = String(info?.syntax ?? "").trim();
    if (syntax) {
        const bySyntax = SYNTAX_KINDS[syntax];
        if (bySyntax) return bySyntax;
    }
    return "text";
}

/**
 * 判断属性是否应视为二进制（二进制编辑器分流）。
 * valueKinds 命中 binary/guid/sid，或调用方传入的名字启发式（binaryValue.ts）
 * 为 true 时成立。
 */
export function isBinaryKind(kind: AttributeValueKind): boolean {
    return kind === "binary" || kind === "guid" || kind === "sid";
}
