// dbx-plugin-ldap sidecar 入口（L-A 路）。
//
// 入口互斥：`--mcp` 进入独立 stdio MCP 服务器模式（MCP 2024-11-05，ssh
// 同款；internal/mcp stdio.go），不启动 Emitter/插件协议循环；不带标志则
// 按下述 DBX 插件协议模式运行。同一进程只跑其中一种。
//
// 装配：dbxpluginsdk.NewServer + Handler switch。方法表按实施文档 §5.2 全量：
//
//	connection/test | connection/connect | connection/disconnect   （本文件实现）
//	ldap/search | ldap/search/start | ldap/search/next | ldap/search/cancel |
//	ldap/count | ldap/entry/get | ldap/rootDse | ldap/schema |
//	ldap/check | ldap/entry/add | ldap/entry/modify | ldap/entry/delete |
//	ldap/entry/childrenCount | ldap/entry/modifyDn |
//	ldap/entry/compare | ldap/whoami | ldap/entry/passwdModify      （F3）
//	ldap/connections/statuses |
//	ldap/presets/list | ldap/presets/save | ldap/presets/remove    （转发 internal/ldapconn）
//	ldap/log/tail                                                  （日志面板增量回填，internal/logbuf）
//	ldap/ui/state/report                                            （MCP intent 回报，前端回调）
//	mcp/tools | mcp/call | mcp/settings/get | mcp/settings/set      （M1 MCP 工具面，internal/mcp）
//
// MCP 面设计来源 shared/IMPL_PLAN_PLUGIN_MCP.zh-CN.md（v2）；工具表与两阶段
// 语义见 docs/MCP.zh-CN.md。公共约定：参数/返回 camelCase；领域方法必填
// connectionId（ldap/connections/statuses 为全局视图可省）；业务错误统一
// PluginError{-32000, message}；未注册方法 -32601（SDK MethodNotFound）。
// 凭据不进日志/事件/审计。
package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"

	"io.dbx.ldap.plugin/internal/ldapconn"
	"io.dbx.ldap.plugin/internal/lifecycle"
	"io.dbx.ldap.plugin/internal/logbuf"
	"io.dbx.ldap.plugin/internal/mcp"
	"io.dbx.ldap.plugin/internal/store"
)

// 身份版本：默认仅 go run/go test 兜底；scripts/build.sh 打包时用
// -ldflags "-X main.version=..." 从 manifest.json 注入，保证与 manifest 一致。
var version = "0.0.0-dev"

// --- 独立 stdio MCP 服务器模式（`--mcp`） ---

// mcpStdioRequested 报告 args 是否携带 `--mcp` 标志（精确匹配，照 ssh
// mcp 入口约定）。true 时进程进入 stdio MCP 服务器模式，不启动插件协议。
func mcpStdioRequested(args []string) bool {
	for _, arg := range args {
		if arg == "--mcp" {
			return true
		}
	}
	return false
}

// runMcpStdio 独立 stdio MCP 服务器（internal/mcp stdio.go）：自带连接
// service 与工具面 Server；审计只落 audit.jsonl（无 Emitter，不发事件）。
// 日志走 stderr（stdout 是协议通道）。
func runMcpStdio() {
	st, err := store.Open()
	if err != nil {
		log.Printf("[dbx-plugin-ldap] store disabled: %v", err)
		st = nil
	}
	server := mcp.NewStdioServer(version, st, func(rec ldapconn.AuditRecord) {
		if st == nil {
			return
		}
		if err := st.AppendAudit(store.AuditRecord{
			ConnectionID: rec.ConnectionID,
			Action:       auditAction(rec.Action),
			Target:       rec.Target,
			Result:       auditResultForStore(rec.Result),
			Source:       rec.Source,
			Operation:    rec.Operation,
			DurationMs:   rec.DurationMs,
			Detail:       rec.Detail,
		}); err != nil {
			log.Printf("[dbx-plugin-ldap] audit write failed: %v", err)
		}
	})
	defer server.Close()
	if err := server.Serve(os.Stdin, os.Stdout); err != nil {
		// log.Fatal 走 os.Exit，defer 不会执行：先显式释放连接再退出。
		server.Close()
		log.Fatal(err)
	}
}

// pluginHandler 实现 dbxpluginsdk.Handler。
type pluginHandler struct {
	svc    *ldapconn.Service
	st     *store.Store
	mcpSrv *mcp.Server
	// logs 请求级日志环形缓冲（日志面板数据源；会话级不落盘）。零值
	// handler（单测直接构造）nil 安全：装饰器与 tail 均判空跳过。
	logs *logbuf.Buffer

	mu      sync.Mutex
	emitter *dbxpluginsdk.Emitter // Serve 期间单例，用于 ldap/audit、ldap/log 与 ldap/ui/intent 事件
}

func main() {
	// `--mcp`：独立 stdio MCP 服务器模式（与插件协议模式互斥，见文件头）。
	if mcpStdioRequested(os.Args[1:]) {
		runMcpStdio()
		return
	}

	st, err := store.Open()
	if err != nil {
		// 数据目录不可用不阻断连接能力：审计/预设降级为不可用。
		log.Printf("[dbx-plugin-ldap] store disabled: %v", err)
		st = nil
	}

	svc := ldapconn.NewService()
	handler := &pluginHandler{svc: svc, st: st, logs: logbuf.New(logbuf.DefaultMax)}
	svc.Audit = handler.auditRecord
	svc.Log = handler.logRecord
	svc.Presets = newPresetStore(st)

	// MCP 工具面（M1）：mcp/tools|call|settings + ldap/ui/state/report。
	// intent 事件经当前 Emitter 下发（与 audit/log 同一条持锁通道）。
	mcpSrv := mcp.NewServer(svc, st)
	mcpSrv.SetEmitter(handler.emitEvent)
	handler.mcpSrv = mcpSrv

	metadata := dbxpluginsdk.Metadata{
		ID:           "io.dbx.ldap",
		Version:      version,
		Capabilities: []string{"connections", "events"},
	}
	server := dbxpluginsdk.NewServer(metadata, handler)

	// stdin EOF（进程生命周期结束）→ Serve 返回 → 清理全部连接（M0 §3.2）。
	defer svc.CloseAll()
	if err := server.Serve(); err != nil {
		// log.Fatal 走 os.Exit，defer 不会执行：先显式释放连接再退出。
		svc.CloseAll()
		log.Fatal(err)
	}
}

// Handle 方法分发（每请求一个 goroutine，Handler 须并发安全：全部状态在
// ldapconn.Service 内加锁，本结构体仅 emitter 一个可变字段且持锁访问）。
// ldap/* 与 mcp/* 请求经计时装饰器进入请求日志（ldap/log）；connection/*
// 不记——其 params 携带 lifecycle 凭据，装饰器不碰，生命周期留痕由
// service 层的 Log 回调负责。
func (h *pluginHandler) Handle(
	_ dbxpluginsdk.RequestContext,
	method string,
	params json.RawMessage,
	emitter *dbxpluginsdk.Emitter,
) (any, *dbxpluginsdk.PluginError) {
	h.mu.Lock()
	h.emitter = emitter
	h.mu.Unlock()

	if !shouldLogRequest(method) {
		return h.dispatch(method, params)
	}
	start := time.Now()
	result, perr := h.dispatch(method, params)
	h.logRequest(method, params, perr, time.Since(start))
	return result, perr
}

// shouldLogRequest 报告方法是否进请求日志：领域请求 + MCP 调用。排除
// ldap/log/tail（面板自身的读通道，记它只会刷屏）。
func shouldLogRequest(method string) bool {
	if method == "ldap/log/tail" {
		return false
	}
	return strings.HasPrefix(method, "ldap/") || strings.HasPrefix(method, "mcp/")
}

func (h *pluginHandler) dispatch(method string, params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	switch method {
	case "connection/test":
		return h.connectionTest(params)
	case "connection/connect":
		return h.connectionConnect(params)
	case "connection/disconnect":
		return h.connectionDisconnect(params)

	case "ldap/search":
		return h.forwardSearch(params)
	case "ldap/search/start":
		return h.forwardSearchStart(params)
	case "ldap/search/next":
		return h.forwardSearchNext(params)
	case "ldap/search/cancel":
		return h.forwardSearchCancel(params)
	case "ldap/count":
		return h.forwardCount(params)
	case "ldap/entry/get":
		return h.forwardGetEntry(params)
	case "ldap/rootDse":
		return h.forwardRootDSE(params)
	case "ldap/schema":
		return h.forwardSchema(params)
	case "ldap/check":
		return h.forwardCheck(params)
	case "ldap/entry/add":
		return h.forwardAddEntry(params)
	case "ldap/entry/modify":
		return h.forwardModifyEntry(params)
	case "ldap/entry/delete":
		return h.forwardDeleteEntry(params)
	case "ldap/entry/childrenCount":
		return h.forwardChildrenCount(params)
	case "ldap/entry/modifyDn":
		return h.forwardModifyDN(params)
	case "ldap/entry/compare":
		return h.forwardCompare(params)
	case "ldap/whoami":
		return h.forwardWhoAmI(params)
	case "ldap/entry/passwdModify":
		return h.forwardPasswordModify(params)
	case "ldap/connections/statuses":
		return h.forwardStatuses()
	case "ldap/log/tail":
		return h.logTail(params)
	case "ldap/presets/list":
		return h.forwardPresetsList()
	case "ldap/presets/save":
		return h.forwardPresetsSave(params)
	case "ldap/presets/remove":
		return h.forwardPresetsRemove(params)

	case "ldap/ui/state/report":
		return h.uiStateReport(params)

	case "mcp/tools":
		return h.mcpTools(params)
	case "mcp/call":
		return h.mcpCall(params)
	case "mcp/settings/get":
		return h.mcpSrv.SettingsGet(), nil
	case "mcp/settings/set":
		return h.mcpSettingsSet(params)

	default:
		return nil, dbxpluginsdk.MethodNotFound(method)
	}
}

// --- 生命周期方法（§5.1） ---

func (h *pluginHandler) connectionTest(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	parsed, err := lifecycle.Parse(params)
	if err != nil {
		return nil, invalidParams(err)
	}
	message, err := h.svc.Test(getContext(), parsed)
	if err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"success": true, "message": message}, nil
}

func (h *pluginHandler) connectionConnect(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	parsed, err := lifecycle.Parse(params)
	if err != nil {
		return nil, invalidParams(err)
	}
	if err := h.svc.Connect(parsed); err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"success": true}, nil
}

func (h *pluginHandler) connectionDisconnect(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	parsed, err := lifecycle.Parse(params)
	if err != nil {
		return nil, invalidParams(err)
	}
	id := parsed.ConnectionID()
	if id == "" {
		return nil, dbxpluginsdk.NewError(-32602, "Missing connection id")
	}
	h.svc.Disconnect(id)
	return map[string]any{"success": true}, nil
}

// --- 领域方法转发（方法体由 L-B 实现；转发与返回包络在此定型） ---

func (h *pluginHandler) forwardSearch(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPSearchRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	result, err := h.svc.Search(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

func (h *pluginHandler) forwardSearchStart(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPSearchSessionRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	result, err := h.svc.SearchStart(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

func (h *pluginHandler) forwardSearchNext(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPSearchSessionNextRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	result, err := h.svc.SearchNext(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

func (h *pluginHandler) forwardSearchCancel(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPSearchSessionCancelRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	if err := h.svc.SearchCancel(getContext(), req); err != nil {
		return nil, bizError(err)
	}
	return map[string]bool{"success": true}, nil
}

func (h *pluginHandler) forwardCount(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPCountRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	result, err := h.svc.Count(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

func (h *pluginHandler) forwardGetEntry(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPGetEntryRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	entry, err := h.svc.GetEntry(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"entry": entry}, nil
}

func (h *pluginHandler) forwardRootDSE(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPRootDSERequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	entry, err := h.svc.RootDSE(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"attributes": entry.Attributes}, nil
}

func (h *pluginHandler) forwardSchema(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPSchemaMetadataRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	metadata, err := h.svc.SchemaMetadata(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return metadata, nil
}

// forwardCheck 处理 ldap/check（连接分级检查：network 全新短拨号测延迟 +
// bind 既有会话探活，实现见 ldapconn/check.go）。检查只读、无副作用：不
// 建连、不发审计；网络不通/会话失效等结果在 ok/network/bind 包络内表达，
// 仅未知 connectionId、非法 level 等入口错误走业务错误。
func (h *pluginHandler) forwardCheck(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPCheckRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	result, err := h.svc.Check(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

func (h *pluginHandler) forwardAddEntry(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPAddEntryRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	if err := h.svc.AddEntry(getContext(), req); err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"success": true}, nil
}

func (h *pluginHandler) forwardModifyEntry(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPModifyEntryRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	if err := h.svc.ModifyEntry(getContext(), req); err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"success": true}, nil
}

func (h *pluginHandler) forwardDeleteEntry(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPDeleteEntryRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	if err := h.svc.DeleteEntry(getContext(), req); err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"success": true}, nil
}

func (h *pluginHandler) forwardChildrenCount(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPChildrenCountRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	result, err := h.svc.ChildrenCount(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

func (h *pluginHandler) forwardModifyDN(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPModifyDNRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	if err := h.svc.ModifyDN(getContext(), req); err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"success": true}, nil
}

// forwardCompare 处理 ldap/entry/compare（F3，读路径）：门禁/审计在 Service
// 层完成，这里只转发。
func (h *pluginHandler) forwardCompare(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPCompareRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	result, err := h.svc.Compare(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

// forwardWhoAmI 处理 ldap/whoami（F3，读路径）。
func (h *pluginHandler) forwardWhoAmI(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPWhoAmIRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	result, err := h.svc.WhoAmI(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

// forwardPasswordModify 处理 ldap/entry/passwdModify（F3，写路径）：read_only
// 门禁与审计在 Service 层完成，handler 只转发。
func (h *pluginHandler) forwardPasswordModify(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req ldapconn.LDAPPasswordModifyRequest
	if perr := decodeParams(params, &req); perr != nil {
		return nil, perr
	}
	result, err := h.svc.PasswordModify(getContext(), req)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

func (h *pluginHandler) forwardStatuses() (any, *dbxpluginsdk.PluginError) {
	statuses, err := h.svc.ConnectionStatuses()
	if err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"statuses": statuses}, nil
}

func (h *pluginHandler) forwardPresetsList() (any, *dbxpluginsdk.PluginError) {
	presets, err := h.svc.ListPresets()
	if err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"presets": presets}, nil
}

func (h *pluginHandler) forwardPresetsSave(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var body struct {
		Preset ldapconn.LDAPSearchPreset `json:"preset"`
	}
	if err := json.Unmarshal(params, &body); err != nil {
		return nil, invalidParams(err)
	}
	preset, err := h.svc.SavePreset(body.Preset)
	if err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"success": true, "preset": preset}, nil
}

func (h *pluginHandler) forwardPresetsRemove(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var body struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(params, &body); err != nil {
		return nil, invalidParams(err)
	}
	if body.ID == "" {
		return nil, dbxpluginsdk.NewError(-32602, "Missing preset id")
	}
	if err := h.svc.RemovePreset(body.ID); err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"success": true}, nil
}

// --- MCP 工具面（M1，internal/mcp） ---

// uiStateReport 处理 ldap/ui/state/report（前端回调）：带 intentId 回报
// intent 终态；无 intentId 为快照型（sidecar 缓存最新快照）。
func (h *pluginHandler) uiStateReport(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var body map[string]any
	if err := json.Unmarshal(params, &body); err != nil {
		return nil, invalidParams(err)
	}
	if err := h.mcpSrv.ReportUIState(body); err != nil {
		return nil, bizError(err)
	}
	return map[string]any{"success": true}, nil
}

// mcpTools 处理 mcp/tools（DBX MCP 桥工具发现）：可选 connectionId，只读
// 连接不进写工具清单（设计 §4）。
func (h *pluginHandler) mcpTools(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var body struct {
		ConnectionID string `json:"connectionId"`
	}
	_ = json.Unmarshal(params, &body)
	return h.mcpSrv.Tools(strings.TrimSpace(body.ConnectionID)), nil
}

// mcpCall 处理 mcp/call（DBX MCP 桥 dbx_call_plugin_tool）：注册 lifecycle
// payload（凭据由宿主转发，参数不携带）→ 分派工具。响应统一 MCP content
// 信封（对齐 ssh mcp/call）。
func (h *pluginHandler) mcpCall(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var body struct {
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
		Lifecycle json.RawMessage `json:"lifecycle"`
	}
	if err := json.Unmarshal(params, &body); err != nil {
		return nil, invalidParams(err)
	}
	if strings.TrimSpace(body.Tool) == "" {
		return nil, dbxpluginsdk.NewError(-32602, "Missing tool")
	}
	// 桥转发附带 lifecycle payload：注册/刷新连接配置（幂等覆盖），之后工具
	// 调用只引用 connectionId。解析失败即拒绝（不静默丢凭据上下文）。
	if len(body.Lifecycle) > 0 {
		parsed, err := lifecycle.Parse(body.Lifecycle)
		if err != nil {
			return nil, invalidParams(err)
		}
		if err := h.svc.Connect(parsed); err != nil {
			return nil, bizError(err)
		}
	}
	var arguments map[string]any
	if len(body.Arguments) > 0 {
		if err := json.Unmarshal(body.Arguments, &arguments); err != nil {
			return nil, invalidParams(err)
		}
	}
	result, err := h.mcpSrv.Call(strings.TrimSpace(body.Tool), arguments)
	if err != nil {
		return nil, bizError(err)
	}
	payload, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		return nil, dbxpluginsdk.NewError(-32603, marshalErr.Error())
	}
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": string(payload)}},
		"isError": false,
	}, nil
}

// mcpSettingsSet 处理 mcp/settings/set（白名单部分更新 + 持久化）。
func (h *pluginHandler) mcpSettingsSet(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var body map[string]any
	if err := json.Unmarshal(params, &body); err != nil {
		return nil, invalidParams(err)
	}
	result, err := h.mcpSrv.SettingsSet(body)
	if err != nil {
		return nil, bizError(err)
	}
	return result, nil
}

// --- 审计、日志与公共 helper ---

// emitEvent 经当前 Emitter 下发事件（audit/log/intent 共用；Serve 期间单例，
// 持锁读取）。nil Emitter（未握手/已退出）静默跳过。
func (h *pluginHandler) emitEvent(method string, params any) {
	h.mu.Lock()
	emitter := h.emitter
	h.mu.Unlock()
	if emitter == nil {
		return
	}
	if err := emitter.Event(method, params); err != nil {
		log.Printf("[dbx-plugin-ldap] %s event failed: %v", method, err)
	}
}

// auditRecord 是 ldapconn.Service.Audit 回调：audit.jsonl 落盘 +
// ldap/audit 事件（§5.3，供工作台轻提示；两条通道携带同一份非敏感数据；
// rec.Target 只含 DN，不含属性值；rec.Source=="mcp" 标记 MCP 写路径）。
func (h *pluginHandler) auditRecord(rec ldapconn.AuditRecord) {
	if h.st != nil {
		if err := h.st.AppendAudit(store.AuditRecord{
			ConnectionID: rec.ConnectionID,
			Action:       auditAction(rec.Action),
			Target:       rec.Target,
			Result:       auditResultForStore(rec.Result),
			Source:       rec.Source,
			Operation:    rec.Operation,
			DurationMs:   rec.DurationMs,
			Detail:       rec.Detail,
		}); err != nil {
			log.Printf("[dbx-plugin-ldap] audit write failed: %v", err)
		}
	}
	h.emitEvent("ldap/audit", rec)
}

// logRecord 是 ldapconn.Service.Log 回调（连接生命周期）：logbuf 环形缓冲 +
// ldap/log 事件，两条通道同一份非敏感数据。h.logs 为 nil（零值 handler，
// 单测直接构造）时静默跳过。
func (h *pluginHandler) logRecord(entry logbuf.Entry) {
	if h.logs == nil {
		return
	}
	h.emitEvent("ldap/log", h.logs.Append(entry))
}

// logRequest 是 Handle 计时装饰器的落笔端：请求摘要 → 环形缓冲 + ldap/log
// 事件。结果只有 ok/error 两值——read/write-policy 拒绝的 denied 语义由
// audit 通道承载（插件请求被拒也会以 error 冒泡到这里，两通道互补）。
func (h *pluginHandler) logRequest(method string, params json.RawMessage, perr *dbxpluginsdk.PluginError, elapsed time.Duration) {
	if h.logs == nil {
		return
	}
	connectionID, target, detail := requestSummary(method, params)
	source := "ui"
	if strings.HasPrefix(method, "mcp/") {
		source = "mcp"
	}
	entry := logbuf.Entry{
		Level:        "info",
		Method:       method,
		ConnectionID: connectionID,
		Target:       target,
		Detail:       detail,
		Result:       "ok",
		DurationMs:   elapsed.Milliseconds(),
		Source:       source,
	}
	if perr != nil {
		entry.Level = "error"
		entry.Result = "error"
		entry.Detail = truncateRunes(joinNotEmpty(entry.Detail, perr.Message), 300)
	}
	h.logRecord(entry)
}

// requestSummary 从请求参数提取非敏感摘要，白名单字段之外一律不看——
// passwdModify 的密码、add/modify 的属性值等敏感键绝不进入日志（凭据不进
// 日志/事件/审计的红线）；mcp/call 只取 tool 名，arguments 任意形状不碰。
// 参数非扁平 JSON（connection/test 的 lifecycle 等）时解析失败按空摘要处理。
func requestSummary(method string, params json.RawMessage) (connectionID, target, detail string) {
	var flat struct {
		ConnectionID string `json:"connectionId"`
		DN           string `json:"dn"`
		BaseDN       string `json:"baseDn"`
		Filter       string `json:"filter"`
		Scope        string `json:"scope"`
		Tool         string `json:"tool"`
	}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &flat)
	}
	if flat.DN != "" {
		target = truncateRunes(flat.DN, 200)
	} else {
		target = truncateRunes(flat.BaseDN, 200)
	}
	var parts []string
	if flat.Scope != "" {
		parts = append(parts, "scope="+flat.Scope)
	}
	if flat.Filter != "" {
		parts = append(parts, "filter="+truncateRunes(flat.Filter, 200))
	}
	if flat.Tool != "" {
		parts = append(parts, "tool="+flat.Tool)
	}
	return flat.ConnectionID, target, joinNotEmpty(parts...)
}

// logTail 处理 ldap/log/tail：返回 seq > after 的缓冲增量（日志面板打开/
// 重开时回填，limit<=0 取缓冲容量）。全局视图，不经 decodeParams 的
// connectionId 门（同 ldap/connections/statuses）。
func (h *pluginHandler) logTail(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var body struct {
		After uint64 `json:"after"`
		Limit int    `json:"limit"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &body); err != nil {
			return nil, invalidParams(err)
		}
	}
	entries := []logbuf.Entry{}
	if h.logs != nil {
		entries = h.logs.Tail(body.After, body.Limit)
	}
	return map[string]any{"entries": entries}, nil
}

// truncateRunes 按 rune 截断到 max 并以省略号标注（DN/filter 可能含非 ASCII）。
func truncateRunes(s string, max int) string {
	runes := []rune(strings.TrimSpace(s))
	if len(runes) <= max {
		return string(runes)
	}
	return string(runes[:max]) + "…"
}

// joinNotEmpty 拼接非空片段（"; " 分隔），全空返回空串。
func joinNotEmpty(parts ...string) string {
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "; ")
}

// auditAction 统一审计 action 命名（ldap/<action>）。
func auditAction(action string) string {
	if strings.HasPrefix(action, "ldap/") {
		return action
	}
	return "ldap/" + action
}

// auditResultForStore 把内部 result（success|blocked|error）折算为
// audit.jsonl 的 ok|denied|error（M0 §4 格式，对齐 ssh-sftp）。
func auditResultForStore(result string) string {
	switch result {
	case "success":
		return "ok"
	case "blocked":
		return "denied"
	default:
		return result
	}
}

// decodeParams 解析领域方法参数并校验必填 connectionId
// （ldap/connections/statuses 为全局视图，不经此函数）。
func decodeParams(params json.RawMessage, out any) *dbxpluginsdk.PluginError {
	if err := json.Unmarshal(params, out); err != nil {
		return invalidParams(err)
	}
	var holder struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := json.Unmarshal(params, &holder); err == nil && holder.ConnectionID == "" {
		return dbxpluginsdk.NewError(-32602, "Missing connectionId")
	}
	return nil
}

func invalidParams(err error) *dbxpluginsdk.PluginError {
	return dbxpluginsdk.NewError(-32602, err.Error())
}

// bizErrorLdapReferralURIsLimit 错误前缀里最多携带的引用 URI 数（完整列表
// 在搜索响应 referrals 字段里，前缀只保证错误可见即可分辨）。
const bizErrorLdapReferralURIsLimit = 5

// bizError 业务错误统一 -32000（对齐 ssh-sftp to_plugin_error）。
// 错误携带 go-ldap 结果码时，message 前缀 "[ldap-code=<十进制>]"
// （matchedDN 非空再追加 " [ldap-matched=<DN>]"；结果码 10（Referral）再
// 追加 " [ldap-referral=<URI|URI|…>]"，最多 5 条），与前端
// frontend/src/lib/ldapErrors.ts 的 parseLdapErrorMeta 构成契约；
// 原始错误串完整保留，既有文本正则仍可命中。无元数据时行为不变。
func bizError(err error) *dbxpluginsdk.PluginError {
	msg := err.Error()
	if code, matchedDN, ok := ldapconn.LdapErrorMeta(err); ok {
		var prefix strings.Builder
		prefix.WriteString("[ldap-code=")
		prefix.WriteString(strconv.Itoa(code))
		prefix.WriteString("]")
		if matchedDN != "" {
			prefix.WriteString(" [ldap-matched=")
			prefix.WriteString(matchedDN)
			prefix.WriteString("]")
		}
		if uris := ldapconn.LdapReferralURIs(err); len(uris) > 0 {
			if len(uris) > bizErrorLdapReferralURIsLimit {
				uris = uris[:bizErrorLdapReferralURIsLimit]
			}
			prefix.WriteString(" [ldap-referral=")
			prefix.WriteString(strings.Join(uris, "|"))
			prefix.WriteString("]")
		}
		msg = prefix.String() + msg
	}
	return dbxpluginsdk.NewError(-32000, msg)
}

// getContext 返回请求级 context（jsonl SDK 无 ctx 传递，超时由
// ldapconn.contextWithTimeout 按连接配置控制）。
func getContext() context.Context {
	return context.Background()
}

// presetStore 把 store.Store 适配为 ldapconn.PresetStore（presets.json 全量
// 读写；预设明文、不含凭据）。
type presetStore struct {
	st *store.Store
}

func newPresetStore(st *store.Store) ldapconn.PresetStore {
	if st == nil {
		return nil
	}
	return &presetStore{st: st}
}

func (p *presetStore) LoadPresets() ([]ldapconn.LDAPSearchPreset, error) {
	var doc struct {
		Presets []ldapconn.LDAPSearchPreset `json:"presets"`
	}
	exists, err := p.st.LoadJSON("presets.json", &doc)
	if err != nil {
		return nil, err
	}
	if !exists || doc.Presets == nil {
		return []ldapconn.LDAPSearchPreset{}, nil
	}
	return doc.Presets, nil
}

func (p *presetStore) SavePresets(presets []ldapconn.LDAPSearchPreset) error {
	if presets == nil {
		presets = []ldapconn.LDAPSearchPreset{}
	}
	return p.st.SaveJSON("presets.json", map[string]any{"presets": presets})
}
