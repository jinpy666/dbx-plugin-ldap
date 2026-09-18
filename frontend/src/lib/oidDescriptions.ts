/**
 * 已知 LDAP control / extension / feature OID 的说明表（Server Info 弹窗用，
 * 对标 phpLDAPadmin 的 supportedControl 附带描述）。
 *
 * 只收录 RFC/IANA 或厂商文档明确登记的 OID；未收录的值由调用方回退为仅显示
 * 原始 OID，绝不硬造说明。描述保留英文原文（RFC 术语），标题走同一来源，
 * 分组标签的本地化在 i18n 层完成。
 */

export interface OidInfo {
  title: string;
  description: string;
}

const REGISTRY: Record<string, OidInfo> = {
  // -- supportedControl（RFC 4511 §4.1.11 与各扩展）--------------------------
  "1.2.840.113556.1.4.319": {
    title: "Simple Paged Results Manipulation",
    description:
      "RFC 2696. Allows a client to control the rate at which an LDAP server returns the results of a search operation, useful with limited resources or low-bandwidth connections.",
  },
  "1.2.826.0.1.3344810.2.3": {
    title: "Matched Values",
    description:
      "RFC 3876. Returns a subset of attribute values from an entry: only those values matching a 'values return' filter.",
  },
  "1.2.840.113556.1.4.473": {
    title: "Server Side Sorting of Search Results",
    description: "RFC 2891. Requests that the server sort the search results before returning them.",
  },
  "1.2.840.113556.1.4.474": {
    title: "Server Side Sorting Response",
    description: "RFC 2891. Server response control reporting the result of a sorted search request.",
  },
  "1.3.6.1.1.12": {
    title: "Assertion",
    description:
      "RFC 4528. Allows the client to specify a condition that must be true for the operation to be processed normally.",
  },
  "1.3.6.1.1.13.1": {
    title: "Pre-Read",
    description:
      "RFC 4527. Indicates that a copy of the entry before application of the update is to be returned.",
  },
  "1.3.6.1.1.13.2": {
    title: "Post-Read",
    description:
      "RFC 4527. Indicates that a copy of the entry after application of the update is to be returned.",
  },
  "1.3.6.1.1.22": {
    title: "LDAP Don't Use Copy",
    description:
      "RFC 6171. When attached to an LDAP request, the requested operation MUST NOT be performed on copied information.",
  },
  "1.3.6.1.4.1.4203.1.10.1": {
    title: "Subentries",
    description:
      "RFC 3672. MAY be sent with a searchRequest to control the visibility of entries and subentries which are within scope.",
  },
  "1.3.6.1.4.1.42.2.27.8.5.1": {
    title: "Password Policy",
    description:
      "Behera draft (OpenLDAP ppolicy). Requests password policy information (expiry, lockout, …) in the bind or modify response.",
  },
  "2.16.840.1.113730.3.4.2": {
    title: "ManageDsaIT",
    description:
      "RFC 3296. Tells the server to treat referral entries as ordinary entries instead of following them.",
  },
  "2.16.840.1.113730.3.4.18": {
    title: "Proxied Authorization V2",
    description:
      "RFC 4370. Allows a client to request that an operation be performed under the authorization identity of another user.",
  },
  "2.16.840.1.113730.3.4.16": {
    title: "Authorization Identity Request",
    description: "RFC 3829. Requests the server to return the authorization identity of the established association.",
  },
  "2.16.840.1.113730.3.4.15": {
    title: "Authorization Identity Response",
    description: "RFC 3829. Server response carrying the authorization identity of the connection.",
  },
  "1.2.840.113556.1.4.417": {
    title: "Show Deleted Objects",
    description: "Active Directory. Requests that deleted objects be visible in search results.",
  },
  "1.2.840.113556.1.4.805": {
    title: "Subtree Delete",
    description: "Active Directory / RFC draft. Allows an entire subtree to be deleted in a single delete operation.",
  },
  "1.2.840.113556.1.4.529": {
    title: "Extended DN",
    description: "Active Directory. Returns DNs augmented with GUID/SID components.",
  },
  "1.2.840.113556.1.4.801": {
    title: "Security Descriptor Flags",
    description: "Active Directory. Controls which parts of an nTSecurityDescriptor attribute are returned.",
  },
  "1.2.840.113556.1.4.528": {
    title: "Directory Notification",
    description: "Active Directory (persistent search). Asks the server to stream changes as they occur.",
  },
  "1.2.840.113556.1.4.1413": {
    title: "Permissive Modify",
    description: "Active Directory. Loosens add/delete semantics on modify operations (no error if value already present/absent).",
  },

  // -- supportedExtension（RFC 4511 §4.1.12 与各扩展）------------------------
  "1.3.6.1.4.1.1466.20.037": {
    title: "Transport Layer Security (StartTLS)",
    description:
      "RFC 4511 §4.14. Provides for TLS establishment in an LDAP association via an LDAP extended request.",
  },
  "1.3.6.1.4.1.4203.1.11.1": {
    title: "Password Modify",
    description:
      "RFC 3062. Modification of user passwords not dependent upon the form of the authentication identity nor the password storage mechanism.",
  },
  "1.3.6.1.4.1.4203.1.11.3": {
    title: "Who Am I?",
    description:
      "RFC 4532. Provides a mechanism for clients to obtain the authorization identity the server has associated with the user or application entity.",
  },
  "1.3.6.1.1.8": {
    title: "Cancel Operation",
    description: "RFC 3909. Requests cancellation of an outstanding operation.",
  },
  "1.3.6.1.1.21.1": {
    title: "Start Transaction",
    description: "RFC 5805. Opens a transaction; subsequent updates are held until commit.",
  },
  "1.3.6.1.1.21.2": {
    title: "Commit Transaction",
    description: "RFC 5805. Atomically applies all updates of the open transaction.",
  },
  "1.3.6.1.1.21.3": {
    title: "End Transaction",
    description: "RFC 5805. Aborts the open transaction, discarding its updates.",
  },

  // -- supportedFeatures（RFC 4512 §5.1.4）----------------------------------
  "1.3.6.1.1.14": {
    title: "Modify-Increment",
    description:
      "RFC 4525. An extension to the Modify operation to support an increment capability.",
  },
  "1.3.6.1.4.1.4203.1.5.1": {
    title: "All Operational Attributes",
    description:
      "RFC 3673. Clients may request the return of all operational attributes (the '+' request).",
  },
  "1.3.6.1.4.1.4203.1.5.2": {
    title: "Requesting Attributes by Object Class",
    description:
      "RFC 4529. A mechanism clients may use to request the return of all attributes of an object class.",
  },
  "1.3.6.1.4.1.4203.1.5.3": {
    title: "Absolute True and False Filters",
    description:
      "RFC 4526. 'and' and 'or' filter choices with zero filter elements are allowed.",
  },
  "1.3.6.1.4.1.4203.1.5.4": {
    title: "Language Tags",
    description:
      "RFC 3866. Supports storing attributes with language tag options in the DIT.",
  },
  "1.3.6.1.4.1.4203.1.5.5": {
    title: "Language Ranges",
    description:
      "RFC 3866. Supports language range matching of attributes with language tag options stored in the DIT.",
  },
};

/** OID 形态（点分十进制，如 1.2.840.113556.1.4.319）；单段纯数字不算。 */
const OID_PATTERN = /^\d+(\.\d+)+$/;

/** 查已知 OID 的说明；值不是 OID 形态或未收录时返回 undefined（调用方只显原值）。 */
export function lookupOidInfo(value: string): OidInfo | undefined {
  const trimmed = value.trim();
  if (!OID_PATTERN.test(trimmed)) return undefined;
  return REGISTRY[trimmed];
}
