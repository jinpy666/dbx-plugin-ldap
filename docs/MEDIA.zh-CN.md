# DBX LDAP 产品宣传页

DBX LDAP（插件 id `io.dbx.ldap`）是 DBX 的 LDAP 目录工作台。本文页面向潜在
用户介绍产品定位与亮点；全部能力描述以仓库内实施文档与 smoke 验证为准，
不包含未实现功能的宣传。

## 产品定位

面向运维、IT 管理和内部工具团队的 LDAP 目录工作台：连接一次企业目录
（Active Directory、OpenLDAP、389DS 等），即可完成浏览、搜索、条目维护、
Schema 检查和数据导出；所有写操作都在 Base DN 白名单、屏蔽属性和审计
护栏之内，并可通过 MCP 工具面交由 AI 客户端安全复用。

## 三句卖点

1. 一个面板看全目录：DN 树、分页搜索、RFC 4515 过滤器和搜索预设，定位
   用户、组、OU 和服务账号不需要切换工具。
2. 改得放心：只读模式、写入 Base DN 白名单、屏蔽属性和审计记录四道护栏；
   删除与改名强制两阶段确认。
3. 目录会对接入方友好：八种认证方式、三种传输模式加 MCP 自动化，既有
   交互工作台，也有给 AI 客户端的结构化工具面。

## 亮点特性

### 一站式目录浏览与搜索

- DN 树按层级浏览，搜索结果分页展示，支持 RFC 4515 过滤器与属性投影。
- 搜索条件可保存为预设，常用查询一键复用。
- 结果支持 LDIF 和 CSV 导出，满足审计与交付场景。

### 企业级认证矩阵与传输安全

- 认证方式：anonymous、unauthenticated、simple、Kerberos/GSSAPI、NTLM、
  NTLM 哈希、DIGEST-MD5、SASL External。
- 传输：LDAP、StartTLS、LDAPS；可配置证书校验、CA 路径与服务器名称。
- 凭据由 DBX 宿主 secret binding 管理，插件不持久化、不落日志。

### 受护栏条编辑

- 查看、新增、编辑、重命名、删除目录条目。
- 只读连接上写入口直接不可用；允许写入的 Base DN 白名单约束可写范围；
  屏蔽属性防止误改敏感字段。
- 所有写路径留审计记录；MCP 写路径同样落审计。

### Schema 与目录能力检查

- RootDSE 能力视图、Schema 的 attributeType / objectClass 检查与属性元数据。
- 为数据导入、应用对接前的目录结构核查提供依据。

### MCP 自动化

- 8 个 MCP 工具：读路径 `ldap_search_digest`（本地聚合 + cursor 翻页，
  扫描数据不出 sidecar）、`ldap_cursor_next`；写路径 `ldap_entry_write`
  （删除/改名两阶段确认）；`ldap_ui_schema` 与 4 个工作台联动工具。
- 可经 DBX MCP 桥复用已保存连接与护栏，也可独立 stdio 模式运行。

### 七语界面

简体中文、繁体中文、英语、西班牙语、意大利语、日语、葡萄牙语。

## 典型工作流

### 服务账号盘点

1. 选择目标连接，按 OU 浏览 DN 树或用过滤器
   `(objectClass=account)`（或组织自定义类）定位服务账号。
2. 用聚合读（digest）统计分布，确认账号归属与命名规范。
3. 导出 CSV 交付盘点结果。

### 受控条目维护

1. 连接配置为只读或限定写入 Base DN 范围，从源头收窄风险。
2. 在工作台内编辑条目属性；屏蔽属性列表挡住敏感字段。
3. 删除或重命名时经过两阶段确认，操作留审计记录。

### AI 辅助目录运维

1. 经 DBX MCP 桥把插件工具面暴露给 AI 客户端，复用已保存连接与护栏。
2. AI 用 `ldap_search_digest` 做统计与定位，用 cursor 翻页读取大结果。
3. 涉及删除/改名的写操作强制预览 + 确认令牌，参数被改动即作废。

## 使用边界

- DBX LDAP 是目录客户端，不提供目录服务器功能（不含内置 OpenLDAP/AD）。
- Kerberos/GSSAPI 依赖运行环境中的凭据（如 keytab/票据），插件不代替配置
  Kerberos 环境。
- 批量数据交付以 LDIF/CSV 导出为主，不做批量导入编排。
- 独立 stdio 模式下工作台联动工具（`ldap_ui_*`）不可用，会返回明确的
  UNAVAILABLE 提示而非挂起。

## FAQ

**支持哪些目录服务器？**
任何兼容 LDAP v3 的服务器（Active Directory、OpenLDAP、389DS 等）均可；
认证与传输能力按连接配置选择。

**修改条目会不会误删整棵子树？**
删除（含递归）与改名强制两阶段确认：先返回预览与确认令牌，第二次带令牌
且参数一致才执行；递归删除沿用子树条数上限。加上只读模式与写入白名单，
风险从源头被限制。

**凭据存在哪里？**
绑定密码、Kerberos 凭据等敏感值由 DBX 宿主 secret binding 管理，插件不
持久化；MCP 调用参数中也不会出现密码。

**大目录搜索会拖垮响应吗？**
MCP 读路径默认返回聚合摘要（计数、分布、样本行），明细经 cursor 翻页；
扫描与物化都有可调上限，单响应也有大小上限。

**如何安装？**
从 [GitHub Releases](https://github.com/jinpy666/dbx-plugin-ldap/releases)
下载与平台匹配的 `.dbxp` 包，在 DBX 插件中心安装；sidecar 随包分发。

## 相关链接

- [README](../README.md) · [README (English)](../README.en.md)
- [特性与竞品对比](COMPARISON.zh-CN.md)
- [MCP 使用指南](MCP_USAGE.zh-CN.md)
