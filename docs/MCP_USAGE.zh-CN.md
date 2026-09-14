# LDAP MCP 使用说明

本指南介绍如何把 DBX LDAP 的 MCP 工具面接入 AI 客户端。协议方法、完整参数
与降级矩阵见 [LDAP MCP 参考](MCP.zh-CN.md)；本文只覆盖使用路径。工具名均以
backend 注册表为准，共 8 个。

## 两种接入方式

| 方式 | 适用 | 特点 |
| --- | --- | --- |
| DBX MCP 桥（推荐） | DBX 应用运行中 | 经宿主 `dbx_list_plugin_tools` / `dbx_call_plugin_tool` 调用；复用已保存连接、护栏与凭据，工具参数中不出现密码 |
| 独立 stdio 模式 | 无 DBX 在场的自动化 | `backend/bin/dbx-plugin-ldap --mcp` 直接起 MCP 服务器（MCP 2024-11-05，换行分隔 JSON-RPC 2.0）；凭据随调用内联传入，不落盘 |

### 独立 stdio 模式接入示例（ZCode）

```json
{
  "mcp": {
    "servers": {
      "dbx-ldap": {
        "type": "stdio",
        "command": "/绝对路径/backend/bin/dbx-plugin-ldap",
        "args": ["--mcp"]
      }
    }
  }
}
```

stdio 模式下连接类工具可传内联连接参数（`host` 必填，另有 `port`、
`tlsMode`、`authType`、`bindDn`、`password` 等，camelCase，与连接表单对齐）；
同参数调用按 hash 池化为 `mcp-<hash>` 形式的 `connectionId` 自动复用。传 DBX
保存连接的 id 时，若本会话未池化，会自动经应用本地桥转发（fail-closed：桥
不可用时报可行动错误，不静默重试）。注意：Kerberos 族与 DN 白名单策略等
细化字段仅工作台保存连接支持；`ldap_ui_*` 五个工具在 stdio 下返回明确的
`UNAVAILABLE`（需要 DBX 工作台），不会挂起。

## 工具清单（8 个）

| 工具 | 用途 | 关键参数（camelCase） |
| --- | --- | --- |
| `ldap_search_digest` | 本地读核心：filter 服务端执行，sidecar 本地聚合 | `connectionId`/内联 `host`、`filter` 必填；`baseDn`、`scope`、`attributes`、`distinctAttr`、`format`（digest 缺省 / rows） |
| `ldap_cursor_next` | digest 会话翻页，条件不重发、远端不重扫 | `cursorId` 必填；`n`（≤20）、`offset` |
| `ldap_entry_write` | 写入口：add/modify/delete/modifyDn | `connectionId`、`action`、`dn` 必填；按 action 附 `attributes`/`changes`/`recursive`/`newRdn`/`confirmToken` |
| `ldap_ui_schema` | schema 的 attributeType/objectClass 名称清单，帮 AI 构造合法 filter | `connectionId` 必填 |
| `ldap_ui_search` | 把搜索条件填进 DBX 工作台并触发 | `filter` 必填；`baseDn`、`scope`、`attributes`、`sizeLimit` |
| `ldap_ui_focus` | 聚焦工作台面板（search/tree/schema） | `panel` 必填 |
| `ldap_ui_select` | 在结果表中按 DN 定位并打开条目 | `dn` 必填 |
| `ldap_ui_state` | 读 intent 结果或最新 UI 快照 | `intentId` 可选 |

## 任务 → 工具速查

- 统计目录数据（数量、objectClass 分布、子树计数、distinct 值域）→
  `ldap_search_digest`（缺省 `format:"digest"`）。
- 看真实明细行 → `ldap_search_digest` 带 `format:"rows"`（≤20 行），继续翻页
  用 `ldap_cursor_next`。
- 构造过滤器前确认属性/对象类是否存在 → `ldap_ui_schema`。
- 新增或修改条目 → `ldap_entry_write`，`action:"add"` / `action:"modify"`。
- 删除（含递归）或重命名/移动 → `ldap_entry_write`，`action:"delete"` /
  `action:"modifyDn"`，**必须两阶段**：第一次不带 `confirmToken` 拿预览与
  令牌，第二次原参数 + 令牌执行。
- 让用户在 DBX 工作台里看到搜索结果并继续操作 → `ldap_ui_search` 等
  `ldap_ui_*`（仅工作台模式）。

## 读路径语义（token 经济）

- 缺省 `format:"digest"` 只回计数、分布与 ≤5 行样本；明细行经
  `ldap_cursor_next` 翻页，单批 ≤20 行。
- 远端扫描上限缺省 1000 条（`sizeLimit` 调低 / settings `digestScanLimit`
  调高）；cursor 会话 TTL 缺省 10 分钟、LRU ≤8、物化 ≤1 万行。
- 单响应上限 16 KiB，超限按样本 → 行 → 统计顺序丢弃并置 `truncated:true`。
- 扫描数据一条不出 sidecar（除样本/翻页行），聚合在本地完成。

## 写路径与安全边界

- `add` / `modify` 单阶段执行；`delete`（含 recursive，子树沿用 1000 条
  上限）与 `modifyDn` 强制两阶段。confirmToken 一次性、60 秒过期
  （settings `confirmTtlSecs` 可调 10–600）、与请求参数 hash 绑定——参数
  被改动或换连接执行都会作废。
- 只读连接上写工具不进工具清单，调用侧再拒绝一道（纵深防御）。
- 写 DN 的裸控制字符在本地直接拒绝（防审计日志注入）。
- 所有 MCP 写路径审计记 `source:"mcp"`，与工作台写审计同落 audit.jsonl。
- 错误信息自带自纠指引：未知工具名会列出全部可用工具；cursor 过期会提示
  重发 `ldap_search_digest`；必填参数缺失会一次性枚举全部缺口。

## 可调参数（`mcp/settings/set`）

常用项：`digestScanLimit`（1–100000）、`maxCursorRows`（1–100000）、
`cursorTtlSecs`（1–3600）、`maxCursorSessions`（1–32）、`confirmTtlSecs`
（10–600）、`responseLimitBytes`（1 KiB–1 MiB）、`reportWaitMs`（UI intent
等待，1–30000）、`cellWidth`、`digestGroupLimit`、`digestTopN`、
`digestSampleRows`、`digestRowLimit`。完整表见
[LDAP MCP 参考](MCP.zh-CN.md#mcpsettings可调参数mcp-settingsjson-持久化)。

## 验证

离线 smoke 不需要真实目录服务；涉及真实连接的容器用例在环境不可用时按
脚本输出 `SKIP`，离线通过不代表 live 连接通过：

```bash
DBX_PLUGIN_SIDECAR=/path/to/dbx-plugin-ldap python3 scripts/smoke_mcp.py
```

手工单发冒烟：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | backend/bin/dbx-plugin-ldap --mcp
```

## 相关链接

- [LDAP MCP 参考](MCP.zh-CN.md)：协议方法、工具参数全表、降级矩阵与验收用例。
- [README](../README.md) · [产品宣传页](MEDIA.zh-CN.md)
