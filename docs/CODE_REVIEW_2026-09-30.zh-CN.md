# 全方位代码审查报告 — 2026-09-30

- **审查分支**：`codex/ldap/full-code-review`（基于 main @ 958a2fc，包含工作区未提交的日志面板功能改动）
- **审查方式**：四条独立 lane 并行审查（安全 / Go 后端质量 / Vue 前端质量 / 架构权衡），各自在干净上下文完成，证据均落到 `file:line`
- **验证基线**：`go vet ./...` 0 告警、`gofmt -l` 干净、`go test ./...` 7/7 包通过、`go test -race`（logbuf/mcp/ldapconn）通过；`vue-tsc --noEmit` 0 错误、vitest 88 个测试文件 / 1285 用例全绿

---

## 总览

| 维度 | 结论 |
|---|---|
| Files Reviewed | 约 140 个源码文件（后端 34 + 前端 44 逐行 + 配置/脚本/共享库全量扫描） |
| CRITICAL | 0 |
| HIGH | 2（前端 1、后端 1） |
| MEDIUM | 8（安全 1、后端 3、前端 4） |
| LOW | 23（安全 7、后端 8、前端 8） |
| Architectural Status | **WATCH**（无 Blocker；2 项 High 级架构担忧） |

**SYNTHESIS（按确定性门禁规则）**：
- 安全 lane 推荐：APPROVE（附 COMMENT）
- 后端 lane 推荐：COMMENT
- 前端 lane 推荐：REQUEST CHANGES（存在 HIGH）
- 架构 lane 状态：WATCH
- **最终推荐：REQUEST CHANGES** —— 由前端 H1 与后端 H1 驱动。两处 HIGH 的修复面都很小（各约十行 + 一条回归测试），修复后整体质量可判 COMMENT 及以上。

---

## CRITICAL (0)

无。安全 lane 对 LDAP 过滤器注入、DN 注入、MCP confirm 绕过、凭据泄漏、原型污染、路径穿越等主攻击面均尝试构造了完整攻击路径，均被现有防线（RFC 4515 双端转义 + `ldap.CompileFilter` 硬校验、`NormalizeWriteDN` 白名单、crypto/rand 一次性 confirmToken、`connection/*` 日志排除 + `requestSummary` 白名单脱敏）拦截，且关键防线有测试钉死（`backend/log_test.go:44`、`manifest_contract_test.go`）。

## HIGH (2)

### H-F1. 分阶段属性回填会静默清空用户未保存的编辑（数据丢失）
`frontend/src/components/EntryEditorDialog.vue:317-328`（watch）+ `:269-315`（initFor）；触发链 `frontend/src/lib/useEntryDetail.ts:170-174` → `App.vue:1232`

- **Issue**：watch 依赖含 `props.entry/loading/loadingMore/loadingDeferred`，任一变化（open 且非 loading）就无条件重跑 `initFor`；`preserveTab` 只保页签，`rows`/`rdnDraft`/`ldifText` 全部按服务器值重建。
- **Risk**：用户在表单页签改值 → 切 LDIF/关联页签（触发 `loadDeferred`）→ 延迟属性回填完成 → `editorEntry` 被合并结果替换 → watch 触发 `initFor` → **rows 与 LDIF 文本被重置、dirty 翻 false，编辑无提示丢失**。这是由用户主动切页签即可触发的真实丢数据路径。现有 spec（`EntryEditorDialog.spec.ts:586`）只断言页签保持，未覆盖"entry 替换时保留编辑"。
- **Fix**：`initFor` 在同 DN 身份（`initializedIdentity === nextIdentity`）且非 add 态时跳过 `rows`/`ldifText` 重建（仅更新 `sourceValues` 基线，或按行合并并保留已编辑行）；补一条"deferred 回填不吞编辑"的回归测试。

### H-B1. 重复 `mcp/call`（带 lifecycle）无条件强制重连，中断进行中的搜索会话并击穿 schema 缓存
`backend/main.go:591-601` + `backend/internal/ldapconn/service.go:252-285`

- **Issue**：`Connect()` 无条件替换 `connEntry`（status 重置 `idle`、conn 置空）、无条件调用 `cancelSearchSessionsForConnection` 与 `invalidateSchema`；而 `mcpCall` 在每次带 lifecycle 载荷的桥接调用时都执行 `svc.Connect`——注释声称"幂等覆盖"，实际不是。
- **Risk**：宿主内每次桥接 MCP 工具调用都会 (a) 取消该连接全部 RFC 2696 搜索会话（用户 UI 中正在分页的操作报 "unknown or expired searchId"，`search_sessions.go:268`）、(b) 清掉 10 分钟 schema 缓存、(c) 强制下次 UI 操作重连（延迟尖峰）。人机共存工作流下每次工具调用产生系统性抖动。
- **Fix**：`Connect` 中比对新旧 `profile`/`secrets`/`target`，仅配置实际变化时才替换/取消/失效；或在 `mcpCall` 中当条目已存在且配置一致时跳过 `Connect`。补一条"同配置重复 Connect 不产生副作用"的测试。

## MEDIUM (8)

### 安全

1. **SEC-101（CWE-400）** `backend/internal/ldapconn/operations.go:180-186` — 非分页搜索路径（`pageSize=0`）对服务端返回条目无客户端硬上限，仅透传 `sizeLimit`（0=不限）。敌意/被中间人的目录服务器可一次性流式返回数百万条目全部物化进内存 → OOM。分页主路径已 clamp 到 100k，此为缺口。**Fix**：非分页分支套用与分页路径相同的 `aggregateLimit` 语义（提前截断并置 `truncated`），或改走 `pagedSearchEntries`。

### 后端

2. **M-B1** `backend/internal/ldapconn/service.go:405-421`（应用于 `operations.go` Add/Modify/Del/ModifyDN/PasswordModify）— `WithConn` 在 EOF/超时类错误时对写操作也重试一次；响应包丢失时服务端可能已提交写入，重试造成至少一次语义：用户看到 "AlreadyExists" 报错但写入实际已生效，审计同时出现误导性失败行与真实服务端变更。**Fix**：重试仅限读操作（传 `retryable` 标志），或将重试返回的 "already exists" 类结果码显式映射为 "applied"。
3. **M-B2** `backend/internal/mcp/digest.go:110,115`、`backend/internal/mcp/util.go:280`、`backend/internal/ldapconn/schema.go:472` — 对 `entry.Attributes` 的 map 查找大小写敏感，而 LDAP 属性名不区分大小写（RFC 4512）。调用方传 `"Mail"` 或服务器返回非规范拼写时，`distinct` 分布/`objectClass` 统计/cursor 投影**静默为空**，无报错无截断标志。**Fix**：按条目构建一次性不区分大小写的属性视图，或统一规范化键。
4. **M-B3** `backend/internal/ldapconn/operations.go:997-1003` — 客户端截断分页搜索时未发送 RFC 2696 放弃控制（零大小搜索），go-ldap 的 `SearchWithPaging` 有此语义。共享连接回退路径上服务端分页结果集滞留到服务器 TTL。**Fix**：截断返回前 `pagingControl.SetCookie(nil)` 发送一次放弃搜索。

### 前端

5. **M-F1** `frontend/src/App.vue:113-136,907-953` — `refreshBackendReadOnly()` 仅在 `initialize()` 调用一次，连接切换路径 `syncConnectionContext` 未重置也未重探。旧连接 readOnly=true → 切到可写连接后 `canWrite` 恒 false，全部写入口被禁直到重载（fail-sticky）。**Fix**：`switched` 分支置 `backendReadOnly.value = false` 并重探。
6. **M-F2** `frontend/src/App.vue:897-905 vs 1000-1011` — `schemaWarmupTimer`（2s 定时器）在 `onBeforeUnmount` 中未清理，面板快速开合后定时器"复活"向已退出的会话发请求（与已修的 K-8 同款模式）。**Fix**：卸载钩子加 `window.clearTimeout(schemaWarmupTimer)`。
7. **M-F3** `frontend/src/App.vue:504-525` — `onBatchDelete` 是唯一没有防重入门闩的批量破坏性操作（批量移动/修改均有 submitting 门闩），重入会并发两轮删除且汇总通知误导。**Fix**：与兄弟路径对齐，加 `batchDeleteSubmitting` 门闩。
8. **M-F4** `frontend/src/lib/ldif.ts:41-56 vs :187-188` — TAB 是 RFC 2849 合法 SAFE-INIT-CHAR 故 `needsBase64` 不编 base64，但解析侧防御性剥掉冒号后前导空白 → 值以前导 TAB 开头时**导出→再导入静默丢字符**。**Fix**：`needsBase64` 把前导 TAB 判为 unsafe，或解析侧仅在首字符为空格时剥一格。

## LOW (23)

### 安全（7）
- **SEC-102** `backend/internal/ldapconn/dial.go:218` — `InsecureSkipVerify: !profile.TLSVerify` 逃生门；默认 true + 每次建连审计留痕（`service.go:545`）+ TLS 1.2 下限，缓解到位，保持文档警示即可。
- **SEC-103** `backend/internal/mcp/appbridge.go:105` — `exec.Command("sh", "-c", $DBX_APP_LAUNCH_CMD)`；前提是已控制进程环境，建议文档标注该变量等价于代码执行。
- **SEC-104** `backend/main.go:737-739` — 请求日志捕获 filter 原文（截 200 rune），断言值可能含敏感内容；随本次未提交的日志面板工作引入，建议面板文案提示或对命中 `blocked_attributes` 的断言脱敏。
- **SEC-105** `backend/internal/ldapconn/auth_gssapi.go:56` — 恒定 `DisablePAFXFAST(true)`，降低 KDC 防猜测/防降级能力；建议后续允许显式启用 FAST。
- **SEC-106** `backend/internal/mcp/stdio.go:681-689` — 内联凭据连接池 id 为凭据 canonical JSON 的 SHA-256 前 16 字节且错误消息回显，存在离线字典碰撞面；建议池 id 改随机 UUID。
- **SEC-107** `scripts/perf_paging_test.py:120` — 测试密码经 docker run argv 传递（本机进程列表短暂可见）；密码为一次性生成仅本地容器，可改 `--env-file`。
- **SEC-108** `scripts/ldap-dev-seed/.env.dev` + `tls/openldap.key` — 本地开发件含一次性凭据/自签私钥；已验证 `.gitignore` 正确忽略、容器仅绑 127.0.0.1，无生产凭据。全仓 grep 无硬编码真实凭据。

### 后端（8）
- **L-B1** `backend/internal/mcp/stdio.go:584-618` — 池化 id 在 `svc.Connect` 完成前发布，并发同参调用可能命中未就绪条目收到瞬时 "not connected"；发布前同步完成 Connect。
- **L-B2** `backend/internal/ldapconn/service.go:426-433,512-519` + `main.go:675-680` — `EmitLog`/`EmitAudit` 在持有 `entry.mu` 时执行，慢消费者会拖停该连接全部操作；建议移出临界区。
- **L-B3** `backend/internal/mcp/digest.go:94,147` — `Truncated` 声明透传实际恒为 `false`，死字段，删除或对接。
- **L-B4** `backend/internal/mcp/server.go:654-657` — `twoPhaseWrite` 中空 `if` 块死代码。
- **L-B5** `backend/internal/mcp/intent.go:44,64` — 注释称 LRU 实为 FIFO 驱逐（对照 cursor.go 有真 `touchLocked`），文档与行为不符。
- **L-B6** `backend/internal/mcp/settings.go:200` + `util.go:61-78` — `numberArg` 对 `10.9` 静默截断为 10，建议拒绝非整数。
- **L-B7** `backend/internal/mcp/appbridge.go:128-137` — `ensureBridge` 截止时间检查在 500ms sleep 之后，`wait<=0` 也要等 500ms；检查移到循环顶。
- **L-B8** `backend/internal/ldapconn/check.go:164-167` — 本地 `30s` 字面量重复推导默认超时，冗余防御性代码。

### 前端（8）
- **L-F1** `frontend/src/components/EntryEditorDialog.vue:801` — 右键"复制属性行(LDIF)"对多值行生成折行单值，重导入语义错误；应逐值一行。
- **L-F2** `frontend/src/components/LogPanelView.vue:66-85` — 回填 await 期间点"清空"，tail 结果仍会合并进空列表（历史重现）；记录世代号或 settle 前判断。另 `mockDbxHost.ts` 的 `ldap/log/tail` 忽略 `limit` 参数（仅 dev 夹具保真度）。
- **L-F3** `frontend/src/components/LogPanelView.vue:45-50` — `connectionLabel` 引用声明在其后的 `connectionNames`（提升可用，建议调序）。
- **L-F4** `frontend/src/App.vue:834-838` — `onOpenLogsClick` 不 catch，宿主命令传输层 reject 时无用户反馈。
- **L-F5** `frontend/src/lib/ldapDiff.ts:57` — `includes` 去重 O(n²)，千级 member 行卡顿；`entryDiff.ts:27` 超大数组 spread 有理论爆栈风险。
- **L-F6** `frontend/src/App.vue:823` — `${params.action ?? "ldap"}: ${result}` 硬编码英文绕过 i18n（审计横幅用户可见）。
- **L-F7** `frontend/src/components/DnTree.vue:776` — 过滤视图点击每次分配一次性节点仅为取 dn。
- **L-F8** `frontend/src/lib/generalizedTime.ts:153-169` — `parseDatetimeLocalWall` 未校验时分（姊妹函数均校验）；当前仅浏览器 picker 供值，实际影响未验证。

---

## ARCHITECTURE WATCHLIST（状态：WATCH，无 Blocker）

### High 级担忧

1. **协议真相三处独立维护，且已发生实际漂移** — 后端事实协议 = `backend/main.go:186-255` dispatch switch（32 个 case）；前端 = `frontend/src/lib/api.ts`；mock = `frontend/src/mockDbxHost.ts` 第二套 switch。三者无共享注册表、无交叉校验测试。漂移实例就在本次功能里：`backend/internal/ldapconn/types.go:456` 的 `LDAPConnectionStatus` 恒下发 `name`，前端 `api.ts:89-102` 的接口没有该字段，`LogPanelView.vue:89-95` 只能内联类型自行补偿；`docs/IMPL_PLAN_DBX_LDAP.zh-CN.md:127` 写"19 个领域方法"实际已 32 个。**建议**：沉淀机器可读契约（如 `shared/protocol.json`）+ 三端交叉校验测试；最低成本是加脚本校验三处 method 集合一致。这是架构 lane 认定复利最大的一项："如果只能改一件事，就改这个"。
2. **agent-flow 所有权模型与现实矛盾** — `.github/agent-flow.yml:14-19` 中 `contract` 与 `frontend` 同时声明拥有 `manifest.json`；`docs/PROTOCOL.zh-CN.md` 在仓库中**不存在**（git 全历史亦无），contract 阶段守卫的是幽灵文件；`backend/main.go:21` 注释引用的 `shared/IMPL_PLAN_PLUGIN_MCP.zh-CN.md` 同样不存在。多 agent 工作流下改动会持续落错分支。**建议**：一次性修正所有权表、删除或真正创建协议文档。

### Medium 级担忧

3. **日志面板接线层零自动化覆盖** — 后端与前端纯函数均有测试，但 `LogPanelView.vue` 无组件 spec，`App.spec.ts` 未覆盖 `logPanelMode` 分支，`scripts/ui_test.mjs` 无 `?panel=1` 走查；`logFeed.ts:11-29` 手工复刻 `logbuf.Entry` 形状（与担忧 1 同根因）。
4. **`syncConnectionContext` 手工复位清单是结构性脆弱点** — `App.vue:907-953` 逐项手动复位 10+ 弹窗/状态，注释连篇引用历史事故；每新增带 DN 上下文的弹窗，漏一行即跨连接写事故。建议收进单个 reactive 对象 + epoch 整体替换，把"记住逐个复位"变成"结构上不可能漏"。
5. **engines 声明 `>=1.2.0` 但代码背约 36 处旧宿主降级 shim** — 无文档声明最低支持宿主版本，shim 支持矩阵与测试面持续膨胀。建议写明宿主版本支持策略并约定抬底时删 shim。
6. **audit.jsonl 无限增长** — `backend/internal/store/store.go:204-230` append-only 无轮转无消费工具；建议按大小轮转或文档明确体量预期与清理路径。
7. **流程：整块日志面板功能未提交，且落在 review 分支上** — 12 文件约 +900 行全部在工作区；`one_branch_per_agent` 模型下 review/integration 阶段无法按契约运转。另 `.dbx-store.json`（本地工具快照，已核实不含凭据）被 git 跟踪且混入 diff，建议移入 `.gitignore`。

### Nit（择机）

`sasl_qop` 表单提供 `auth-int/auth-conf` 但后端一律 fail-closed（表单给必败选项，建议标注暂不可用）；`logbuf` 的 `Result: denied` 三值契约仅文档存在、无生产者；`i18n.ts` 4314 行七语单文件（已有 spec 门禁兜底，仅翻译成本）；树/表格双虚拟化栈属知情取舍，保持现状；`main.go` 对 SDK 级单例 Emitter 的加锁缓存为防御性冗余。

---

## 明确通过项（供后续参考）

- **安全防线成体系**：过滤器/DN 注入双端硬校验、MCP 两阶段 confirm（48-bit crypto/rand 一次性、hash 绑定参数、60s TTL、fail-closed）、凭据仅内存 + 日志白名单脱敏有测试钉死、屏蔽属性请求+响应双过滤、TLS 默认校验 + 显式降级审计。
- **并发设计经得起推敲**：`entry.mu → s.mu → searchSessionsMu → session.mu` 锁序清晰，`prune` 用 `TryLock`，幂等关闭，`-race` 通过。
- **前端竞态守卫成体系**：搜索会话/条目详情/引用页签/树游标全部 requestSeq+connectionId 双闸；全库 13 处 window/document 监听与 10 处定时器除 M-F2 外均有成对清理；各缓存均有上限（条目 50/审计 100/日志 1000/页签 6/历史 10）。
- **解析器质量高**：dn.ts 转义感知切分、ldapFilter RFC 4515 双向转义 + GUID 混合端序、filetime BigInt 溢出防护、generalizedTime 墙钟日历校验，均有 spec 且抽验无逻辑错误。
- **logbuf 设计本身正确**：事件与 tail 同一 Entry 形状、单调 seq 游标、前后端容量一致（1000）、无落盘、竞态天然收敛。

## 测试缺口清单（按修复优先级）

1. 同配置重复 `Connect` 的副作用测试（可捕获 H-B1）
2. "deferred 回填不吞编辑"回归测试（可捕获 H-F1）
3. `logbuf` 并发 Append/Tail 的 `-race` 压测（当前 race 跑了但没被竞争路径触达）
4. 截断的 `pagedSearchEntries` 放弃语义测试（M-B3）
5. `WithConn` 写路径重试行为测试（M-B1）
6. main.go dispatch 穷尽性测试（每个已分发方法返回非 -32601）
7. LogPanelView 挂载 spec + `?panel=1` UI 走查场景（架构担忧 3）

---

## 各 lane 原始结论

| Lane | Agent | Files | 结论 |
|---|---|---|---|
| 安全 | security-auditor | ~70 | APPROVE（附 COMMENT：SEC-101/104 建议顺手处理） |
| Go 后端 | general-purpose | 34 | COMMENT（H-B1 建议下个发布前处理） |
| 前端 | general-purpose | 44（+175 文件全库扫描） | REQUEST CHANGES（仅因 H-F1 + M-F1） |
| 架构 | architecture-critic | 全仓 | WATCH（无 Blocker） |

**RECOMMENDATION: REQUEST CHANGES** —— 修复两处 HIGH（估计合计 <50 行 + 2 条回归测试）后可复审为 COMMENT；架构 WATCH 项（协议单一事实来源）建议单独立项，不阻塞本批。
