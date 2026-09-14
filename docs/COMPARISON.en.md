# Feature and Solution Comparison

This is a positioning comparison, not a performance, pricing, or security
audit. Third-party capabilities change with versions, platforms, plugins, and
commercial plans; "—" means the capability is not a core built-in experience of
that solution, and "external tools" means it usually requires a command-line
tool, plugin, or extra configuration. Third-party notes are based on public
product positioning; re-verify against your target platform and version before
choosing.

## Capability matrix

| Capability | DBX LDAP | ldapsearch / ldapmodify | Apache Directory Studio | JXplorer |
| --- | --- | --- | --- | --- |
| Graphical connection management | Built-in | — | Built-in | Built-in |
| Graphical DN tree browsing | Built-in | — | Built-in | Built-in |
| Filter search (RFC 4515) | Built-in | Built-in | Built-in | Built-in |
| Entry create/edit/rename/delete | Built-in (inside guards) | External `ldapmodify`/`ldapdelete`/`ldapmodrdn` | Built-in | Built-in |
| Authentication matrix (simple/Kerberos/NTLM/DIGEST-MD5/SASL External) | Built-in | Built-in (SASL/GSSAPI) | Built-in/version dependent | Built-in (SASL; Kerberos version dependent) |
| LDAP / StartTLS / LDAPS with certificate validation | Built-in | Built-in | Built-in | Built-in |
| RootDSE / schema inspection | Built-in | External (manual subschema reads) | Built-in | Built-in |
| LDIF / CSV export | LDIF + CSV | LDIF output | LDIF import/export | LDIF export/version dependent |
| Read-only mode and write Base DN allowlist | Built-in | Requires scripts/process discipline | Connection-level read-only option | Requires manual discipline |
| Two-phase delete/rename confirmation and audit records | Built-in | — | Delete confirmation dialog | Delete confirmation dialog |
| Aggregated result stats (counts/distributions/samples) with deep paging | Built-in | — | — | — |
| MCP automation tool surface | Built-in | — | — | — |
| DBX host secret binding | Native | — | — | — |
| Seven-language plugin UI | Built-in | — | Multilingual | Multilingual |

## Position within the DBX plugin family

| Plugin | Primary objects | Typical tasks |
| --- | --- | --- |
| DBX SSH Terminal | SSH hosts, terminal, SFTP, remote ops | Log into servers, run commands, browse and transfer files |
| DBX Files | File systems and object storage | File browsing, uploads/downloads, archiving, cross-storage organizing |
| DBX LDAP | LDAP directories | Query, aggregate, and edit directory entries |
| DBX Kafka | Kafka clusters | Topic, message, consumer group, and schema operations |

The LDAP workspace does not re-implement file transfer, terminal, or messaging
protocols; it focuses on directory data itself and reuses connections, secret
handling, and workbench bridging through DBX host capabilities.

## How to choose

- Scriptable queries only: choose `ldapsearch`; it is the most lightweight and
  composes naturally with shell pipes, with writes handled by companion
  commands such as `ldapmodify`/`ldapdelete`.
- Deep schema/ACI editing or ApacheDS server administration: Apache Directory
  Studio is a full-featured desktop suite suited to directory architects.
- A lightweight, cross-platform Java browser for quick looks and basic edits:
  JXplorer is sufficient.
- Directory operations inside a unified boundary of connections, guards,
  audits, and AI automation: DBX LDAP is integrated with the DBX workbench,
  secret bindings, and the MCP bridge — a fit if you already use DBX or want
  to tighten write permissions.

## Related links

- [Product page](MEDIA.en.md) · [README](../README.en.md)
- [MCP usage guide](MCP_USAGE.en.md)
