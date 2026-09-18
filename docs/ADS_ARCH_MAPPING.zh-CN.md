# LDAP 插件 vs Apache Directory Studio 架构级映射（ADS_ARCH_MAPPING）

> 对标基准：Apache Directory Studio 2.x GitHub 源码树（`plugins/` 下的 OSGi 插件，
> 2026-09 抓取）。定位：`ADS_GAP_ANALYSIS.zh-CN.md` 是**功能级**对账表（能力有没有），
> 本文件是**架构级**映射（ADS 哪个功能 → 哪个 UI 类 → 哪个 Core/业务类 →
> DBX 目前对应代码 → 缺什么），供实现追赶项时按图索骥。
> 状态标记：✅ 对应物已覆盖 ｜ 🔶 部分对应（有理念/能力差距）｜ ❌ 无对应物。

## 1. ADS 分层模型（先读懂再对标）

ADS 是 Eclipse RCP 应用，每个域拆成三个 OSGi 插件，依赖单向：

```
*.core   —— 无 SWT 依赖的业务层：模型接口 + Manager + Job(Runnable) + EventRegistry
*.common —— core/ui 共享的模型与工具（ldapbrowser.common：Attribute/Value 适配、filter 格式化）
*.ui     —— SWT 层：View（常驻面板）/ Editor（多开文档）/ Wizard / Action / PreferencePage / PropertyPage
```

支撑 UI 理念的四个机制，比单个功能更值得借鉴：

1. **事件总线同步**（`ldapbrowser.core/events/EventRegistry`）：Entry/Value/Search/Bookmark
   各自定义 UpdateEvent + Listener（EntryAdded/Deleted/Moved/Renamed、ValueModified…）。
   任何 Job 落库后发事件，所有打开的 View/Editor 收到后自刷新——写一处，全局一致。
2. **schema 驱动 UI**（`model/schema/`）：`SyntaxValueEditorRelation` /
   `AttributeValueEditorRelation` 决定"这个属性该用哪个值编辑器"；`BinaryAttribute`/
   `BinarySyntax` 决定二进制呈现。UI 不硬编码属性名。
3. **双形态条目编辑器**：`EntryEditor`（属性表格）与 `LdifEntryEditor`（LDIF 源码）
   编辑同一 `IEntry` 模型，`ToggleAutosave`、`SingleTab/MultiTab` 是同一编辑器的变体。
4. **统一隐喻**：一切皆 View（常驻）/Editor（可多开文档）/Wizard（多步流程）/
   Action（可复用命令）/PropertyPage（对象的元数据页），快捷键、右键菜单、工具栏
   都挂同一套 Action。

## 2. 连接域（connection.core / connection.ui）

| ADS 功能 | ADS UI 类 | ADS Core 类 | DBX 对应代码 | 缺什么 |
| --- | --- | --- | --- | --- |
| 连接分页向导（Network → Authentication → Advanced） | `wizards/NewConnectionWizard` + `widgets/NetworkParameterPage`、`AuthenticationParameterPage` + `ConnectionParameterPageManager` | `connection.core/ConnectionManager`、`ConnectionParameter` | manifest 字段重排 + `visible_when` 联动（宿主表单单页）；`ConnectionsPanel.vue` 只读状态页 | 🔶 宿主侧无法真正分 tab；差距在字段排版而非代码结构（GAP §4 已列本轮收口） |
| 连接测试 | `ConnectionView` 的 Check 按钮经 `RunnableContextRunner` | `ldap/CheckNetworkParameterJob` 等 | `internal/ldapconn/check.go`（network/bind 两级）+ 树行检查 | ✅ |
| 连接文件夹/颜色/拖拽分组 | `ConnectionViewActionGroup`、`NewConnectionFolderAction`、`dnd/DragConnectionListener` | `ConnectionFolder` 模型 | 宿主连接列表能力（`connection.color` 只读透传） | 🔶 随宿主，不自行建列表 |
| 证书信任 UI（逐证书信任 + keystore） | `dialogs/CertificateTrustDialog`、`CertificateInfoDialog`、`PasswordsKeyStoreManagerUtils` | `ConnectionUICertificateHandler` | `tls_ca_path`/`tls_verify` 静态配置 | ❌ 交互式信任流程（P2，需宿主弹窗桥） |
| referral 处理钩子 | `SelectReferralConnectionDialog` | `ConnectionUIReferralHandler` | ❌ | ❌（GAP §1 P1 同源） |
| 密码主密钥库（主密码管多连接密码） | `PasswordsKeystoreManagerUtils` + preference 页 | keystore 存储 | 宿主 secret 存储 | ❌ 不做（宿主职责） |

## 3. 目录浏览域（ldapbrowser.ui/views/browser）

| ADS 功能 | ADS UI 类 | ADS Core 类 | DBX 对应代码 | 缺什么 |
| --- | --- | --- | --- | --- |
| DIT 树浏览 + 懒加载 | `views/browser/BrowserView` + `ShowDITAction` + `BrowserViewUniversalListener` | `jobs/InitializeChildrenRunnable`、`ReadEntryRunnable`、`FetchBaseDNsRunnable`、`IEntry/ChildrenInfo` | `DnTree.vue` + `TreeBranch.vue` + `VirtualList.vue`（scope=one 懒展开、虚拟滚动、截断续载） | ✅（虚拟滚动是超越项） |
| 树三棵分区（DIT/搜索/书签） | `BrowserView` + `ShowDITAction`/`ShowSearchesAction`/`ShowBookmarksAction` | `SearchManager`、`BookmarkManager` | 仅 DIT 单树；搜索以表单+历史呈现 | ❌ 书签树（GAP §6 P2）、❌ 搜索树分区 |
| 树关键字过滤 | `BrowserView` filter widgets | 远程 filter 搜索 | `lib/dnTree.ts` `buildTreeKeywordFilter` 远程子树过滤 | ✅ |
| 条目元数据属性页（operational attrs、metadata） | `dialogs/properties/EntryPropertyPage`、`RootDSEPropertyPage`、`SchemaPropertyPage` | `propertypageproviders/*PropertyPageProvider` | RootDSE 对话框（`showRootDse`）；条目属性页无 | 🔶 Entry/Attribute/Value 级属性页缺失（P2，信息型功能） |
| Quick Search（树上就地快速搜索） | `model/IQuickSearch` + BrowserView 集成 | `impl/QuickSearch` | 树过滤 + SearchForm 折叠快捷条 | 🔶 形态不同：DBX 快捷条在主区不在树上，够用 |
| Link with Editor（树⇄编辑器/结果双向定位） | `LinkWithEditorAction`、`LocateEntryInDitAction`、`LocateDnInDitAction` | UI 选中联动（非事件总线） | 树选中 → Base DN 联动 + relation 视图 `openReferencedEntry`；反查"结果行定位到树"无 | 🔶 单向定位；反查（结果/编辑器 → 树高亮）缺（P2） |
| 拖拽移动条目（树内） | `dnd/DragListener`、`DropListener` | `jobs/MoveEntriesRunnable` | `ModifyDnDialog`（对话框式移动/重命名）、`BatchMoveDialog` | 🔶 交互形态差异；对话框版已覆盖语义（web 弹窗更稳） |

## 4. 搜索域（search + editors/searchresult）

| ADS 功能 | ADS UI 类 | ADS Core 类 | DBX 对应代码 | 缺什么 |
| --- | --- | --- | --- | --- |
| 搜索向导/搜索管理 | `search/SearchPage`、`wizards/NewSearchWizard`、`OpenSearchAction` | `SearchManager`（保存/复用搜索）、`SearchParameter` | `SearchForm.vue` + 预设（sidecar 持久化）+ 历史最近 10 条 | 🔶 保存搜索无分组/排序（GAP §5 P2）；无多搜索并行（单会话语义） |
| 可视化过滤器构建器 | `ldapbrowser.common` filter widgets（可视化树） | `model/filter/LdapAnd/Or/Not/Item/ExtensibleFilterComponent` + `filter/parser/` | `FilterGroup.vue`（≤2 层 AND/OR + NOT 解析回填）+ `lib/ldapFilter.ts`（RFC4515 编解码 + 双向解析） | 🔶 NOT 组 UI 未暴露、嵌套仅 2 层（GAP §5 P1：NOT 组开关） |
| 结果编辑器（表内直接改值） | `editors/searchresult/SearchResultEditor` + `CellModifier` + `QuickFilterWidget` + `FilterAndSortRunnable` | `jobs/SearchRunnable`、`UpdateEntryRunnable` | `ResultTable.vue`（前端列排序/批量操作；表内编辑进 EntryEditor） | 🔶 ADS 表内单元格直改；DBX 双击进编辑器——理念取舍，不改 |
| 服务器端排序/结果过滤 | `SearchResultEditorSorter` + `search/LdapSearchPageScoreComputer` | 控件排序请求 | 客户端列排序 | ❌ 服务器端排序控件（GAP §5 P2） |
| 批量操作向导（统一 add/modify/delete/LDIF 四型） | `wizards/BatchOperation*.java`（5 页向导）、`NewBatchOperationAction` | `jobs/ExecuteLdifRunnable`、`BulkModificationEvent` | `ResultTable` 批量删除/移动（`onBatchDelete`/`onBatchMove`）；无批量修改/LDIF 批执行 | 🔶 缺批量 modify 与 LDIF 批量执行入口（P1 候选，见 §9） |

## 5. 条目编辑域（editors/entry）

| ADS 功能 | ADS UI 类 | ADS Core 类 | DBX 对应代码 | 缺什么 |
| --- | --- | --- | --- | --- |
| 表单条目编辑器 | `EntryEditor` + `EntryEditorUniversalListener` + `EntryEditorActionGroup` | `IAttribute/IValue` 模型、`UpdateEntryRunnable`、`CompoundModification` | `EntryEditorDialog.vue`（多值行、MUST 校验、变更预览、dirty 守卫） | ✅（变更预览是超越项） |
| LDIF 条目编辑器（同模型双形态） | `LdifEntryEditor` + `LdifEntryEditorDocumentProvider` | `ExecuteLdifRunnable` | EntryEditorDialog LDIF 页签（leaveLdif 解析回表单、保存落 modify changes） | ✅ |
| 多标签编辑器（多条目并行编辑） | `MultiTabEntryEditor`、`SingleTabEntryEditor`、`EntryEditorNavigationLocation` | `events/` 选中导航 | 单弹窗 + relation 双栏视图（对标 ADUC） | 🔶 形态差异：relation 视图承担"并行对照"；多开不做 |
| 自动保存开关 | `ToggleAutosaveAction` | — | 显式保存 + dirty 守卫（web 弹窗惯例） | 🔶 不做 |
| 新条目向导（objectClass 驱动） | `NewEntryAction`、`NewContextEntryAction` | `jobs/CreateEntryRunnable`、schema must/may 计算 | `NewEntryWizard.vue` + `lib/newEntryTemplates.ts` + `ObjectClassPickerDialog.vue`（MUST 铺开/变更预览/OID 校验） | ✅（JSON 自定义模板引擎明确不做） |
| 密码修改扩展操作（RFC 3062） | `PasswordModifyExtendedOperationAction` + `dialogs/PasswordModifyExtendedOperationDialog` | `jobs/ExtendedOperationRunnable` | `PasswordAttributeEditor.vue`（哈希辅助 + modify userPassword） | 🔶 extend 操作形态缺（GAP §6 P2） |
| 条目复制/粘贴/复制为多种格式 | `BrowserPasteAction`、`CopyEntryAsLdif/CsvAction`、`CopyDnAction`、`CopyUrlAction`、`CopyValueAction` | `jobs/CopyEntriesRunnable` | `lib/copyEntry.ts` `prepareCopyEntry` + `onCopyEntry`、`copyDn`；复制值/DN/URL/CSV 部分 | 🔶 复制值（含 Base64）、复制 URL 缺；跨连接粘贴（CopyEntries 落库）缺（P2） |
| Encoder/Decoder 工具对话框 | `dialogs/EncoderDecoderDialog` | — | ❌（`lib/entryFormats.ts` 仅内部用） | ❌ 开发者向小工具，P2 按需 |
| Goto DN（Ctrl+Shift 直接跳 DN） | `GotoDnAction`、`LocateDnInDitAction` | 读取 + 树展开 | `DnPickerDialog.vue`（选 DN 入表单） | 🔶 无"跳转并在树中展开"入口（P2，依赖树路径展开） |

## 6. 值编辑器域（valueeditors 插件）

ADS 用 **注册表**：`ValueEditorsActivator` 注册各编辑器，`model/schema/SyntaxValueEditorRelation`+
`AttributeValueEditorRelation` 按 schema 语法/属性自动选择——UI 不写属性名判断。

| ADS 值编辑器 | ADS 类 | DBX 对应代码 | 缺什么 |
| --- | --- | --- | --- |
| password（哈希算法选择/预览） | `password/PasswordValueEditor`、`PasswordDialog` | `PasswordAttributeEditor.vue` + `lib/passwordHash.ts` | ✅ |
| image/certificate（二进制三视图） | `image/ImageValueEditor`、`certificate/CertificateValueEditor` | `BinaryValueEditor.vue` + `lib/binaryValue.ts`（预览/hex/PEM + 上传） | ✅（合并实现，等价） |
| generalizedTime / AD time | `time/GeneralizedTimeValueEditor`、`adtime/ActiveDirectoryTimeValueEditor` + `ActiveDirectoryTimeUtils` | `DatetimeValueEditor.vue` + `lib/generalizedTime.ts` + `lib/filetime.ts` | ✅ |
| DN 值（跳转定位） | `dn/DnValueEditor` | `DnValueEditor.vue` + relation 视图（`openReferencedEntry` 反查） | ✅（反查是超越项） |
| objectClass 选择器 | `objectclass/ObjectClassValueEditor`、`ObjectClassDialog` | `ObjectClassPickerDialog.vue` + EntryEditorDialog chips 行 | ✅ |
| boolean/OID/UUID/GUID/SID 就地编辑 | `bool/InPlaceBooleanValueEditor`、`oid/InPlaceOidValueEditor`、`uuid/InPlace*`、`msad/InPlaceMsAd*` | `lib/valueKinds.ts` + `UacValueEditor.vue`（AD UAC 专用，ADS 无） | 🔶 就地（单元格内）编辑形态缺；SID/GUID 解码无（P2） |
| integer/address/管理角色 | `integer/IntegerDialog`、`address/AddressValueEditor`、`administrativerole/*` | 通用文本输入 | ❌ 专用编辑器（低价值，按需） |
| **注册表机制** | ValueEditors 扩展点 + relation 查询 | `EntryEditorDialog.valueEditors` 手工按属性名/语法分流 | 🔶 **架构差距**：未做成显式"kind → editor"注册表；新增编辑器要改组件分发逻辑（P1 级重构候选，见 §9） |

## 7. Schema 域（editors/schemabrowser + schemaeditor 插件）

| ADS 功能 | ADS UI 类 | ADS Core 类 | DBX 对应代码 | 缺什么 |
| --- | --- | --- | --- | --- |
| Schema 主从浏览器（列表 + 明细页） | `SchemaBrowser` + `AttributeTypeDescriptionDetailsPage`、`ObjectClassDescriptionDetailsPage`、`MatchingRuleUseDescriptionDetailsPage`、`LdapSyntaxDescriptionDetailsPage`、`SchemaDetailsPage` | `model/schema/Schema`、`SchemaUtils`、`ReloadSchemaAction` | `SchemaPanel.vue` 双列列表 + `lib/schemaCache.ts`（30min 缓存）+ `deriveSchemaMetadata` | 🔶 明细页（语法、相等/排序/子串匹配规则、被哪些 objectClass 引用）缺——GAP §8 P2 |
| MatchingRule/语法独立页 | 同上 DetailsPage 系列 | 同上 | 仅名称/描述 | 同上 |
| Schema 文件编辑器（本地 schema） | `schemaeditor` 插件整套 | — | ❌ 明确不做（超出插件定位） | — |
| 在条目编辑中打开 schema 浏览 | `OpenSchemaBrowserAction` | — | 工具栏 Schema 按钮 + 编辑器内属性提示 | ✅（形态收敛为面板） |

## 8. LDIF / 导入导出 / 日志域

| ADS 功能 | ADS UI 类 | ADS Core 类 | DBX 对应代码 | 缺什么 |
| --- | --- | --- | --- | --- |
| 独立 LDIF 编辑器（语法高亮/内容辅助/大纲/折叠/格式化） | `ldifeditor/editor/LdifEditor`、`text/LdifCompletionProcessor`、`reconciler/*`、`LdifOutlinePage`、`FormatLdif*Action` | `ldifparser` 插件（独立解析器） | `lib/ldif.ts`（解析/序列化，含 changetype）+ EntryEditor LDIF 页签 | 🔶 高亮/辅助/格式化无（textarea 级）；解析器能力等价。格式化/校验反馈可做（P2） |
| LDIF 文件导入（含 changetype 执行） | `wizards/ImportLdifWizard`、`ImportLdifMainWizardPage` | `jobs/ImportLdifRunnable`、`ExecuteLdifRunnable` | `ImportEntryDialog.vue`（单条目 add）；LDIF 文件批量导入缺 | ❌ **GAP §7 P0/P1 同源**：LDIF 文件导入 + changetype 策略（§9 首项） |
| LDIF/CSV/Excel/ODF/DSML 导出 | `wizards/ExportLdif/Csv/Excel/Odf/DsmlWizard` | `jobs/Export*Runnable` | `lib/ldapExporter.ts`（LDIF/CSV/JSON）+ `exportResults`/`exportSubtree` | ✅（缺 XLSX/DSML——明确不做/按需） |
| DSML 导入 | `ImportDsmlWizard` | `ImportDsmlRunnable` | ❌ | ❌ 按需（GAP §7 P2） |
| 修改/搜索日志视图（服务端日志） | `views/modificationlogs/ModificationLogsView`、`searchlogs/SearchLogsView` + Enable/Clear/Export Action | ADS 连接侧日志抓取 | `AuditFeedPanel.vue` + `lib/auditFeed.ts`（本地写操作审计 + jsonl 落盘） | 🔶 语义不同：DBX 是**本地审计**（安全增强，超越项）；服务端 modification log 读取不做 |

## 9. 架构级缺口清单（建议节奏，均与 GAP 对账表挂钩）

按"先补能力、再补理念"排序；理念项（R-*）只在能降低后续功能成本时做：

1. **R-LDIF 批量导入**（=GAP §7 P0/P1）：前端解析复用 `lib/ldif.ts`，逐条走
   entry/add + changetype 拒绝策略；UI 挂 `ImportEntryDialog` 升级为文件/粘贴双入口。
2. **R-批量操作扩展**（GAP §5 尾行延伸）：在既有批量删除/移动之外补"批量 modify"
   （模板属性 → 多条目套用），对齐 BatchOperationWizard 的 modify 型。
3. **R-值编辑器注册表**（§6 架构差距）：把 EntryEditorDialog 的手工分流抽成
   `valueEditors.ts`（kind/语法/属性名 → 组件）注册表，新增编辑器零侵入——先做它，
   后续 SID/GUID 解码、integer 等编辑器才有落点。
4. **R-Schema 明细页**（GAP §8 P2）：SchemaPanel 加第三栏 DetailsPage（语法/匹配规则/
   反向引用），数据源就是现有 schemaCache 的原始定义透出。
5. **R-NOT 组 UI + 深嵌套**（GAP §5 P1）：FilterGroup 放开层数限制 + NOT 组开关。
6. **R-复制工具集齐**：CopyValue（含 Base64）、CopyURL；配合 GotoDn 树内跳转。
7. **R-事件总线式刷新收敛**：目前 App.vue 手工 `invalidateEntryCache` + refresh；
   写操作已多处收口，可抽 `lib/entryEvents.ts`（emit entry:changed/deleted/moved →
   树/结果表/编辑器缓存统一失效）。**这是把 ADS 理念移植进 Vue 的最小形态**，
   防止后续功能各自刷新导致状态漂移。

不做（理念不照搬，宿主形态决定）：多视图 Perspective、多标签编辑器、
表内单元格直改、连接文件夹/拖拽分组、密码主密钥库、schema 文件编辑器、
交互式证书信任、服务端日志视图（本地审计替代且超越）。

## 10. UI 理念对照（吸收什么、放弃什么）

| ADS 理念 | DBX 取舍 | 理由 |
| --- | --- | --- |
| 事件总线全 UI 同步 | **吸收**（§9-7 最小形态） | 防状态漂移，成本低于收益 |
| schema 驱动编辑器选择 | **吸收**（§9-3 注册表） | 已有 schemaCache，只差注册表形态 |
| 双形态条目编辑（表单⇄LDIF） | **已吸收**（LDIF 页签落修改） | — |
| 主从明细（Schema） | **吸收**（§9-4） | 纯前端增量 |
| 批量操作向导 | **部分吸收**（§9-2） | web 弹窗/多步组件替代 Eclipse 向导 |
| Link with Editor 双向定位 | 🔶 保留单向 + relation 视图 | 树反查展开成本高，按需 |
| 多视图/多编辑器/Perspective | **放弃** | 宿主 workbench 是单页；弹窗即编辑器 |
| 表内直改 | **放弃** | 双击编辑器 + 变更预览更安全（LDAP 写错代价高） |
| 拖拽移动 | **放弃**（对话框替代） | 虚拟列表下拖拽可及性差，a11y 优先 |
| 交互式证书信任 | **搁置** | 需宿主新桥接，走宿主路线图 |
