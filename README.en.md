# DBX LDAP

[中文](README.md)

DBX LDAP is the LDAP connection plugin for DBX (plugin id `io.dbx.ldap`). It
provides a directory browsing and administration workspace designed for
directory searches, user and group maintenance, schema inspection, and
controlled exports, with clear read-only and write-scope protections.

## Install

Download the `.dbxp` package matching your host platform from GitHub Releases
and install it from the DBX plugin center. No extra dependencies are required;
the sidecar backend ships inside the package.

## Use cases

- Find users, groups, organizational units, and service accounts quickly.
- Inspect directory schema, attribute definitions, and RootDSE capabilities.
- Maintain entries inside approved Base DN scopes and export audit or delivery data.

## Highlights

- DN tree browsing, paged searches, and RFC 4515 filters.
- View, create, edit, rename, and delete directory entries.
- RootDSE, schema, and attribute metadata inspection.
- Saved search presets with LDIF and CSV export.
- Anonymous, unauthenticated, simple, Kerberos/GSSAPI, NTLM, NTLM hash,
  DIGEST-MD5, and SASL External authentication.
- LDAP, StartTLS, and LDAPS with configurable certificate validation, CA path,
  and server name.
- Read-only mode, allowed read/write Base DN scopes, blocked attributes, and audit controls.
- Simplified Chinese, Traditional Chinese, English, Spanish, Italian, Japanese,
  and Portuguese UI.

## MCP automation

Start standalone stdio mode with:

```bash
backend/bin/dbx-plugin-ldap --mcp
```

Useful tools include `ldap_search_digest`, `ldap_cursor_next`, `ldap_ui_schema`,
and `ldap_entry_write`. Page large results with cursors; entry deletion requires
two-phase confirmation. See the [LDAP MCP reference](docs/MCP.zh-CN.md)
(Chinese) for protocol details.

## Security

Bind passwords, Kerberos credentials, and other sensitive values are managed by
DBX host secret bindings and are not persisted by the plugin. For production
connections, enable TLS verification, read-only mode, and the narrowest practical
read/write Base DN scopes.

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

Implementation plan and progress notes live under `docs/`.
