# LDAP MCP Usage Guide

This guide explains how to connect AI clients to the DBX LDAP MCP tool
surface. Protocol methods, full parameter tables, and the degradation matrix
live in the [LDAP MCP reference](MCP.zh-CN.md) (Chinese); this page covers
usage only. Tool names follow the backend registry — 8 tools in total.

## Two ways to connect

| Mode | Best for | Notes |
| --- | --- | --- |
| DBX MCP bridge (recommended) | DBX app running | Calls go through the host `dbx_list_plugin_tools` / `dbx_call_plugin_tool`; saved connections, guards, and credentials are reused, and passwords never appear in tool arguments |
| Standalone stdio mode | Automation without DBX present | `backend/bin/dbx-plugin-ldap --mcp` starts an MCP server (MCP 2024-11-05, newline-delimited JSON-RPC 2.0); credentials are passed inline per call and never persisted |

### Standalone stdio configuration example (ZCode)

```json
{
  "mcp": {
    "servers": {
      "dbx-ldap": {
        "type": "stdio",
        "command": "/absolute/path/backend/bin/dbx-plugin-ldap",
        "args": ["--mcp"]
      }
    }
  }
}
```

In stdio mode, connection tools accept inline connection parameters (`host`
required, plus `port`, `tlsMode`, `authType`, `bindDn`, `password`, and so on
— camelCase, aligned with the connection form). Calls with identical
parameters are pooled by hash into an `mcp-<hash>` style `connectionId` and
reused automatically. Passing a DBX saved-connection id that is not pooled in
this session forwards the call through the app's local bridge (fail-closed: if
the bridge is unavailable you get an actionable error, never a silent retry).
Note: Kerberos-family options and DN allowlist policies require a workbench
saved connection; the five `ldap_ui_*` tools return an explicit `UNAVAILABLE`
message in stdio mode (they need the DBX workbench) instead of hanging.

## Tool list (8)

| Tool | Purpose | Key parameters (camelCase) |
| --- | --- | --- |
| `ldap_search_digest` | Core read: server-side filter execution, local aggregation in the sidecar | `connectionId`/inline `host` and `filter` required; `baseDn`, `scope`, `attributes`, `distinctAttr`, `format` (digest default / rows) |
| `ldap_cursor_next` | Page through a digest session without re-sending filters or re-scanning | `cursorId` required; `n` (≤20), `offset` |
| `ldap_entry_write` | Write entry point: add/modify/delete/modifyDn | `connectionId`, `action`, `dn` required; per-action `attributes`/`changes`/`recursive`/`newRdn`/`confirmToken` |
| `ldap_ui_schema` | attributeType/objectClass names from schema, to build valid filters | `connectionId` required |
| `ldap_ui_search` | Fill search criteria into the DBX workbench and trigger it | `filter` required; `baseDn`, `scope`, `attributes`, `sizeLimit` |
| `ldap_ui_focus` | Focus a workbench panel (search/tree/schema) | `panel` required |
| `ldap_ui_select` | Locate a DN in the results table and open the entry | `dn` required |
| `ldap_ui_state` | Read an intent result or the latest UI snapshot | optional `intentId` |

## Task → tool quick reference

- Aggregate directory data (counts, objectClass distributions, subtree counts,
  distinct value ranges) → `ldap_search_digest` (default `format:"digest"`).
- See real detail rows → `ldap_search_digest` with `format:"rows"` (≤20 rows),
  then `ldap_cursor_next` to keep paging.
- Confirm an attribute/object class exists before building a filter →
  `ldap_ui_schema`.
- Create or modify entries → `ldap_entry_write` with `action:"add"` /
  `action:"modify"`.
- Delete (including recursive) or rename/move → `ldap_entry_write` with
  `action:"delete"` / `action:"modifyDn"`, **always two-phase**: the first
  call without `confirmToken` returns a preview plus a token; the second call
  repeats the arguments and adds the token.
- Let the user see results in the DBX workbench and keep working → the
  `ldap_ui_*` family (workbench mode only).

## Read-path semantics (token economy)

- The default `format:"digest"` returns counts, distributions, and at most 5
  sample rows; details page through `ldap_cursor_next`, ≤20 rows per batch.
- The remote scan limit defaults to 1000 entries (lower it with `sizeLimit`,
  raise it via the `digestScanLimit` setting); cursor sessions default to a
  10-minute TTL, LRU ≤8 sessions, and ≤10,000 materialized rows.
- A single response is capped at 16 KiB; overflow drops samples → rows →
  stats in that order and sets `truncated:true`.
- Scanned data never leaves the sidecar (beyond samples/paged rows);
  aggregation happens locally.

## Write path and safety boundaries

- `add` / `modify` execute in one phase; `delete` (including recursive, with
  the 1000-entry subtree limit) and `modifyDn` are always two-phase. The
  confirm token is single-use, expires after 60 seconds (adjustable via the
  `confirmTtlSecs` setting, 10–600), and is bound to the argument hash —
  changed arguments or a different connection invalidate it.
- On read-only connections the write tools are not listed, and the call path
  refuses them again (defense in depth).
- Write DNs containing raw control characters are rejected locally (protecting
  the audit log from injection).
- Every MCP write is audited with `source:"mcp"` into the same audit.jsonl as
  workbench writes.
- Errors carry self-correction hints: unknown tool names list all available
  tools; expired cursors suggest re-issuing `ldap_search_digest`; missing
  required parameters are enumerated in one message.

## Adjustable settings (`mcp/settings/set`)

Common items: `digestScanLimit` (1–100000), `maxCursorRows` (1–100000),
`cursorTtlSecs` (1–3600), `maxCursorSessions` (1–32), `confirmTtlSecs`
(10–600), `responseLimitBytes` (1 KiB–1 MiB), `reportWaitMs` (UI intent wait,
1–30000), `cellWidth`, `digestGroupLimit`, `digestTopN`, `digestSampleRows`,
`digestRowLimit`. The full table is in the
[LDAP MCP reference](MCP.zh-CN.md) (Chinese).

## Verification

The offline smoke needs no real directory; container-based cases print `SKIP`
when the environment is unavailable — an offline pass is not a live pass:

```bash
DBX_PLUGIN_SIDECAR=/path/to/dbx-plugin-ldap python3 scripts/smoke_mcp.py
```

Manual single-request smoke:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | backend/bin/dbx-plugin-ldap --mcp
```

## Related links

- [LDAP MCP reference](MCP.zh-CN.md) (Chinese): protocol methods, full tool
  parameter tables, degradation matrix, and acceptance cases.
- [README](../README.en.md) · [Product page](MEDIA.en.md)
