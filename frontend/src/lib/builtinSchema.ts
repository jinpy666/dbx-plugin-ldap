/**
 * 内置 schema 兜底表（builtin schema fallback）。
 *
 * 对标 Apache Directory LDAP API 的 schema-data 模块（捆绑 core/cosine/
 * inetorgperson/nis 等标准 schema 集）+ ADS plugin.xml 名字绑定：服务器
 * schema 不可用（allowed_base_dns 禁用 subschema 读）或定义不全时，用本表
 * 驱动值编辑器分流、属性自动补全与新建向导的 MUST/MAY 提示。
 *
 * 内容刻意精简：只收常用属性与对象类（语法语义 + must/may），不是全量
 * schema 复刻。小写键；纯数据，无 Vue / DOM 依赖。
 */

import type { AttributeSyntaxInfo } from "./valueKinds";
import { LDAP_SYNTAX } from "./valueKinds";

export interface BuiltinAttributeDef extends AttributeSyntaxInfo {
    /** 首选展示名（保留标准大小写）。 */
    name: string;
    /** 别名（如 cn/commonName）。 */
    names?: string[];
}

/** def 同时以首选名与全部别名（小写）为键，指向同一对象。 */
function def(name: string, names: string[] | undefined, syntax: string | undefined, equality?: string, noUserModification = false): Array<[string, BuiltinAttributeDef]> {
    const attribute: BuiltinAttributeDef = { name, names, syntax, equality, noUserModification };
    const keys = [name, ...(names ?? [])].map((key) => key.toLowerCase()).filter(Boolean);
    return [...new Set(keys)].map((key) => [key, attribute]);
}

/** 常用属性的内置定义（RFC 4519 / RFC 2798 / RFC 2307 / AD 常用 / 操作属性）。 */
export const BUILTIN_ATTRIBUTES: Record<string, BuiltinAttributeDef> = Object.fromEntries(
    [
    // —— RFC 4519 core ——
    def("commonName", ["cn", "commonName"], undefined, "caseIgnoreMatch"),
    def("surname", ["sn", "surname"], undefined, "caseIgnoreMatch"),
    def("givenName", undefined, undefined, "caseIgnoreMatch"),
    def("uid", ["uid", "userid"], undefined, "caseIgnoreMatch"),
    def("mail", ["mail", "rfc822Mailbox"], undefined, "caseIgnoreIA5Match"),
    def("telephoneNumber", undefined, undefined, "telephoneNumberMatch"),
    def("facsimileTelephoneNumber", undefined, undefined, "telephoneNumberMatch"),
    def("mobile", undefined, undefined, "telephoneNumberMatch"),
    def("pager", undefined, undefined, "telephoneNumberMatch"),
    def("street", ["street", "streetAddress"], undefined, "caseIgnoreMatch"),
    def("l", ["l", "localityName"], undefined, "caseIgnoreMatch"),
    def("st", ["st", "stateOrProvinceName"], undefined, "caseIgnoreMatch"),
    def("o", ["o", "organizationName"], undefined, "caseIgnoreMatch"),
    def("ou", ["ou", "organizationalUnitName"], undefined, "caseIgnoreMatch"),
    def("title", undefined, undefined, "caseIgnoreMatch"),
    def("description", undefined, undefined, "caseIgnoreMatch"),
    def("postalAddress", undefined, undefined),
    def("postalCode", undefined, undefined, "caseIgnoreMatch"),
    def("physicalDeliveryOfficeName", undefined, undefined, "caseIgnoreMatch"),
    def("member", undefined, LDAP_SYNTAX.dn, "distinguishedNameMatch"),
    def("memberURL", undefined, undefined, "caseIgnoreIA5Match"),
    def("owner", undefined, LDAP_SYNTAX.dn, "distinguishedNameMatch"),
    def("seeAlso", undefined, LDAP_SYNTAX.dn, "distinguishedNameMatch"),
    def("displayName", undefined, undefined, "caseIgnoreMatch"),
    def("employeeNumber", undefined, undefined, "caseIgnoreMatch"),
    def("employeeType", undefined, undefined, "caseIgnoreMatch"),
    def("preferredLanguage", undefined, undefined, "caseIgnoreMatch"),
    def("userSMIMECertificate", undefined, LDAP_SYNTAX.octetString),
    def("userPKCS12", undefined, LDAP_SYNTAX.octetString),
    def("userCertificate", ["userCertificate", "userCertificate;binary"], LDAP_SYNTAX.certificate),
    def("cACertificate", ["cACertificate", "cACertificate;binary"], LDAP_SYNTAX.certificate),
    def("jpegPhoto", ["jpegPhoto", "jpegPhoto;binary"], LDAP_SYNTAX.jpeg),
    def("photo", undefined, LDAP_SYNTAX.jpeg),
    def("supportedControl", undefined, LDAP_SYNTAX.oid, "objectIdentifierMatch", true),
    def("supportedExtension", undefined, LDAP_SYNTAX.oid, "objectIdentifierMatch", true),
    def("supportedFeatures", undefined, LDAP_SYNTAX.oid, "objectIdentifierMatch", true),
    def("supportedCapabilities", undefined, LDAP_SYNTAX.oid, "objectIdentifierMatch", true),
    def("supportedLDAPVersion", undefined, LDAP_SYNTAX.integer, "integerMatch", true),
    def("namingContexts", undefined, undefined, undefined, true),
    def("subschemaSubentry", undefined, LDAP_SYNTAX.dn, "distinguishedNameMatch", true),
    def("vendorName", undefined, undefined, "caseExactMatch", true),
    def("vendorVersion", undefined, undefined, "caseExactMatch", true),
    def("objectClass", undefined, undefined, "objectIdentifierMatch"),
    def("objectClasses", undefined, undefined, undefined, true),
    def("attributeTypes", undefined, undefined, undefined, true),
    def("entryUUID", undefined, LDAP_SYNTAX.uuid, "UUIDMatch", true),
    def("creatorsName", undefined, LDAP_SYNTAX.dn, "distinguishedNameMatch", true),
    def("createTimestamp", undefined, LDAP_SYNTAX.generalizedTime, "generalizedTimeMatch", true),
    def("modifiersName", undefined, LDAP_SYNTAX.dn, "distinguishedNameMatch", true),
    def("modifyTimestamp", undefined, LDAP_SYNTAX.generalizedTime, "generalizedTimeMatch", true),
    // —— RFC 2307 nis（POSIX）——
    def("uidNumber", undefined, LDAP_SYNTAX.integer, "integerMatch"),
    def("gidNumber", undefined, LDAP_SYNTAX.integer, "integerMatch"),
    def("homeDirectory", undefined, undefined, "caseExactIA5Match"),
    def("loginShell", undefined, undefined, "caseExactIA5Match"),
    def("gecos", undefined, undefined, "caseIgnoreIA5Match"),
    def("memberUid", undefined, undefined, "caseExactIA5Match"),
    // —— Active Directory 常用 ——
    def("sAMAccountName", undefined, undefined, "caseIgnoreMatch"),
    def("userPrincipalName", undefined, undefined, "caseExactMatch"),
    def("userAccountControl", undefined, LDAP_SYNTAX.integer, "integerMatch"),
    def("accountExpires", undefined, undefined, "integerMatch"),
    def("pwdLastSet", undefined, undefined, "integerMatch"),
    def("lastLogon", undefined, undefined, "integerMatch"),
    def("lastLogonTimestamp", undefined, undefined, "integerMatch"),
    def("lastLogoff", undefined, undefined, "integerMatch"),
    def("badPasswordTime", undefined, undefined, "integerMatch"),
    def("lockoutTime", undefined, undefined, "integerMatch"),
    def("whenCreated", undefined, LDAP_SYNTAX.generalizedTime, "generalizedTimeMatch", true),
    def("whenChanged", undefined, LDAP_SYNTAX.generalizedTime, "generalizedTimeMatch", true),
    def("objectGUID", undefined, LDAP_SYNTAX.octetString, "octetStringMatch", true),
    def("objectSid", undefined, LDAP_SYNTAX.octetString, "octetStringMatch", true),
    def("managedBy", undefined, LDAP_SYNTAX.dn, "distinguishedNameMatch"),
    def("dc", ["dc", "domainComponent"], undefined, "caseIgnoreIA5Match"),
    ].flatMap((entries) => entries),
);


export interface BuiltinObjectClassDef {
    name: string;
    must: string[];
    may: string[];
}

/** 常用对象类的内置 must/may（schema 不可用时新建向导兜底）。 */
export const BUILTIN_OBJECT_CLASSES: Record<string, BuiltinObjectClassDef> = Object.fromEntries(
    (
        [
            { name: "top", must: ["objectClass"], may: [] },
            { name: "person", must: ["sn", "cn"], may: ["userPassword", "telephoneNumber", "seeAlso", "description"] },
            {
                name: "organizationalPerson",
                must: [],
                may: ["title", "x121Address", "registeredAddress", "destinationIndicator", "preferredDeliveryMethod", "telexNumber", "teletexTerminalIdentifier", "telephoneNumber", "internationaliSDNNumber", "facsimileTelephoneNumber", "street", "postOfficeBox", "postalCode", "postalAddress", "physicalDeliveryOfficeName", "ou", "st", "l"],
            },
            { name: "inetOrgPerson", must: [], may: ["audio", "businessCategory", "carLicense", "departmentNumber", "displayName", "employeeNumber", "employeeType", "givenName", "homePhone", "homePostalAddress", "initials", "jpegPhoto", "labeledURI", "mail", "manager", "mobile", "o", "pager", "photo", "roomNumber", "secretary", "uid", "userCertificate", "x500uniqueIdentifier", "preferredLanguage", "userSMIMECertificate", "userPKCS12"] },
            { name: "organizationalUnit", must: ["ou"], may: ["userPassword", "searchGuide", "seeAlso", "businessCategory", "physicalDeliveryOfficeName", "street", "postOfficeBox", "postalCode", "postalAddress", "st", "l", "description"] },
            { name: "organization", must: ["o"], may: ["userPassword", "searchGuide", "seeAlso", "businessCategory", "x121Address", "registeredAddress", "destinationIndicator", "preferredDeliveryMethod", "telexNumber", "teletexTerminalIdentifier", "telephoneNumber", "internationaliSDNNumber", "facsimileTelephoneNumber", "street", "postOfficeBox", "postalCode", "postalAddress", "physicalDeliveryOfficeName", "st", "l", "description"] },
            { name: "groupOfNames", must: ["cn", "member"], may: ["businessCategory", "seeAlso", "owner", "ou", "o", "description"] },
            { name: "account", must: ["uid"], may: ["description", "seeAlso", "l", "o", "ou", "host"] },
            { name: "posixAccount", must: ["cn", "uid", "uidNumber", "gidNumber", "homeDirectory"], may: ["userPassword", "loginShell", "gecos", "description"] },
            { name: "posixGroup", must: ["cn", "gidNumber"], may: ["userPassword", "memberUid", "description"] },
            { name: "shadowAccount", must: ["uid"], may: ["userPassword", "shadowLastChange", "shadowMin", "shadowMax", "shadowWarning", "shadowInactive", "shadowExpire", "shadowFlag", "description"] },
            // —— AD（user/group/organizationalUnit 的 AD 形态）——
            { name: "user", must: [], may: ["sAMAccountName", "userPrincipalName", "displayName", "givenName", "sn", "mail", "telephoneNumber", "mobile", "title", "department", "description", "userAccountControl", "accountExpires", "pwdLastSet", "manager", "jpegPhoto", "userCertificate"] },
            { name: "group", must: [], may: ["sAMAccountName", "description", "member", "managedBy", "mail"] },
            { name: "container", must: ["cn"], may: ["description"] },
        ] as BuiltinObjectClassDef[]
    ).map((entry) => [entry.name.toLowerCase(), entry]),
);

/**
 * 取属性的内置语法信息（小写键，含别名）。查不到返回 undefined。
 */
export function builtinAttributeInfo(name: string): BuiltinAttributeDef | undefined {
    return BUILTIN_ATTRIBUTES[String(name ?? "").trim().toLowerCase()];
}

/** 内置常用属性名（展示顺序），供自动补全兜底。 */
export function builtinAttributeNames(): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const attribute of Object.values(BUILTIN_ATTRIBUTES)) {
        const key = attribute.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(attribute.name);
    }
    return names;
}
