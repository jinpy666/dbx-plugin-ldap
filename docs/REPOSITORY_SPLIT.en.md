# LDAP plugin standalone repository migration notes

## Origin and history

This repository was split out of `/Users/Jinpy/btroot/dbx-plugins/ldap`; the
migration baseline is monorepo commit
`ce19beb4fa75cc79048e3ba8852c298d674fd9b3` (master at split time). The initial
import used `git subtree split --prefix=ldap`, so the full LDAP-relevant commit
history is preserved (subtree split only carries tracked files; ignored
artifacts such as `node_modules/`, `dist/`, `target/` and screenshots never
enter the history).

The source repository's `host` submodule was in the user's local "M host"
state; this migration did not update, reset, clean, or write it. The monorepo
working tree was not modified in any other way (a temporary `split-ldap-tmp`
branch was created and deleted).

## Standalone repository contents

- The repository root directly contains `manifest.json`, `dbx-plugin.toml`,
  `frontend/`, `backend/`, `assets/`, `ui/`, `scripts/`, `docs/` and
  `.github/`.
- `shared/frontend/` keeps only the modules LDAP actually uses (`themeSync`,
  `uiIntent`) plus their documentation; no ssh, files, or kafka code was
  vendored (`binaryEvent.ts` / `editorTheme.ts` currently have no LDAP
  references). Frontend import depth changed from three levels in the
  monorepo (`../../../shared/frontend/...`) to two levels
  (`../../shared/frontend/...`; specs under `frontend/src/lib/` use three).
- `shared/sdk/go/dbx-plugin-sdk/` is the minimal Go sidecar SDK vendoring
  matching the split baseline (`go.mod` / `sdk.go` / `sdk_test.go` /
  `README.md`, stdlib only), so `go vet` / `go test` no longer depend on
  `../dbx-plugin-host-worktree`. The replace at the end of
  `backend/go.mod` now points to `=> ../shared/sdk/go/dbx-plugin-sdk`;
  `dbx-plugin package` injects its own resolution path via
  `DBX_PLUGIN_SDK_ROOT + go.work`, so this replace does not affect packaging
  and `go.sum` needs no change.
- `scripts/connection-forms/verify.mjs` is a standalone connection-form
  contract verifier embedding the host-compatible visibility/required cascade
  checks plus the LDAP authentication × TLS scenario matrix; it accepts the
  monorepo-style `verify.mjs ldap` argument and defaults to ldap without one.
- `scripts/validate_repo.py` validates the standalone identity: manifest
  fields, sidecar executable name, dbx-plugin.toml paths, Go module name and
  main.go version injection, and the required-file list.
- `scripts/check_candidates.py` is reused verbatim from the upstream release
  pipeline shape (no plugin coupling).
- `scripts/cli-platform.sh` extends the original Darwin/Linux mapping with
  Windows (MINGW/MSYS → `win32-x64`) so all five CI targets use the native
  plugin-cli binary and avoid the npm wrapper's bundled-SDK go.work version
  conflict.

## Committed ui/ output

The frontend build output is a single self-contained `ui/index.html`
(produced by `frontend/build.mjs`), committed to version control like the
reference repository; the CI frontend job ends with a
`git diff --quiet -- ui/` freshness check — after frontend changes, rerun
`pnpm --dir frontend build` and commit `ui/`.

## CI and release

- `.github/workflows/ci.yml` has five jobs: validate (manifest/form
  contract), frontend (typecheck/test/build + ui/ freshness), backend
  (`go vet` + `go test` on go 1.24.x), candidate (matrix of linux-x64 /
  linux-arm64 / darwin-arm64 / darwin-x64 / windows-x64: pnpm + node22 + go +
  plugin-cli 0.1.3 → `bash scripts/build.sh` → `python3 scripts/smoke_mcp.py`
  offline smoke against the freshly built sidecar → upload `dist/*.dbxp` and
  `dist/*.artifact.json`), and candidates-check
  (`check_candidates.py dist --expect <five targets>`).
- `.github/workflows/release.yml` triggers only on GitHub Releases tagged
  `ldap-v<manifest.version>`, builds all five targets self-contained, and
  uploads the `.dbxp` files plus `release-candidates.json`; it does not use
  the t8y2/dbx reusable workflow.
- The offline smoke selects the sidecar via the `DBX_PLUGIN_SIDECAR`
  environment variable (the script has no `--binary` flag); container-based
  cases print `SKIP` when no OpenLDAP container is available.
- `manifest.json` `source`/`homepage` point to
  `https://github.com/jinpy666/dbx-plugin-ldap`. No further edit is needed
  once the GitHub repository exists; a matching `ldap-v<manifest.version>`
  tag must be created before releasing.

## Bug write-back and release boundary

Bugs found in this repository are fixed here and must pass CI first; if the
DBX Host API, the host installer, or the common SDK needs changes, open a
separate DBX host/SDK change and record the affected versions in the
issue/PR. Never point this repository back at the monorepo's `../shared`;
cross-plugin reuse should go through published packages or explicit synced
copies in each standalone repository.

Real LDAP servers, the Docker test containers
(`docker-compose.ldap-test.yml` / `docker-compose.ldap-tls-test.yml`), and
the DBX.app host install pipeline are not offline CI pass conditions; live
and e2e scripts must print `SKIP` when the environment is missing and must
never fake a `PASS`.

Version policy: the `version` in `manifest.json` is the single source of
truth and continues from `0.1.67` at split time; the sidecar version is
injected from the manifest during packaging
(`-ldflags "-X main.version=..."`) and the host verifies it at init.
