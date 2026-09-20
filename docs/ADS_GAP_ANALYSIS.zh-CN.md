# LDAP 插件 vs Apache Directory Studio（ADS）差距分析

> 对标基准：Apache Directory Studio 2.x（Connection Wizard / LDAP Browser /
> Schema Browser / Search / Import-Export / Batch Operations）。
> 状态标记：✅ 已有 ｜ 🔶 部分（有差距）｜ ❌ 缺失。
> 优先级：P0 = 下一轮就做；P1 = 近期；P2 = 远期/按需。
> 质量加固（2026-09-18）：架构/性能/隐藏缺陷三路审计 18 项修复 + 容器级扩展操作
> smoke 6/6，见 UI_SCAN_FINDINGS 第 2 轮章节与 ADS_FEATURE_MATRIX。
> 本文件是 **ADS 侧**追赶路线唯一对账表（PLA 对标见
> `PLA_GAP_ANALYSIS.zh-CN.md`，两表并轨同一 M5/M6/M7 框架，M6 扩容以
> IMPL_PLAN §9 更新后的表述为准）；落地一项更新一项（状态 + 落地记录链接）。

## 1. 连接方式与网络

| 能力 | ADS | 本插件 | 状态 | 计划 |
| --- | --- | --- | --- | --- |
| 明文 LDAP (ldap://) | ✅ | ✅ tls_mode=none | ✅ | — |
| LDAPS (ldaps://) | ✅ | ✅ tls_mode=ldaps（后端 ldaps/StartTLS 已绿 smoke） | ✅ | — |
| StartTLS | ✅ | ✅ tls_mode=starttls | ✅ | — |
| LDAPI (Unix socket) | ❌（ADS 无） | ✅ ldapi://（smoke_ldapi_test） | ✅ | 超越项，保持 |
| 连接测试（只测网络连通） | ✅ Check Network Parameter | ✅ `ldap/check`（network 全新短拨号测延迟 ∥ bind 会话探活两级，无副作用）+ 连接面板每行检查（本轮） | ✅ | — |
| 网络超时/读超时 | ✅ | ✅ timeout_secs（读/操作档，缺省 30）+ dial_timeout_secs（拨号档，0 = 回落读档；本轮） | ✅ | — |
| 引用（referral）跟随策略 | ✅ follow/ignore/manage | ✅ manage/report 形态：搜索（含分页会话）透出延续引用 URI（封顶 20，`ldap/search`/`ldap/search/start` 的 `referrals` 字段），结果表提示条展示；结果码 10 错误带 `[ldap-referral=..]` 前缀与友好文案（✅ 本轮）| ✅（manage） | follow 需向引用目标主机转发凭据，与 DN 白名单安全策略冲突，维持不自动追随；如需再按需设计策略 |
| 别名处理（browse/search 解引用） | ✅ 分开设置 | ✅ 搜索有 derefAliases；浏览树工具栏解引用下拉（子节点列举请求 derefAliases 透传，缺省 never 零配置无行为变化；DN Picker 弹层按设计沿用 never——DN 查找辅助无需解引用，不与树状态跨层耦合）（本轮） | ✅ | — |

## 2. 加密与证书

| 能力 | ADS | 本插件 | 状态 | 计划 |
| --- | --- | --- | --- | --- |
| 证书校验开关 | ✅（truststore / 自定义 CA / 不校验） | ✅ tls_verify + tls_ca_path | ✅ | — |
| 自定义 CA 证书 | ✅ | ✅ tls_ca_path | ✅ | — |
| SNI/服务器名覆盖 | 🔶（跟随 URL） | ✅ tls_server_name | ✅ | — |
| 客户端证书（mTLS） | ✅ | ✅ tls_client_cert_path + tls_client_key_path（PEM 路径，starttls/ldaps 联动显隐；本轮） | ✅ | — |
| 加密关闭时隐藏证书设置 | ✅ | 🔶 本轮补：manifest tls_* 字段随 tls_mode 联动显隐 | ✅（本轮） | — |

## 3. 认证

| 能力 | ADS | 本插件 | 状态 | 计划 |
| --- | --- | --- | --- | --- |
| Anonymous / Simple | ✅ | ✅ | ✅ | — |
| Unauthenticated bind | 🔶（ADS 无独立项） | ✅ | ✅ | — |
| Kerberos/GSSAPI（纯 Go） | ✅（原生 KRB） | ✅ password/keytab/ccache、realm、KDC host/port、krb5.conf（smoke_auth 矩阵） | ✅ | — |
| Kerberos 原生票据缓存/kinit | ✅ | ✅ ccache 凭据类型 | ✅ | — |
| DIGEST-MD5（realm/QoP/authzid） | ✅ | ✅ sasl_host 覆盖 + authzId；realm 由服务端 challenge 驱动（RFC 2831 正确行为，go-ldap 硬编码回填 challenge realm、无客户端多 realm 选择钩子，fork 依赖库才可改——客户端 realm 覆盖仅对多 realm 服务器有意义，不做并留决策记录；终判 2026-09-21） | ✅（RFC 对齐） | — |
| NTLM / NTLM hash | 🔶（ADS 经 SASL NTLM） | ✅ | ✅ | — |
| SASL EXTERNAL | ✅ | ✅ | ✅ | — |
| CRAM-MD5 | ✅ | ❌ 不做（决策记录 2026-09-21：go-ldap v3.4.13 无 CRAM-MD5 实现且 SASL 消息层全私有、无公开扩展点，实现需 fork 依赖库 ~120 行 + 长期维护分叉；机制本身属 RFC 2195 时代遗产，现代等价能力 = simple + TLS，本插件已具备；如未来出现真实需求再评估 fork） | ❌（决策关闭） | — |
| SASL QoP（auth/auth-int/auth-conf） | ✅ | ✅ sasl_qop（kerberos） | ✅ | — |
| GSSAPI mutual auth | ✅ | ✅ sasl_mutual_auth | ✅ | — |
| 授权身份（authzid / proxy） | ✅ | ✅ authzId 字段（后端） | ✅ | — |

## 4. 连接设置排版

| 能力 | ADS | 本插件 | 状态 | 计划 |
| --- | --- | --- | --- | --- |
| 分区/tab：Network → Authentication → Advanced | ✅ 四个 tab | 🔶 宿主表单单页平铺（字段顺序由 manifest 决定） | 🔶 | 本轮：字段重排（名称→网络→加密→证书→BaseDN→认证→Kerberos/SASL→高级→安全策略）+ TLS 字段联动显隐 |
| 字段二级联动 | ✅ | ✅ visible_when/required_when（auth_type、krb_credential_type、tls_mode） | ✅ | — |
| 连接颜色/分组 | ✅（folder） | 🔶 宿主侧连接能力 | 🔶 | 随宿主 |

## 5. 搜索与条件构建

| 能力 | ADS | 本插件 | 状态 | 计划 |
| --- | --- | --- | --- | --- |
| 可视化条件构建器（AND/OR 嵌套） | ✅ Filter Editor | ✅ FilterGroup 树 ≤2 层 + 实时预览串 | ✅ | — |
| NOT 组 / NOT 条件 | ✅ | ✅ `(!(attr=value))` 解析回填为 ≠ 运算符；构建器条件行与组头均暴露 NOT 开关（≠ 与 NOT 互斥归一，组级双重否定结构化保留、往返不丢失；七语 i18n） | ✅ | — |
| 运算符集 | ✅ =/≠/≥/≤/≈/presence/子串 | ✅ equals/**notEquals（本轮）**/contains/startsWith/endsWith/present/gte/lte/approx | ✅ | — |
| 源码模式 + 双向解析 | ✅ | ✅ RFC4515 直编 + best-effort 解析回构建器 | ✅ | — |
| 值转义（RFC 4515） | ✅ | ✅ \5c/\2a/\28/\29/\00 + UTF-8 hex 串解码 | ✅ | — |
| schema 驱动属性下拉 | ✅ | ✅ datalist（schema 缓存 30min + 常用集兜底） | ✅ | — |
| 保存的搜索（Saved Searches） | ✅ 文件夹管理 | ✅ 预设（结构化条件 + 过滤器串，sidecar 持久化） | ✅ | P2：预设分组/排序 |
| 搜索历史 | ✅ | ✅ 本地最近 10 条（成功才入队、去重、localStorage 持久化，下拉应用不自动运行；本轮） | ✅ | — |
| 分页搜索（Paged Results 控件） | ✅ | ✅ pageSize | ✅ | — |
| 服务器端排序控件（RFC 2891） | ✅ | ✅ 搜索表单高级区排序属性 + 方向（sortBy/sortOrder），后端注入 RFC 2891 排序控件（非分页/分页/会话链路每页携带，与 RFC 2696 cookie 共存）；服务器未按请求排序时优雅降级（sortResult 状态码透出 + 一次性提示，结果照常返回；go-ldap v3.4.13 解码器缺陷致非零码暂多透出为 0，见 backend/internal/ldapconn/sort.go 注释）（本轮） | ✅ | — |
| 搜索范围 base/one/sub | ✅ | ✅ | ✅ | — |
| 结果批量操作（删除/移动） | ✅ Batch Operations Wizard | ✅ 多选批量删除（确认 + 逐条非递归）+ 批量移动（保留 RDN、目标父 DN 校验；失败计数明示）（本轮收齐） | ✅ | — |

## 6. 目录浏览与条目编辑

| 能力 | ADS | 本插件 | 状态 | 计划 |
| --- | --- | --- | --- | --- |
| DN 树浏览 + 懒加载 | ✅ | ✅ 虚拟列表 + 计数徽章 | ✅ | — |
| 树关键字过滤 | ✅ | ✅（远程子树过滤） | ✅ | — |
| 条目查看/编辑（表单） | ✅ | ✅ 属性增删改 + 多值行 | ✅ | — |
| LDIF 视图（直接编辑生效） | ✅ | ✅ LDIF 页签可写态直接编辑：切页签 leaveLdif 守卫解析回表单、保存时 syncRowsFromLdif 落为 modify changes（对账销账，代码已在库） | ✅ | — |
| 新条目向导（objectClass 模板） | ✅ | ✅ 模板向导 + schema must 铺开（M6-N4） | ✅ | JSON 自定义模板引擎不做 |
| objectClass 专用编辑器（chips + 类选择器） | ✅ ObjectClass Editor | ✅ chips 行编辑 + 选择器（搜索/MUST 预览/已选禁重复）+ 保存前变更预览 + OID 格式校验（本轮） | ✅ | — |
| 二进制属性（图片/hex/base64 查看器） | ✅ | ✅ 预览/hex/PEM 三视图 + 上传（M6-N3） | ✅ | — |
| 密码修改扩展操作（passwd） | ✅ | ❌（走 modify userPassword，前端哈希辅助已落地 M6-N2） | 🔶 | P2：RFC 3062 extend |
| 条目复制/粘贴、书签 | ✅ | ❌ | ❌ | P2 |
| 子树删除（递归 + 子条目计数确认） | ✅ | ✅ 递归删除（Tree Delete 控件 + 回退）+ childrenCount 确认（M6-N1，收编自 PLA 对账表） | ✅ | — |
| DN 重命名/移动子树 | ✅ | ✅ modifyDn | ✅ | — |

## 7. 导入 / 导出

| 能力 | ADS | 本插件 | 状态 | 计划 |
| --- | --- | --- | --- | --- |
| LDIF 导出（条目/子树/结果） | ✅ | ✅（结果 + 子树） | ✅ | — |
| CSV/JSON 导出 | ✅（CSV/XLSX） | ✅（CSV/JSON） | ✅ | — |
| LDIF 导入 | ✅ | ❌ | ❌ | P0/P1：前端 LDIF 解析 → 逐条 entry/add（含 changetype 拒绝策略） |
| DSML 导入导出 | ✅ | ❌ | ❌ | P2（不做，按需） |

## 8. Schema / RootDSE

| 能力 | ADS | 本插件 | 状态 | 计划 |
| --- | --- | --- | --- | --- |
| Schema 浏览（属性/objectClass 列表） | ✅ | ✅ SchemaPanel 双列 | ✅ | — |
| objectClass must/may 明细 | ✅ | ✅（schemaCache 元数据） | ✅ | — |
| 属性语法/相等匹配规则明细 | ✅ | ❌（仅名称/描述） | 🔶 | P2：schema 原始定义透出 |
| RootDSE 查看 | ✅ | ✅ | ✅ | — |

## 9. 安全策略 / 审计（超越 ADS 的部分）

| 能力 | ADS | 本插件 | 状态 |
| --- | --- | --- | --- |
| DN 白名单（读/写分离） | ❌ | ✅ | ✅ 超越 |
| 屏蔽属性（读过滤 + 写拒绝） | ❌ | ✅ | ✅ 超越 |
| 只读门禁 | 🔶 | ✅（表单 ∥ 宿主双层） | ✅ |
| 写操作审计（事件 + jsonl 落盘） | 🔶（change logs） | ✅ audit feed 面板 | ✅ |

## 10. UI 体验

| 能力 | ADS（SWT 富客户端） | 本插件 | 状态 | 计划 |
| --- | --- | --- | --- | --- |
| 主题跟随宿主（亮/暗 + 令牌） | ❌（Eclipse 主题） | ✅ 宿主 1.1 theme 通道 | ✅ | — |
| 七语 i18n | ✅ 多语 | ✅ 七语（en/es/it/ja/pt-BR/zh-CN/zh-TW） | ✅ | — |
| 键盘操作（↑/↓/Enter 打开条目） | ✅ | ✅ | ✅ | — |
| 列宽持久化 | ✅ | ✅ | ✅ | — |
| 紧凑搜索条（高级区折叠 + 记忆） | ✅ Quick Search | ❌ 表单常驻展开 | ✅（本轮：折叠快捷条 ⇄ 展开完整表单双形态，localStorage 记忆，MCP focus intent 自动展开） | — |
| 连接标识（协议/认证徽章、最近条目） | ✅ 连接属性页 | 🔶 仅方言徽章 | ✅（本轮：协议·认证徽章 + 最近打开条目下拉） | — |
| UI 自动化测试 | ❌（手工/ SWTbots） | 🔶 vitest 单测 + mock 走查；本轮补组件测试 + 浏览器走查脚本（scripts/ui_test.mjs，入 test.sh） | ✅（本轮） | 持续：关键流 e2e（shared/host-e2e） |

## 11. 追赶路线（并入 IMPL_PLAN M5/M6/M7）

- **M5-a（本轮）**：TLS 字段联动显隐 + 连接字段排版重排；≠ 运算符；
  UI 测试双轨（组件测试 + ui_test.mjs 走查脚本）。
- **M5-b**：~~NOT 组 UI~~（✅ 已落地：构建器条件行 + 组头 NOT 开关）；~~referral 策略~~
  （✅ manage/report 形态落地：搜索/会话透出 referrals + 结果码 10 结构化；follow 不做——
  与 DN 白名单安全策略冲突，见 §1）；连接检查 `ldap/check`（network/bind 分级）；
  搜索历史；LDIF 编辑生效。
- **M6（扩容后，与 PLA 对账表 N1–N4 并轨）**：LDIF 导入；结果批量操作；
  新条目 objectClass 模板（N4）；二进制属性查看器 + 上传（N3）；
  子树删除（N1）；密码哈希辅助（N2）。任务分解见 PLA 对账表 §7（L6-x）。
- **M7（按需）**：~~mTLS 客户端证书~~（✅ 落地，见 §2）；~~dial/read 两档超时~~（✅ 落地，
  见 §1）；~~CRAM-MD5~~（❌ 决策关闭，见 §3：库不支持 + 机制过时）；~~referral 策略~~
  （manage/report 落地，follow 不做——与 DN 白名单安全策略冲突，见 §1）；~~服务器端排序~~
  （RFC 2891 落地，见 §5）；~~digest realm~~（服务端 challenge 驱动即 RFC 正确行为，
  见 §3）；DSML（维持按需不做）。**追赶路线全部闭环。**
