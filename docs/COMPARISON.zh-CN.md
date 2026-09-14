# 特性与方案对比

这是一份定位对比，不是性能、价格或安全审计报告。第三方产品的功能会随版本、
平台、插件和商业计划变化；"—"表示该能力不是该方案的核心内置体验，"外部工具"
表示通常需要命令行、插件或额外配置。对第三方产品的标注以公开产品定位为依据，
建议在选型前按目标平台和具体版本复核。

## 能力矩阵

| 能力 | DBX LDAP | ldapsearch / ldapmodify | Apache Directory Studio | JXplorer |
| --- | --- | --- | --- | --- |
| 图形化连接管理 | 内置 | — | 内置 | 内置 |
| 图形化 DN 树浏览 | 内置 | — | 内置 | 内置 |
| 过滤器搜索（RFC 4515） | 内置 | 内置 | 内置 | 内置 |
| 条目增删改与重命名 | 内置（护栏内） | 外部 `ldapmodify`/`ldapdelete`/`ldapmodrdn` | 内置 | 内置 |
| 认证矩阵（simple/Kerberos/NTLM/DIGEST-MD5/SASL External） | 内置 | 内置（SASL/GSSAPI） | 内置/版本相关 | 内置（SASL，Kerberos 版本相关） |
| LDAP / StartTLS / LDAPS 与证书校验 | 内置 | 内置 | 内置 | 内置 |
| RootDSE / Schema 检查 | 内置 | 外部（需手工读 subschema） | 内置 | 内置 |
| LDIF / CSV 导出 | LDIF + CSV | LDIF 输出 | LDIF 导入导出 | LDIF 导出/版本相关 |
| 只读模式与写入 Base DN 白名单 | 内置 | 需脚本/流程约束 | 连接级只读选项 | 需人工约束 |
| 删除/改名两阶段确认与审计记录 | 内置 | — | 删除确认弹窗 | 删除确认弹窗 |
| 结果聚合统计（计数/分布/样本）与深翻页 | 内置 | — | — | — |
| MCP 自动化工具面 | 内置 | — | — | — |
| DBX 宿主 secret binding | 原生 | — | — | — |
| 七语插件界面 | 内置 | — | 多语言 | 多语言 |

## DBX 插件家族中的位置

| 插件 | 主要对象 | 适合任务 |
| --- | --- | --- |
| DBX SSH 终端 | SSH 主机、终端、SFTP、远程运维 | 登录服务器、执行命令、浏览与传输文件 |
| DBX Files | 文件系统与对象存储 | 文件浏览、上传下载、归档和跨存储整理 |
| DBX LDAP | LDAP 目录 | 查询、统计、编辑目录条目 |
| DBX Kafka | Kafka 集群 | Topic、消息、消费组和 Schema 运维 |

LDAP 工作台不重复实现文件传输、终端或消息队列的专用协议；它专注于目录数据
本身，并通过 DBX 宿主能力复用连接、凭据保管和工作台桥接。

## 如何选择

- 只需要脚本化查询：选择 `ldapsearch`；它最轻量，与 shell 管道组合自然，
  写操作交给 `ldapmodify`/`ldapdelete` 等配套命令。
- 需要深度 Schema/ACI 编辑或 ApacheDS 服务器管理：Apache Directory Studio
  是功能全面的桌面套件，适合目录架构师场景。
- 需要轻量、跨平台的 Java 浏览器做快速查看与基本编辑：JXplorer 足够。
- 需要把目录运维放进统一的连接、护栏、审计与 AI 自动化边界内：DBX LDAP
  与 DBX 工作台、secret binding 和 MCP 桥是一体的，适合已经在使用 DBX
  或希望收窄写权限的场景。

## 相关链接

- [产品宣传页](MEDIA.zh-CN.md) · [README](../README.md)
- [MCP 使用指南](MCP_USAGE.zh-CN.md)
