# LDAP 插件独立仓库迁移说明

## 迁移来源与历史

本仓库由 `/Users/Jinpy/btroot/dbx-plugins/ldap` 拆出，迁移基线为源 monorepo
commit `ce19beb4fa75cc79048e3ba8852c298d674fd9b3`（master 分支拆分时点）。初始
导入使用 `git subtree split --prefix=ldap`，因此保留了 LDAP 目录相关的全部提交
历史（subtree split 只携带 tracked 文件，`node_modules/`、`dist/`、`target/`
与截图等被忽略的产物天然不进入历史）。

源仓库当时的 `host` 子模块处于用户本机的 "M host" 状态，本次迁移没有更新、
reset、清理或写入它；monorepo 工作区除生成临时 `split-ldap-tmp` 分支（已删除）
外无任何改动。

## 独立仓库内容

- 根目录直接包含 `manifest.json`、`dbx-plugin.toml`、`frontend/`、`backend/`、
  `assets/`、`ui/`、`scripts/`、`docs/` 和 `.github/`。
- `shared/frontend/` 只保留 LDAP 实际使用的 `themeSync`、`uiIntent` 及说明；
  没有迁入 ssh、files 或 kafka 的代码（`binaryEvent.ts`、`editorTheme.ts` 当前
  无 LDAP 引用）。前端导入深度已从 monorepo 的三级
  （`../../../shared/frontend/...`）调整为独立仓库的两级
  （`../../shared/frontend/...`；`frontend/src/lib/` 下的 spec 为三级）。
- `shared/sdk/go/dbx-plugin-sdk/` 是与拆分基线匹配的最小 Go sidecar SDK
  vendoring（`go.mod` / `sdk.go` / `sdk_test.go` / `README.md`，纯标准库），
  使 `go vet` / `go test` 不再依赖 `../dbx-plugin-host-worktree`。
  `backend/go.mod` 末尾 replace 相应改为 `=> ../shared/sdk/go/dbx-plugin-sdk`；
  `dbx-plugin package` 打包时 CLI 会经 `DBX_PLUGIN_SDK_ROOT + go.work` 注入
  自己的解析路径，此 replace 不影响打包，`go.sum` 无需变更。
- `scripts/connection-forms/verify.mjs` 是连接表单契约的独立校验器，内嵌与
  DBX Host 条件语义一致的可见性/必填级联检查及 LDAP 认证×TLS 场景矩阵；
  兼容 monorepo 调用形式 `verify.mjs ldap`，也允许无参默认 ldap。
- `scripts/validate_repo.py` 校验独立仓库身份：manifest 字段、sidecar 可执行
  名、dbx-plugin.toml 路径、Go module 名与 main.go 版本注入、必需文件清单。
- `scripts/check_candidates.py` 与上游发布管线同源，原样复用（无插件耦合）。
- `scripts/cli-platform.sh` 在 monorepo 原有 Darwin/Linux 映射基础上补充了
  Windows（MINGW/MSYS → `win32-x64`）映射，使五个 CI target 都能走原生
  plugin-cli 二进制，避开 npm wrapper 自带 SDK 的 go.work 版本冲突。

## ui/ 提交产物

前端构建产物是单个自包含的 `ui/index.html`（`frontend/build.mjs` 产出），与
参考仓库一致地提交进版本库；CI frontend job 末尾用 `git diff --quiet -- ui/`
做 freshness 检查，改动前端后必须重新 `pnpm --dir frontend build` 并提交 `ui/`。

## CI 与发布

- `.github/workflows/ci.yml` 五个 job：validate（manifest/表单契约）、
  frontend（typecheck/test/build + ui/ freshness）、backend（`go vet` +
  `go test`，go 1.24.x）、candidate（linux-x64 / linux-arm64 / darwin-arm64 /
  darwin-x64 / windows-x64 五目标矩阵：装 pnpm + node22 + go + plugin-cli
  0.1.3 → `bash scripts/build.sh` 打包 → `python3 scripts/smoke_mcp.py` 对新
  构建的 sidecar 跑离线 smoke → 上传 `dist/*.dbxp` 与 `dist/*.artifact.json`）、
  candidates-check（`check_candidates.py dist --expect <五目标>`）。
- `.github/workflows/release.yml` 仅在 `ldap-v<manifest.version>` 形态的
  GitHub Release 上触发，自包含完成五目标构建并上传 `.dbxp` 与
  `release-candidates.json`，不使用 t8y2/dbx 的 reusable workflow。
- 离线 smoke 以 `DBX_PLUGIN_SIDECAR` 环境变量指定 sidecar（该脚本无
  `--binary` 参数）；无 OpenLDAP 容器环境时容器类用例输出 `SKIP`。
- 当前 `manifest.json` 的 `source`/`homepage` 写的是
  `https://github.com/jinpy666/dbx-plugin-ldap`。创建 GitHub 仓库后无需再改；
  发布前必须创建匹配 `ldap-v<manifest.version>` 的 tag。

## Bug 回写与发布边界

独立仓库中的 bug 先在本仓库修复并通过 CI；若 DBX Host API、宿主安装器或公共
SDK 需要变更，应另开 DBX host/SDK 变更并在 issue/PR 中记录对应版本。不要把
本仓库重新指向 monorepo 的 `../shared`；需要跨插件复用时应发布公共包或同步回
各独立仓库的明确版本。

真实 LDAP 服务、Docker 测试容器（`docker-compose.ldap-test.yml` /
`docker-compose.ldap-tls-test.yml`）和 DBX.app host 安装管线不是离线 CI 的
通过条件；没有这些环境时相关 live/e2e 脚本必须输出 `SKIP`，不能伪报 `PASS`。

版本号策略：`manifest.json` 的 `version` 是唯一事实来源，沿用拆分时的
`0.1.67` 连续演进；sidecar 版本由打包流程从 manifest 注入（`-ldflags "-X
main.version=..."`），宿主在 init 时校验一致性。
