#!/usr/bin/env bash
# Build the LDAP plugin frontend and package a .dbxp for the current platform.
# Frontend three-step (typecheck/test/build) is owned by this path; the Go
# backend + manifest.json are owned by the backend path — packaging is
# attempted only when manifest.json exists. Stale dist/ artifacts from older
# plugin versions are pruned after packaging.
#
# Usage:
#   scripts/build.sh                # typecheck + tests + build + package
#   scripts/build.sh --skip-tests   # fast iteration: vite build + package only
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v pnpm >/dev/null; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v22*/bin 2>/dev/null | sort -V | tail -1 || true)"
  export PATH="$HOME/Library/pnpm:${NODE_BIN:+$NODE_BIN:}$PATH"
fi

SKIP_TESTS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# Release CI builds the target-independent UI once per plugin and stages ui/
# here as an artifact; DBX_PREBUILT_UI=1 packages it as-is instead of rerunning
# the frontend three-step on every platform job.
if [ "${DBX_PREBUILT_UI:-0}" = "1" ]; then
  if [ ! -f ui/index.html ]; then
    echo "DBX_PREBUILT_UI=1 but ui/index.html is missing; stage the CI frontend artifact first" >&2
    exit 1
  fi
  echo "==> frontend: skipped (prebuilt ui/ staged by CI)"
else
  echo "==> frontend: install + typecheck + test + build"
  if [ ! -d frontend/node_modules ]; then
    pnpm --dir frontend install --frozen-lockfile
  fi
  if [ "$SKIP_TESTS" = 1 ]; then
    echo "--skip-tests: frontend typecheck + test skipped (artifacts are NOT verified)"
  else
    pnpm --dir frontend typecheck
    pnpm --dir frontend test
  fi
  pnpm --dir frontend build
fi

echo "==> package .dbxp"
unset DBX_PLUGIN_SDK_ROOT
if ! command -v dbx-plugin >/dev/null 2>&1; then
  HOST="${DBX_HOST_WORKTREE:-$PWD/../dbx-plugin-host-worktree}"
  if [ ! -x "$HOST/plugins/sdk/cli/target/release/dbx-plugin" ]; then
    (cd "$HOST/plugins/sdk/cli" && cargo build --release)
  fi
  export PATH="$HOST/plugins/sdk/cli/target/release:$PATH"
fi

if [ ! -f manifest.json ]; then
  echo "SKIP: manifest.json not present yet (backend path owns it); frontend artifacts are in ui/"
  exit 0
fi

# Identity version comes from manifest.json — the single source of truth — so
# the sidecar's reported identity always matches the manifest (the host rejects
# mismatches at init: "backend identity ... does not match manifest").
PLUGIN_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)"
PLUGIN_VERSION="${PLUGIN_VERSION:-0.0.0-dev}"

# Build the Go sidecar first when the backend workspace is present.
# backend/bin is for local smoke/debug; the packaging CLI rebuilds the sidecar
# itself (build_go_backend runs plain `go build`, no ldflags support), so the
# same version is injected into that rebuild via GOFLAGS below.
if [ -f backend/go.mod ] && command -v go >/dev/null 2>&1; then
  echo "==> backend: go build (owned by backend path; failures are recorded in docs/PROGRESS-P-LDAP.zh-CN.md)"
  (cd backend && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${PLUGIN_VERSION}" -o bin/dbx-plugin-ldap .) || {
    echo "WARN: go build failed (backend under parallel development); packaging will fail until it is green"
  }
fi

# The npm CLI wrapper injects DBX_PLUGIN_SDK_ROOT (bundled SDK ships a go.work
# pinned to go 1.22, which breaks modules requiring >=1.24). Call the native
# binary directly without SDK_ROOT so the local Go toolchain is used. The
# platform package suffix is resolved per-machine (linux uses a -gnu suffix).
. scripts/cli-platform.sh
if NATIVE_CLI="$(resolve_native_plugin_cli)"; then
  env -u DBX_PLUGIN_SDK_ROOT NO_COLOR=1 GOFLAGS="-ldflags=-X=main.version=${PLUGIN_VERSION}" "$NATIVE_CLI" package .
else
  echo "WARN: native plugin-cli for $(uname -s)/$(uname -m) not found; falling back to the npm wrapper (its bundled SDK may conflict with backend go.mod)" >&2
  env -u DBX_PLUGIN_SDK_ROOT NO_COLOR=1 GOFLAGS="-ldflags=-X=main.version=${PLUGIN_VERSION}" dbx-plugin package .
fi

# Prune .dbxp/.artifact.json left over from older plugin versions so dist/
# holds only the build just produced (install.sh picks the newest file).
echo "==> pruning stale dist artifacts (keeping v${PLUGIN_VERSION})"
shopt -s nullglob
for f in dist/*.dbxp dist/*.artifact.json; do
  case "$f" in
    *"-${PLUGIN_VERSION}-"*) continue ;;
  esac
  rm -f "$f"
  echo "  removed $(basename "$f")"
done
shopt -u nullglob

echo
echo "Artifacts:"
ls -la dist/*.dbxp dist/*.artifact.json 2>/dev/null || true
