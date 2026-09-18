#!/usr/bin/env bash
# Clean regenerable local build artifacts (never touches tracked sources).
#
#   scripts/clean.sh          # drop stale dist/ artifacts (keep the version in
#                             # manifest.json) + backend/bin + scripts/__pycache__
#   scripts/clean.sh --all    # also drop the current dist/ artifacts
#
# frontend/node_modules is intentionally kept: restoring dependencies costs far
# more than what the cache saves.
set -euo pipefail
cd "$(dirname "$0")/.."

ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

PLUGIN_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json 2>/dev/null | head -1)"

echo "==> dist/ (keeping v${PLUGIN_VERSION:-unknown}; pass --all to remove these too)"
removed=0
shopt -s nullglob
for f in dist/*.dbxp dist/*.artifact.json; do
  case "$f" in
    *"-${PLUGIN_VERSION}-"*) is_current=1 ;;
    *) is_current=0 ;;
  esac
  if [ "$ALL" = 1 ] || { [ "$is_current" = 0 ] && [ -n "$PLUGIN_VERSION" ]; }; then
    rm -f "$f"
    echo "  removed $(basename "$f")"
    removed=$((removed + 1))
  fi
done
shopt -u nullglob

for path in backend/bin scripts/__pycache__; do
  [ -e "$path" ] || continue
  rm -rf "$path"
  echo "removed $path/"
done

echo "clean done (dist entries removed: ${removed})"
