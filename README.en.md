# DBX LDAP

[![CI](https://github.com/jinpy666/dbx-plugin-ldap/actions/workflows/ci.yml/badge.svg)](https://github.com/jinpy666/dbx-plugin-ldap/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/jinpy666/dbx-plugin-ldap?display_name=tag)](https://github.com/jinpy666/dbx-plugin-ldap/releases)

[中文](README.md) · [Product page](docs/MEDIA.en.md) · [Feature & competitor comparison](docs/COMPARISON.en.md) · [Standalone repo migration](docs/REPOSITORY_SPLIT.en.md)

DBX LDAP is the LDAP directory workspace for DBX (plugin id `io.dbx.ldap`):
open one connection and get directory browsing, guarded entry maintenance,
schema inspection, and MCP automation in a single, auditable workflow.

> LDAP Directory · Guarded Editing · Automation: browsing, editing, auditing,
> and AI automation live in one DBX directory panel.

## Why it is worth using

| What you need to do | What DBX LDAP gives you |
| --- | --- |
| Find users, groups, and service accounts fast | DN tree browsing, paged searches, RFC 4515 filters, and reusable search presets |
| Maintain entries without fear | View, create, edit, rename, and delete — every write passes Base DN and blocked-attribute guards |
| Authenticate against enterprise directories | anonymous, simple, Kerberos/GSSAPI, NTLM, DIGEST-MD5, SASL External, and more |
| Audit directory structure and capabilities | RootDSE, schema, and attribute metadata inspection |
| Export audit or delivery data | LDIF and CSV export that preserves DN semantics |
| Let AI help with directory ops | 8 MCP tools that reuse connections, guards, and two-phase write confirmation |

## Use cases

- Everyday lookups, account inventories, and group membership audits against
  corporate AD / OpenLDAP directories.
- Entry maintenance inside approved Base DN scopes, followed by delivery exports.
- Inspecting directory schema, attribute definitions, and RootDSE capabilities
  before imports.

## Highlights

- DN tree browsing, paged searches, and RFC 4515 filters with saved presets.
- View, create, edit, rename, and delete directory entries.
- RootDSE, schema, and attribute metadata inspection.
- LDIF and CSV export.
- Authentication matrix: anonymous, unauthenticated, simple, Kerberos/GSSAPI,
  NTLM, NTLM hash, DIGEST-MD5, and SASL External.
- Transport security: LDAP, StartTLS, and LDAPS with configurable certificate
  validation, CA path, and server name.
- Safety guards: read-only mode, allowed write Base DN allowlists, blocked
  attributes, and audit records.
- Simplified Chinese, Traditional Chinese, English, Spanish, Italian, Japanese,
  and Portuguese UI.

For the full capability matrix and how DBX LDAP compares with ldapsearch,
Apache Directory Studio, and JXplorer, see
[Feature & competitor comparison](docs/COMPARISON.en.md).

## MCP automation

Prefer the DBX MCP bridge so saved connections and guards are reused. Standalone
stdio mode can be started with:

```bash
backend/bin/dbx-plugin-ldap --mcp
```

The tool surface has 8 tools: `ldap_search_digest` (locally aggregated reads
with cursor paging), `ldap_cursor_next`, `ldap_entry_write` (two-phase
confirmation for deletes and renames), `ldap_ui_schema`, plus the workbench
tools `ldap_ui_search` / `ldap_ui_focus` / `ldap_ui_select` / `ldap_ui_state`.
See the [MCP usage guide](docs/MCP_USAGE.en.md) for setup, parameters, and
safety boundaries; the protocol-level
[LDAP MCP reference](docs/MCP.zh-CN.md) is available in Chinese.

## Security

Bind passwords, Kerberos credentials, and other sensitive values are managed by
DBX host secret bindings; the plugin never persists them, and MCP tool arguments
never carry passwords. For production connections, enable TLS verification,
read-only mode, and the narrowest practical read/write Base DN scopes. All write
paths leave audit records.

## Install

Download the `.dbxp` package matching your host platform from
[GitHub Releases](https://github.com/jinpy666/dbx-plugin-ldap/releases) and
install it from the DBX plugin center. The sidecar backend ships inside the
package; no extra dependencies are required.

## Development

This repository is self-contained: the frontend host-adaptation layer lives in
`shared/frontend/` and the Go sidecar SDK in `shared/sdk/go/`; neither the
monorepo nor a host worktree is required.

```bash
scripts/test.sh        # form contract + frontend three-step + go vet/test + package + smoke (SKIPs without container environments)
scripts/build.sh       # frontend build + sidecar build + .dbxp packaging (artifacts in dist/)
```

Or run layers individually:

```bash
node scripts/connection-forms/verify.mjs ldap
pnpm --dir frontend install --frozen-lockfile && pnpm --dir frontend typecheck && pnpm --dir frontend test
(cd backend && go vet ./... && go test ./...)
python3 scripts/smoke_mcp.py   # offline MCP smoke; live OpenLDAP container cases SKIP without an environment
```

## Documentation

- [Product page](docs/MEDIA.en.md): positioning, feature highlights, typical
  workflows, and FAQ.
- [Feature & competitor comparison](docs/COMPARISON.en.md): where DBX LDAP
  stands versus ldapsearch, Apache Directory Studio, and JXplorer.
- [MCP usage guide](docs/MCP_USAGE.en.md): DBX MCP bridge or standalone stdio.
- [LDAP MCP reference](docs/MCP.zh-CN.md): protocol methods, tool parameters,
  and degradation matrix (Chinese).
- [Standalone repo migration](docs/REPOSITORY_SPLIT.en.md): repo boundaries and
  release prerequisites.
- The implementation plan and progress notes live under `docs/`.
