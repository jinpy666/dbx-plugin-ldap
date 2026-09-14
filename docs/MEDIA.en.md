# DBX LDAP Product Page

DBX LDAP (plugin id `io.dbx.ldap`) is the LDAP directory workspace for DBX.
This page introduces the product positioning and highlights to prospective
users; every capability claim is backed by the implementation docs and smoke
tests in this repository, with no promotion of unimplemented features.

## Positioning

An LDAP directory workspace for operations, IT administration, and internal
tooling teams: connect once to a corporate directory (Active Directory,
OpenLDAP, 389DS, and other LDAP v3 servers) and browse, search, maintain
entries, inspect schema, and export data. Every write stays inside Base DN
allowlists, blocked-attribute guards, and audit records, and the same guards
are reusable by AI clients through the MCP tool surface.

## Three-sentence pitch

1. See the whole directory in one panel: DN tree, paged searches, RFC 4515
   filters, and search presets — locate users, groups, OUs, and service
   accounts without switching tools.
2. Edit with confidence: read-only mode, write Base DN allowlists, blocked
   attributes, and audit records form four layers of guards; deletes and
   renames always require two-phase confirmation.
3. Enterprise-directory friendly: eight authentication methods, three
   transport modes, and MCP automation — an interactive workspace plus a
   structured tool surface for AI clients.

## Feature highlights

### One-stop browsing and search

- Browse the DN tree by hierarchy, page through results, and combine RFC 4515
  filters with attribute projection.
- Save searches as presets and replay common queries with one click.
- Export results as LDIF or CSV for audit and delivery scenarios.

### Enterprise authentication matrix and transport security

- Authentication: anonymous, unauthenticated, simple, Kerberos/GSSAPI, NTLM,
  NTLM hash, DIGEST-MD5, SASL External.
- Transport: LDAP, StartTLS, and LDAPS with configurable certificate
  validation, CA path, and server name.
- Credentials are managed by DBX host secret bindings; the plugin never
  persists them or writes them to logs.

### Guarded entry editing

- View, create, edit, rename, and delete directory entries.
- Write access is unavailable on read-only connections; the write Base DN
  allowlist bounds the writable scope; blocked attributes protect sensitive
  fields.
- All write paths leave audit records, including MCP writes.

### Schema and capability inspection

- RootDSE capability view, schema attributeType / objectClass inspection, and
  attribute metadata.
- Grounds data imports and pre-integration directory structure reviews.

### MCP automation

- 8 MCP tools: reads via `ldap_search_digest` (locally aggregated digests with
  cursor paging; scanned data never leaves the sidecar) and `ldap_cursor_next`;
  writes via `ldap_entry_write` (two-phase confirmation for deletes/renames);
  `ldap_ui_schema` plus 4 workbench-linked tools.
- Reuse saved connections and guards through the DBX MCP bridge, or run the
  standalone stdio mode.

### Seven-language UI

Simplified Chinese, Traditional Chinese, English, Spanish, Italian, Japanese,
and Portuguese.

## Typical workflows

### Service account inventory

1. Pick the target connection, browse the DN tree by OU, or use a filter such
   as `(objectClass=account)` (or your organization's custom class) to locate
   service accounts.
2. Use aggregated digest reads to review distributions and confirm ownership
   and naming conventions.
3. Export a CSV for the inventory deliverable.

### Controlled entry maintenance

1. Configure the connection as read-only or scope it to a narrow write Base DN
   allowlist to reduce risk at the source.
2. Edit entry attributes in the workspace; the blocked-attribute list guards
   sensitive fields.
3. Deletes and renames go through two-phase confirmation and leave audit
   records.

### AI-assisted directory operations

1. Expose the plugin tool surface to an AI client through the DBX MCP bridge,
   reusing saved connections and guards.
2. The AI uses `ldap_search_digest` for statistics and locating, and cursors
   to page through large result sets.
3. Delete/rename writes always require a preview plus a confirmation token;
   changed arguments invalidate the token.

## Usage boundaries

- DBX LDAP is a directory client; it does not provide directory server
  functionality (no bundled OpenLDAP/AD).
- Kerberos/GSSAPI depends on credentials in the runtime environment (keytab or
  tickets); the plugin does not configure Kerberos for you.
- Bulk data delivery is LDIF/CSV export oriented; there is no bulk import
  orchestration.
- In standalone stdio mode the workbench-linked tools (`ldap_ui_*`) are
  unavailable and return an explicit UNAVAILABLE message instead of hanging.

## FAQ

**Which directory servers are supported?**
Any LDAP v3 compatible server (Active Directory, OpenLDAP, 389DS, and so on).
Authentication and transport are chosen per connection.

**Can an edit accidentally wipe a whole subtree?**
Deletes (including recursive) and renames always require two-phase
confirmation: the first call returns a preview and a confirmation token; the
write executes only when the second call carries the same token and identical
arguments. Recursive deletes keep a subtree count limit. Read-only mode and
write allowlists bound the risk further upstream.

**Where are credentials stored?**
Bind passwords, Kerberos credentials, and other sensitive values are managed
by DBX host secret bindings and are not persisted by the plugin; MCP tool
arguments never carry passwords.

**Will searches on huge directories stall the response?**
MCP reads return an aggregated digest (counts, distributions, sample rows) by
default; details are paged through cursors. Scan and materialization limits are
adjustable, and every response has a size cap.

**How do I install it?**
Download the platform-matching `.dbxp` package from
[GitHub Releases](https://github.com/jinpy666/dbx-plugin-ldap/releases) and
install it from the DBX plugin center; the sidecar ships inside the package.

## Related links

- [README](../README.en.md) · [README (中文)](../README.md)
- [Feature & competitor comparison](COMPARISON.en.md)
- [MCP usage guide](MCP_USAGE.en.md)
