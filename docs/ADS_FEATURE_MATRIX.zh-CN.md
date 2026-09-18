# ADS → DBX Feature Gap Matrix（工程排期版）

> **落地状态（2026-09-18 第三次更新）**：**F1–F12 全部落地，矩阵 100% 完成**
>（F9 条目多开页签以最小形态实现：弹窗内页签条 + ＋从目录选择 + 脏态否决
> 切换 + 工作集随删除/移动/连接切换维护；e2e 覆盖于 ui_test）。两轮质量加固
> （架构/性能/隐藏缺陷三路审计 + 18 项修复 + 8 项视觉/UX 优化）详见
> UI_SCAN_FINDINGS 第 2 轮章节。原备注：F3 的
> Compare/WhoAmI/PasswdModify 已通过**真实 OpenLDAP 容器 smoke 6/6**（含 read_only
> 拒绝与审计无密码泄漏断言，接入 test.sh）。两轮质量加固（架构/性能/隐藏缺陷
> 三路审计 + 18 项修复 + 8 项视觉/UX 优化）详见 UI_SCAN_FINDINGS 第 2 轮章节。
> F9（工作台页签）与 F12（RootDSE 增强）按既定条件继续挂起。
>
> 来源：ChatGPT 对话「梳理LDAP功能缺口」全文（32 节）+ 2026-09-17/18 对本仓库
> 与 ADS 2.x 源码树的逐文件核验。定位：`ADS_GAP_ANALYSIS` 是功能级对账表，
> `ADS_ARCH_MAPPING` 是架构级映射，**本文件是排 Sprint 用的工程分解**——每行
> 精确到 ADS 参照路径 / DBX 现状文件 / 要新增的文件 / 要修改的方法 / API /
> UI / 验收标准 / Issue 标题。
> 所有 DBX 函数名均已核实存在；行末「对账」列标注与两份既有文档的对应关系。

## 0. ChatGPT 判断 vs 仓库实况（先修正再排期）

ChatGPT 方案按通用 Java 分层推演，与「Go sidecar + 宿主驱动 + Vue 工作台」的
实情有偏差。逐项核验结论如下，**采纳/改形/否决**以本表为准：

| ChatGPT 判断 | 实况核验 | 结论 |
| --- | --- | --- |
| Connection 缺 `connection/create\|update\|delete` API（§二） | 连接生命周期**由宿主驱动**（`connection/test\|connect\|disconnect`，IMPL_PLAN §7 明文约定），插件不建连接 CRUD | ❌ 否决（设计如此，不是缺口） |
| P0：Workbench/EditorManager/EditorInput（§二十四 EPIC-01） | 宿主桥只有 `invoke`（mockDbxHost.ts:395），无编辑器管理 API；弹窗即编辑器是既有决策 | 🔶 改形：降为 F9 工作台页签（P2 可选），不建 Eclipse 式工作台 |
| P0：Entry Editor 需 5 层重构（§八） | `ldapDiff.ts diffChanges()` 即 ChangeSet；编辑器行模型 + dirty 守卫 + 变更预览即 WorkingCopy；`entryValidation.ts missingRequiredAttributes()` 即 MUST 校验 | 🔶 大部分已存在；余量拆入 F2a（kind 级轻校验）与 F5（同步） |
| P1：ValueEditorRegistry 框架（§十） | `lib/valueKinds.ts` **已实现**：12 种 kind、名字绑定+语法 OID 绑定+后缀规则、解析顺序对齐 ADS `plugin.xml` 绑定模型（含 AD FILETIME 特例） | ✅ 已完成，关闭（新编辑器按表扩行即可） |
| Schema Browser 是最大缺口 🔴（§十五–十七） | `backend/internal/ldapconn/schema.go:405` `SubschemaAttrs` 只拉 `attributeTypes`+`objectClasses`；无 matchingRules/matchingRuleUses/ldapSyntaxes。但 `LDAPSchemaAttributeType` 已带 Syntax/Equality/SingleValue/NoUserModification | 🔶 拆两半：明细页纯前端可做（F2a）；新分类要后端（F2b） |
| Import 缺失 🔴（§十九） | `lib/ldif.ts parseLdif()` 已能解析（含 `LdifParseError` 定位）；缺的是导入流水线（预览/冲突/策略/批执行），不是 parser | ✅ 成立（F1，parser 已省一半工作量） |
| LDAP Error 应集中化（§二十三） | `lib/ldapErrors.ts` 已有 13 组 regex 映射；缺 68（alreadyExists）、无结构化字段（resultCode/matchedDn/referral） | ✅ 成立（F4，regex 版是底子） |
| Bookmark / Advanced Ops 缺失 🔴 | 核实无对应物（operations.go 无 Compare/WhoAmI/PasswdModify；无书签） | ✅ 成立（F3 / F7） |
| Search 需持久对象模型（§十一–十二） | `LDAPSearchPreset`（结构化条件 + sidecar 持久化）+ 历史已在；缺分组/命名/复制 | 🔶 部分成立（F11，P2） |
| 建目录树 `connection/model/LdapConnection.java` 等（§二、§二十四） | 仓库是 Go + Vue，无 Java；对应物已存在（`internal/ldapconn/`、`frontend/src/lib/`） | ❌ 否决（按本文件实际路径落地） |
| 「每个 Browser Node 一个 Action Group」（§四） | DnTree 已有右键菜单（select/searchHere/view/members/add/copyEntry/rename/remove/export/copyDn 十项）；缺的是 Properties/Bookmark 两项 | 🔶 大部分已存在（余量入 F7/F8） |

排期总原则：**ChatGPT 的 P0 五项中，真正成立的只有 Schema（拆分后降半级）和
Import；Entry/Workbench/ValueEditor 三项按实况关闭或降级。**资源优先给
F1/F2a，其次 F3–F6。

---

## 1. 矩阵（P0）

### F1 · LDIF 文件批量导入
- **Issue**: `feat(import): LDIF 文件批量导入（预览 + changetype 策略 + 失败清单）`
- **ADS 参照**: `ldapbrowser.ui/.../wizards/ImportLdifWizard.java`、`ImportLdifMainWizardPage.java`；`ldapbrowser.core/.../jobs/ImportLdifRunnable.java`、`ExecuteLdifRunnable.java`
- **DBX 现状**: `frontend/src/lib/ldif.ts` `parseLdif()`/`LdifParseError`（解析就绪）；`frontend/src/components/ImportEntryDialog.vue` 仅单条目 add；后端 `ldap/entry/add` 就绪
- **新增**: `frontend/src/lib/ldifImport.ts`（解析 → 导入计划 → 预览行模型，纯函数 + 单测）
- **修改**: `ImportEntryDialog.vue`（文件/粘贴双入口、批量模式、changetype 策略开关：默认拒绝并逐行标红）；`App.vue`（入口与进度/结果透传）
- **API**: 无新增方法（逐条复用 `ldap/entry/add`；`read_only`、DN 白名单、屏蔽属性、审计天然生效）
- **验收**: 1000 条 LDIF 可预览/可取消/失败清单可复制导出；含 changetype 的条目默认拒绝且提示；只读门禁拦截；审计入 feed；本地容器 smoke
- **对账**: GAP §7 P0/P1 ｜ ChatGPT §19 ✓成立

### F2a · Schema 明细页 + kind 级轻校验
- **Issue**: `feat(schema): attributeType/objectClass 明细栏 + 值 kind 轻校验`
- **ADS 参照**: `editors/schemabrowser/AttributeTypeDescriptionDetailsPage.java`、`ObjectClassDescriptionDetailsPage.java`
- **DBX 现状**: 数据已端到端可用——后端 `LDAPSchemaAttributeType.Syntax/Equality/SingleValue/NoUserModification`（types.go:253）、前端 `schemaCache.ts` raw 正则解析（:102-113）、`valueKinds.ts` 12 kind；`SchemaPanel.vue` 只有双列列表
- **新增**: `SchemaPanel.vue` 第三栏明细（选中项 → 语法 OID/equality/singleValue/SUP 链/MUST/MAY/被哪些 objectClass 引用——反向引用由既有 `ObjectClassAttributes` 前端算出）；`entryValidation.ts` 增 `validateValueKind(kind, value)`（integer/boolean/datetime/dn 的轻校验，复用 `lib/dn.ts`/`generalizedTime.ts`）
- **修改**: `EntryEditorDialog.vue` 保存前调用轻校验（WARNING 级提示，不阻断——服务器才是权威）
- **API**: 无新增
- **验收**: 选中 `inetOrgPerson` 显示 SUP/MUST/MAY 与引用方；integer 列填 `abc` 保存前有黄色提示；语法校验不误报 AD FILETIME 等 kind 特例
- **对账**: GAP §8 P2 前半 ｜ ChatGPT §八 Validator 层、§十七 validateEntry 的可行子集

---

## 2. 矩阵（P1）

### F2b · Schema 分类扩展（matchingRules / matchingRuleUses / ldapSyntaxes）
- **Issue**: `feat(schema): 拉取并浏览 matchingRules/matchingRuleUses/ldapSyntaxes`
- **ADS 参照**: `MatchingRuleDescriptionDetailsPage.java`、`MatchingRuleUseDescriptionDetailsPage.java`、`LdapSyntaxDescriptionDetailsPage.java`；core `model/schema/Schema.java`
- **DBX 现状**: `schema.go:405` `SubschemaAttrs: []string{"attributeTypes", "objectClasses"}` 写死两类
- **新增**: `schema.go` 三个解析函数（对齐既有 `parseLDAPAttributeTypes` 形态）+ `LDAPSchemaMatchingRule` 等类型；`api.ts` `SchemaResult` 扩展；`schemaCache.ts` `deriveSchemaMetadata` 扩签名 + 接口增 `matchingRules/matchingRuleUses/ldapSyntaxes`
- **修改**: `SchemaPanel.vue` 增分类页签（沿用双列 + 明细）；屏蔽属性过滤逻辑同步覆盖新分类
- **API**: 无新方法（`ldap/schema` 返回体扩展，向后兼容——新增字段可选）
- **验收**: OpenLDAP 容器三分类非空；matchingRuleUse 明细显示关联属性；大 schema（AD 量级）不拖慢首开（沿用 30min 缓存）
- **对账**: GAP §8 P2 后半 ｜ ChatGPT §十六 ✓成立

### F3 · 高级扩展操作：Compare / WhoAmI / PasswdModify（RFC 3062）
- **Issue**: `feat(ops): Compare + WhoAmI + 密码修改扩展操作`
- **ADS 参照**: `actions/PasswordModifyExtendedOperationAction.java`、`dialogs/PasswordModifyExtendedOperationDialog.java`；`ldapbrowser.core/.../jobs/ExtendedOperationRunnable.java`
- **DBX 现状**: `operations.go` 方法清单无对应（grep 核实）；密码走 `ldap/entry/modify`（`PasswordAttributeEditor.vue` 哈希辅助）
- **新增**: `operations.go` `CompareEntry`/`WhoAmI`/`PasswordModify`（go-ldap `Compare`/`WhoAmI`/`PasswordModify` 扩展）；`main.go` 注册 `ldap/entry/compare`、`ldap/whoami`、`ldap/entry/passwdModify`；`api.ts` 对应三个调用
- **修改**: `PasswordAttributeEditor.vue` 增「扩展操作修改」入口（identity/old/new）；`DnTree.vue`/`ResultTable.vue` 右键 Compare（选属性+值 → 结果 toast）
- **API**: 三个新方法（写路径 `passwdModify` 受 `read_only`/白名单约束并入审计）
- **验收**: 容器 smoke 三操作；`read_only=1` 时 passwdModify 拒绝；审计记录含 target DN
- **对账**: GAP §6 P2 ｜ ChatGPT §三十 ✓成立

### F4 · LDAP 错误结构化
- **Issue**: `feat(errors): 结构化 LDAP resultCode/matchedDn 透传 + 补 68 映射`
- **ADS 参照**: `connection.ui/ExceptionHandler.java`、`BrowserCoreMessages`（错误→可读文案的集中映射）
- **DBX 现状**: `lib/ldapErrors.ts` `RULES` 13 组 regex（有 49/32/34/20/19/21/4/11/53/8/200/network/timeout，**缺 68 alreadyExists**）；后端错误仅 message 字符串
- **新增**: 后端错误响应 `data` 携带 `{ resultCode?: number, matchedDn?: string }`（go-ldap `Error.ResultCode/MatchedDN` 提取）；`ldapErrors.ts` 改 code-first、regex 兜底，补 68 + `err.entryExists` 七语
- **修改**: `main.go`/`internal/ldapconn` 错误包装统一走一个 helper；`api.ts` `callLdap` 透传 data；错误横幅/弹窗展示 DN + 原文 title
- **API**: 无新方法（错误信封扩展）
- **验收**: 重复添加同 DN 条目 → 本地化「条目已存在」；noSuchObject 时展示 matchedDn；既有 13 类映射行为不回退（ldapErrors.spec 全绿 + 新增用例）
- **对账**: 新项 ｜ ChatGPT §二十三 ✓成立

### F5 · 写后同步：事件总线最小形态
- **Issue**: `refactor(events): entryEvents 总线统一写后失效/刷新`
- **ADS 参照**: `ldapbrowser.core/.../events/EventRegistry.java`、`EntryUpdateListener.java`（EntryAdded/Deleted/Moved/Renamed…）
- **DBX 现状**: `App.vue` `invalidateEntryCache(dn, descendants)` 手工调用分散在保存/删除/移动/重命名各分支；树刷新各处手工 `refreshTree`
- **新增**: `frontend/src/lib/entryEvents.ts`（`emitEntryChanged/Deleted/Moved` + 订阅；键 = connectionId + 归一化 DN，纯 TS + 单测）
- **修改**: `App.vue` 各写操作成功回调改发事件，单一订阅点统一做 `invalidateEntryCache` + 树/结果表局部刷新；`DnTree.vue` 暴露 `refreshNode(dn)` 替代整树重载
- **API**: 无新增
- **验收**: 改属性后树徽标与编辑器缓存一致；删除子树后祖先徽标更新；事件单测覆盖 moved 级联失效
- **对账**: ARCH_MAPPING §9-7 ｜ ChatGPT §三十一业务链「Operation 后同步」

### F6 · 批量 modify
- **Issue**: `feat(batch): 结果多选批量属性修改（add/replace/delete 值）`
- **ADS 参照**: `wizards/BatchOperationWizard.java`、`BatchOperationModifyWizardPage.java`；core `BulkModificationEvent`
- **DBX 现状**: `ResultTable.vue` 批量删除/移动（`onBatchDelete`/`onBatchMove`，失败计数模式可复用）
- **新增**: `frontend/src/components/BatchModifyDialog.vue`（属性名 + 值 + 操作三选一 + 目标数确认）
- **修改**: `ResultTable.vue` 工具栏入口；`App.vue` 执行循环（逐条 `ldap/entry/modify`，沿用批量移动的失败计数与审计写法）
- **API**: 无新增
- **验收**: 100 条批量加 `departmentNumber` 成功/失败清单准确；屏蔽属性被拒；只读拦截；容器 smoke
- **对账**: GAP §5 尾行延伸 ｜ ChatGPT §二十四 P1 ✓成立

---

## 3. 矩阵（P2）

### F7 · 书签
- **Issue**: `feat(bookmark): DN 书签（持久化 + 跳转 + 管理）`
- **ADS 参照**: `ldapbrowser.core/BookmarkManager.java`、`wizards/NewBookmarkWizard.java`、`views/browser/ShowBookmarksAction.java`
- **DBX 现状**: 无；持久化底座可抄预设（`internal/ldapconn` ListPresets/SavePreset/RemovePreset + `store.Prefs`）
- **新增**: 后端 `ldap/bookmarks/list|save|remove`（镜像 presets 三方法）；`lib/bookmarks.ts`
- **修改**: `DnTree.vue` 右键增「添加书签」；`App.vue` 工具栏书签下拉（跳转 = 逐级展开定位，依赖 F8 的树路径展开）
- **验收**: 增删跳转 + 七语 + 按连接隔离
- **对账**: GAP §6 P2 ｜ ChatGPT §二十 ✓成立

### F8 · 复制与导航工具集齐
- **Issue**: `feat(nav): CopyValue(Base64/hex) + CopyURL + GotoDn 树内定位`
- **ADS 参照**: `actions/CopyValueAction.java`、`CopyUrlAction.java`、`GotoDnAction.java`、`LocateDnInDitAction.java`
- **DBX 现状**: `copyDn`/`prepareCopyEntry` 已有；`DnPickerDialog.vue` 只选不跳
- **新增**: `DnTree.vue` `revealDn(dn)`（逐级展开 + 高亮）；值行右键复制 Base64/hex（复用 `lib/binaryValue.ts`）
- **修改**: `EntryEditorDialog.vue` 值菜单；`App.vue` 工具栏 GotoDn 入口
- **验收**: 走查脚本（scripts/ui_test.mjs）补三条断言
- **对账**: ARCH_MAPPING §9-6 ｜ ChatGPT §十四 Locate in DIT ✓

### F9 · 工作台页签（可选，替代 ChatGPT EPIC-01）
- **Issue**: `feat(workbench): 条目多开页签（内存态）`
- **ADS 参照**: `editors/entry/MultiTabEntryEditor.java`、`EntryEditorNavigationLocation.java`
- **DBX 现状**: 单弹窗 + relation 双栏；宿主无编辑器 API；`entryDetailCache` 已按 connection+DN 键控
- **新增**: `App.vue` 页签条状态（打开条目数组 + 激活项，内存态，不做 URI 路由——recent entries 已有持久化）
- **验收**: 三个条目并行编辑互不污染、dirty 页签有标记、关闭有守卫
- **对账**: ARCH_MAPPING §10「多开不做」的**有条件放开**：若 relation 视图不够用再做

### F10 · 操作历史结构化
- **Issue**: `feat(audit): 审计记录增 operation/durationMs/result 字段`
- **ADS 参照**: `views/modificationlogs/ModificationLogsView.java`
- **DBX 现状**: `store.Audit` jsonl + `AuditFeedPanel.vue` + `lib/auditFeed.ts parseAuditEvent`；`subtreeDeleteAuditRecord`（operations.go:540）已是结构化范例
- **修改**: `operations.go` 各写路径审计行补 `operation/durationMs/result`；`auditFeed.ts` 透出；面板列展示
- **验收**: 新旧记录共存解析不炸（向后兼容）；面板可读操作/耗时/结果
- **对账**: ChatGPT §二十二 ✓（本地审计形态保留，不做服务端日志）

### F11 · 搜索对象化收尾
- **Issue**: `feat(search): 预设分组/重命名/复制`
- **ADS 参照**: `core/SearchManager.java`、`wizards/NewSearchWizard.java`
- **DBX 现状**: `LDAPSearchPreset` 结构化条件 + sidecar 持久化 + 历史 10 条
- **修改**: preset 增 `group?`；`SearchForm.vue` 预设下拉分组显示 + 重命名/复制
- **对账**: GAP §5 P2 ｜ ChatGPT §十二部分成立

### F12 · RootDSE 服务器信息增强
- **Issue**: `feat(rootdse): OID 复制 + namingContext 跳转`
- **ADS 参照**: `dialogs/properties/RootDSEPropertyPage.java`
- **DBX 现状**: `showRootDse` 弹窗已有；`lib/valueKinds.ts` 已有 oid kind
- **修改**: RootDSE 弹窗值支持复制；namingContext 行「设为浏览基」回调 `App.vue`
- **对账**: ChatGPT §二十一 ✓部分成立

---

## 4. 与 ChatGPT 优先级表的最终对照

| ChatGPT | 本矩阵 | 差异说明 |
| --- | --- | --- |
| P0 Workbench | F9（P2 可选） | 宿主无编辑器 API；弹窗模式是既有决策 |
| P0 Browser | 已存在（DnTree + 右键十项） | 余量在 F7/F8 |
| P0 Entry WorkingCopy/ChangeSet | 已存在（ldapDiff + 行模型 + dirty 守卫） | 余量在 F2a 轻校验、F5 同步 |
| P0 Schema 基础服务 | F2a（P0，纯前端）+ F2b（P1，后端） | 语法明细数据已端到端，缺口只在三类定义 |
| P0 Search 持久对象 | F11（P2） | presets 已覆盖大半 |
| P0 SearchResult 闭环 | 已存在（双击开编辑器 + 批量操作） | Locate in DIT 余量在 F8 |
| P1 ValueEditor Registry | ✅ 已完成（valueKinds.ts） | 关闭 |
| P1 Browser Actions | 大部分已存在 | F7/F8 收尾 |
| P1 Bookmark | F7 | — |
| P1 Import | F1（升 P0） | parser 已就绪，成本低于 ChatGPT 估计 |
| P1 Operation History | F10 | 本地审计形态保留 |
| P1 Connection Wizard/Diagnostics | 已有（manifest 联动 + ldap/check 两级体检） | 分 tab 受宿主限制，GAP §4 已收口 |
| P2 Advanced Ops / DSML/VLV/Sort | F3（P1 提前：passwd/compare/whoami 是行为级对标刚需）+ 其余维持 GAP M7 | passwd-extend 不宜永久缺失 |

**建议 Sprint 切分**：S1 = F1 + F2a；S2 = F4 + F5；S3 = F2b + F6；S4 = F3 + F8；
S5 = F7 + F10 + F11 + F12；F9 视 relation 视图使用反馈决定做不做。
每个 F 交付时同步更新 `ADS_GAP_ANALYSIS` 与 `ADS_ARCH_MAPPING` 的状态列。
