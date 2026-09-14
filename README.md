# DBX LDAP

[English](README.en.md)

DBX LDAP 是 DBX 的 LDAP 连接插件（插件 id `io.dbx.ldap`），提供目录浏览和
管理工作台。它适合目录查询、用户和组维护、Schema 检查以及批量导出，同时提供
明确的只读、DN 范围和属性保护策略。

## 安装

从 GitHub Releases 下载与宿主平台匹配的 `.dbxp` 安装包，在 DBX 插件中心安装即可；
无需额外依赖，sidecar 后端随包分发。

## 适合场景

- 快速定位用户、组、组织单位和服务账号。
- 检查目录 Schema、属性定义和 RootDSE 能力。
- 在审批后的 Base DN 范围内完成条目维护，并导出审计或交付数据。

## 核心能力

- DN 树浏览、分页搜索和 RFC 4515 过滤器。
- 查看、新增、编辑、重命名和删除目录条目。
- RootDSE、Schema 和属性元数据检查。
- 保存搜索预设，支持 LDIF 和 CSV 导出。
- 支持 anonymous、unauthenticated、simple、Kerberos/GSSAPI、NTLM、NTLM 哈希、
  DIGEST-MD5 和 SASL External 等认证方式。
- 支持 LDAP、StartTLS 和 LDAPS，并可配置 TLS 校验、CA 路径和服务器名称。
- 支持只读模式、允许写入的 Base DN、屏蔽属性和审计安全策略。
- 界面支持简体中文、繁体中文、英语、西班牙语、意大利语、日语和葡萄牙语。

## MCP 自动化

独立 stdio 模式启动：

```bash
backend/bin/dbx-plugin-ldap --mcp
```

常用工具包括 `ldap_search_digest`、`ldap_cursor_next`、`ldap_ui_schema` 和
`ldap_entry_write`。大结果使用 cursor 翻页，删除条目需要两阶段确认。
协议细节见 [LDAP MCP 参考](docs/MCP.zh-CN.md)。

## 安全设计

绑定密码、Kerberos 凭据和其他敏感信息由 DBX 宿主 secret binding 管理，插件不
持久化凭据。生产连接建议启用 TLS 校验、只读模式和最小化的读写 Base DN 范围。

## 开发与验证

本仓库自包含：前端宿主适配层位于 `shared/frontend/`，Go sidecar SDK 位于
`shared/sdk/go/`，不依赖 monorepo 或宿主工作区。

```bash
scripts/test.sh        # 连接表单校验 + 前端三件套 + go vet/test + 打包 + smoke（无容器环境自动 SKIP）
scripts/build.sh       # 前端构建 + sidecar 构建 + .dbxp 打包（产物在 dist/）
```

也可以分层执行：

```bash
node scripts/connection-forms/verify.mjs ldap
pnpm --dir frontend install --frozen-lockfile && pnpm --dir frontend typecheck && pnpm --dir frontend test
(cd backend && go vet ./... && go test ./...)
python3 scripts/smoke_mcp.py   # 离线 MCP smoke；真实 OpenLDAP 容器类用例无环境时 SKIP
```

实施计划与进度记录位于 `docs/`。
