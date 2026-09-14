#!/usr/bin/env python3
"""Validate standalone LDAP plugin identity and package-relative paths."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


def main() -> int:
    manifest_path = ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 1:
        fail("manifest_version must be 1")
    if manifest.get("id") != "io.dbx.ldap":
        fail(f"manifest id is {manifest.get('id')!r}, expected io.dbx.ldap")
    version = manifest.get("version")
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        fail(f"invalid manifest version: {version!r}")
    for field in ("source", "homepage"):
        value = manifest.get(field, "")
        if not isinstance(value, str) or not value.startswith(("http://", "https://")):
            fail(f"{field} must be an HTTP(S) URL")

    entrypoint = manifest.get("entrypoints", {}).get("backend", {})
    if entrypoint.get("executable") != "bin/dbx-plugin-ldap":
        fail("backend executable must be bin/dbx-plugin-ldap")
    if manifest.get("entrypoints", {}).get("ui", {}).get("entry") != "ui/index.html":
        fail("UI entry must be ui/index.html")

    toml = (ROOT / "dbx-plugin.toml").read_text(encoding="utf-8")
    if 'directory = "backend"' not in toml or 'binary = "dbx-plugin-ldap"' not in toml:
        fail("dbx-plugin.toml backend identity/path is stale")

    go_mod = (ROOT / "backend/go.mod").read_text(encoding="utf-8")
    if not re.search(r'(?m)^module\s+io\.dbx\.ldap\.plugin\s*$', go_mod):
        fail("backend Go module does not match plugin identity")
    if "../shared/sdk/go/dbx-plugin-sdk" not in go_mod:
        fail("backend go.mod must replace the SDK with the vendored copy under shared/sdk/go")

    main_go = (ROOT / "backend/main.go").read_text(encoding="utf-8")
    if 'var version = "0.0.0-dev"' not in main_go:
        fail("backend version fallback variable is missing or stale")
    if "NewStdioServer(version" not in main_go:
        fail("backend must pass the manifest-injected version into the MCP identity")

    required = [
        ".dbx-store.json",
        "assets/plugin.svg", "frontend/package.json", "backend/go.mod",
        "scripts/test.sh", "scripts/build.sh", "scripts/cli-platform.sh",
        "scripts/smoke_mcp.py", "scripts/connection-forms/verify.mjs",
        "shared/frontend/themeSync.ts", "shared/frontend/uiIntent.ts",
        "shared/sdk/go/dbx-plugin-sdk/go.mod",
        "shared/sdk/go/dbx-plugin-sdk/sdk.go",
    ]
    for relative in required:
        if not (ROOT / relative).exists():
            fail(f"missing required path: {relative}")

    store = json.loads((ROOT / ".dbx-store.json").read_text(encoding="utf-8"))
    if store.get("name") != manifest.get("name"):
        fail(".dbx-store.json name does not match manifest name")
    if store.get("permissions") != manifest.get("permissions"):
        fail(".dbx-store.json permissions must mirror manifest permissions")
    if store.get("source") != manifest.get("source") or store.get("homepage") != manifest.get("homepage"):
        fail(".dbx-store.json source/homepage must match manifest source/homepage")

    print(f"PASS repository identity: {manifest['id']} {version}; standalone paths, vendored SDK and store listing present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
