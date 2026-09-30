# LDAP Studio

[![CI](https://github.com/jinpy666/dbx-plugin-ldap/actions/workflows/ci.yml/badge.svg)](https://github.com/jinpy666/dbx-plugin-ldap/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/jinpy666/dbx-plugin-ldap?display_name=tag)](https://github.com/jinpy666/dbx-plugin-ldap/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.en.md) · [产品宣传页](docs/MEDIA.zh-CN.md) · [特性与竞品对比](docs/COMPARISON.zh-CN.md) · [独立仓库迁移说明](docs/REPOSITORY_SPLIT.zh-CN.md)

**LDAP Studio** 是 DBX 的 LDAP 目录工作台（插件 id `io.dbx.ldap`）：一次连接，
完成 DN 树浏览、条目维护、Schema 检查和 MCP 自动化。它把"连上目录之后的
每一步"收进一个连贯、受护栏、可审计的工作流——查得到、改得放心、交给 AI
也不失控。

> 浏览 · 受控编辑 · 自动化：目录查询、条目维护和 AI 自动化，集中在同一个
> DBX 目录面板。

![LDAP Studio 工作台](docs/media/dbx-ldap-overview.png)
![LDAP Studio 功能演示](docs/media/dbx-ldap-demo.mp4)

## 一分钟上手

1. **安装**：从 [Releases](https://github.com/jinpy666/dbx-plugin-ldap/releases)
   下载对应平台的 `.dbxp`，在 DBX 插件中心一键安装。Go sidecar 随包分发、
   零外部依赖，覆盖 macOS（Apple Silicon / Intel）、Linux（x64 / ARM64）和
   Windows（x64）。
2. **连接**：填服务器地址、选认证方式（企业 AD 选 Kerberos/GSSAPI 或 NTLM），
   需要加密时启用 StartTLS/LDAPS；自签 CA、SNI 覆盖、客户端证书 mTLS 都有
   位置可填。
3. **开工**：打开 LDAP 工作台浏览 DN 树、保存常用搜索预设、按护栏编辑条目，
   交付时一键导出 LDIF/CSV。

## 为什么值得用

| 你要完成的事 | LDAP Studio 给你的体验 |
| --- | --- |
| 快速定位用户、组和服务账号 | DN 树浏览、分页搜索、RFC 4515 过滤器、可复用搜索预设；粘贴 `ldapsearch` 命令即可一键导入搜索条件 |
| 安全地维护目录条目 | 查看、新增、编辑、重命名、删除，每一步都过只读模式、Base DN 白名单、屏蔽属性三重护栏，写入留审计 |
| 什么企业目录都能连 | 从匿名、Simple 到 Kerberos/GSSAPI、NTLM、DIGEST-MD5、SASL External 的 8 种认证，OpenLDAP 与 Active Directory 通吃 |
| 传输链路全程加密 | LDAP / StartTLS / LDAPS / ldapi，证书校验、自定义 CA、SNI 覆盖、mTLS 客户端证书齐备 |
| 核查目录结构与能力 | RootDSE、Schema 与属性元数据检查，服务器信息附带 Ping、TLS 模式和控件/扩展 OID 的 RFC 说明 |
| 导出审计或交付数据 | LDIF 和 CSV 导出，保留 DN 与字段语义 |
| 让 AI 参与目录运维 | 8 个 MCP 工具复用已保存连接与护栏，删除/重命名强制两阶段确认 |

## 支持矩阵

不止一句"支持企业目录"——协议、认证和目录服务的完整清单如下，每一条都
对应可运行的实现：

**传输与加密**

| 方式 | 说明 |
| --- | --- |
| `ldap://` | 明文 LDAP，默认端口 389 |
| `ldaps://` | TLS 加密，默认端口 636 |
| StartTLS | 在明文端口上升级加密 |
| `ldapi://` | Unix 域套接字直连本机目录 IPC，服务器地址填完整 ldapi URL 即可 |
| 宿主隧道 / 代理 | 经 DBX 宿主通道连内网或远程目录 |

TLS 细节：证书校验可开关，自定义 CA 路径、服务器名称（SNI）覆盖、mTLS
客户端证书均支持。

**认证与 SASL 机制（8 种）**

| 机制 | 亮点 |
| --- | --- |
| Anonymous | 零凭据匿名浏览 |
| Simple | Bind DN、AD 登录名或 UPN 均可 |
| Unauthenticated | 只发 DN、不发密码的规范绑定 |
| Kerberos (GSSAPI) | 密码 / Keytab / ccache 三种凭据；Realm/KDC 覆盖、krb5.conf 指定或自动生成、QoP 与相互认证 |
| NTLM | `域\用户名` 登录 Active Directory |
| NTLM 哈希 | 直接用 NT 哈希连接，无需明文密码 |
| DIGEST-MD5 | 支持 SASL 主机覆盖 |
| SASL EXTERNAL | 配合 mTLS 客户端证书，以证书身份绑定 |

**LDAP 协议能力**

| 能力 | 依据 |
| --- | --- |
| 分页搜索 + cursor 翻页 | RFC 2696 |
| 服务端排序 | RFC 2891 |
| RootDSE / Schema / 属性元数据 | RFC 4512 |
| Who Am I? 当前身份核查 | RFC 4532 |
| 密码修改（专用密码编辑器） | RFC 3062 |
| LDIF 导入与导出 | RFC 2849 |
| 过滤器语法 | RFC 4515 |
| `ldapsearch` 命令导入 | 粘贴即解析 |

**目录服务适配**

| 目录 | 说明 |
| --- | --- |
| Microsoft Active Directory | `域\用户` 与 UPN 登录、Kerberos 全凭据、`objectGUID`/`objectSid`/FILETIME 二进制解码、`unicodePwd` 等密码属性读写防护 |
| OpenLDAP | 2.6 真容器集成测试，明文 / StartTLS / LDAPS / `ldapi` 套接字全传输矩阵 |
| 其他 LDAPv3 目录 | 389 Directory Server、ApacheDS、Samba AD、eDirectory 等按标准 v3 模式连接 |

## 适合场景

- 企业 AD / OpenLDAP 目录的日常查询、账号盘点和组成员审计。
- 在审批后的 Base DN 范围内完成条目维护，并导出交付数据。
- 检查目录 Schema、属性定义和 RootDSE 能力，为导入做准备。
- 通过 DBX MCP 桥让 AI 助手代跑目录巡检与变更，护栏与人工确认不缺席。

## 核心能力

- **搜索**：DN 树浏览、RFC 4515 过滤器与可复用搜索预设；RFC 2696 分页 +
  cursor 翻页、RFC 2891 服务端排序，大数据量目录不卡顿；直接粘贴
  `ldapsearch` 命令导入 Base DN、范围、过滤器、属性和数量上限——绑定参数
  自动忽略，始终沿用已保存连接与护栏。
- **条目维护**：查看、新增、编辑、重命名、删除，密码类属性走专用编辑器
  （RFC 3062 Password Modify）；全程受只读模式、读/写 Base DN 白名单与
  屏蔽属性约束，默认即屏蔽 `userPassword`、`unicodePwd` 等敏感属性，所有
  写路径落审计记录。
- **认证矩阵**：anonymous、unauthenticated、simple、Kerberos/GSSAPI（密码 /
  Keytab / ccache 三种凭据，Realm/KDC 覆盖、krb5.conf 指定、GSSAPI QoP 与
  相互认证）、NTLM、NTLM 哈希、DIGEST-MD5、SASL External。
- **传输安全**：LDAP、StartTLS、LDAPS，`ldapi://` Unix 套接字直连本机
  目录；证书校验可开关，支持自定义 CA 路径、服务器名称（SNI）覆盖与 mTLS
  客户端证书；拨号超时可独立于操作超时调优。
- **Schema 与诊断**：RootDSE、Schema、属性元数据检查；Who Am I?
  （RFC 4532）一键核查当前绑定身份；服务器信息弹窗含连接状态、Ping、TLS
  模式与控件/扩展 OID 的 RFC 说明。
- **请求日志面板**：经应用工具栏按钮或命令面板打开停靠在 DBX 底部面板的
  日志流（与内置终端同一机制）：每次 LDAP 请求（搜索、条目维护、MCP 调用）
  与连接生命周期事件实时上屏，含耗时、结果与过滤摘要；支持级别/连接筛选、
  子串查询、自动滚动与一键复制。面板关闭期间日志由 sidecar 环形缓冲保留，
  重开自动回填；凭据与敏感属性值绝不进入日志。
- **导入与导出**：LDIF 导入与导出（RFC 2849）、CSV 导出，保留 DN 语义与
  字段类型。
- **本地化**：简体中文、繁体中文、英语、西班牙语、意大利语、日语、葡萄牙语
  七种界面语言，深浅色主题跟随宿主。

完整的能力矩阵和与 ldapsearch、Apache Directory Studio、JXplorer 等工具的
定位对比见[特性与竞品对比](docs/COMPARISON.zh-CN.md)。

## MCP 自动化

推荐通过 DBX MCP 桥调用，以复用已保存连接和护栏。独立 stdio 模式可运行：

```bash
backend/bin/dbx-plugin-ldap --mcp
```

工具面共 8 个：`ldap_search_digest`（本地聚合读 + cursor 翻页）、
`ldap_cursor_next`、`ldap_entry_write`（删除/改名两阶段确认）、
`ldap_ui_schema`，以及面向 DBX 工作台的 `ldap_ui_search` / `ldap_ui_focus` /
`ldap_ui_select` / `ldap_ui_state`。AI 看到的是与人工操作相同的护栏：只读
模式、Base DN 白名单和屏蔽属性在 MCP 路径上同样生效。接入方式、参数语义和
安全边界见[MCP 使用指南](docs/MCP_USAGE.zh-CN.md)，协议细节见
[LDAP MCP 参考](docs/MCP.zh-CN.md)。

## 安全设计

绑定密码、Kerberos 凭据和其他敏感信息由 DBX 宿主 secret binding 管理，插件
不持久化凭据，MCP 工具参数中也不出现密码。生产连接建议启用 TLS 校验、只读
模式和最小化的读写 Base DN 范围；所有写路径落审计记录，MCP 的删除与重命名
必须两阶段确认。

## 安装

要求 DBX `>= 0.5.77`。从
[GitHub Releases](https://github.com/jinpy666/dbx-plugin-ldap/releases) 下载
与宿主平台匹配的 `.dbxp` 安装包（darwin-arm64 / darwin-x64 / linux-x64 /
linux-arm64 / windows-x64），在 DBX 插件中心选择本地安装即可；sidecar 后端
随包分发，无需额外依赖。

## 开发与验证

本仓库自包含：前端宿主适配层位于 `shared/frontend/`，Go sidecar SDK 位于
`shared/sdk/go/`，不依赖 monorepo 或宿主工作区。

```bash
scripts/test.sh        # 连接表单校验 + 前端三件套 + go vet/test + 打包 + smoke（无容器环境自动 SKIP）
scripts/build.sh       # 前端构建 + sidecar 构建 + .dbxp 打包（产物在 dist/，打包后自动清理旧版本产物；--skip-tests 跳过校验）
scripts/install.sh     # 用官方安装器将最新 .dbxp 装入 DBX 并清理旧版本（--reinstall / --no-restart / --keep-old）
scripts/clean.sh       # 清理 dist/ 旧版本产物、backend/bin 与 __pycache__（--all 连当前产物一起清）
```

也可以分层执行：

```bash
node scripts/connection-forms/verify.mjs ldap
pnpm --dir frontend install --frozen-lockfile && pnpm --dir frontend typecheck && pnpm --dir frontend test
(cd backend && go vet ./... && go test ./...)
python3 scripts/smoke_mcp.py   # 离线 MCP smoke；真实 OpenLDAP 容器类用例无环境时 SKIP
```

## 文档

- [产品宣传页](docs/MEDIA.zh-CN.md)：定位、亮点特性、典型工作流与 FAQ。
- [特性与竞品对比](docs/COMPARISON.zh-CN.md)：与 ldapsearch、Apache Directory
  Studio、JXplorer 的定位对比。
- [MCP 使用指南](docs/MCP_USAGE.zh-CN.md)：接入 DBX MCP 桥或独立 stdio 模式。
- [LDAP MCP 参考](docs/MCP.zh-CN.md)：协议方法、工具参数与降级矩阵。
- [独立仓库迁移说明](docs/REPOSITORY_SPLIT.zh-CN.md)：仓库边界与发布前置条件。
- [实施计划](docs/IMPL_PLAN_DBX_LDAP.zh-CN.md)与进度记录位于 `docs/`。
