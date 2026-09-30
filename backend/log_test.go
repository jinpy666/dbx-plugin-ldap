package main

// log_test.go：请求日志装饰器（Handle → logRequest → logbuf + 事件）与
// ldap/log/tail 的门禁与摘要红线。Emitter 全程 nil：事件通道静默跳过，
// 只断言缓冲内容。

import (
	"encoding/json"
	"strings"
	"testing"

	dbxpluginsdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"

	"io.dbx.ldap.plugin/internal/ldapconn"
	"io.dbx.ldap.plugin/internal/logbuf"
)

func TestShouldLogRequest(t *testing.T) {
	cases := []struct {
		method string
		want   bool
	}{
		{"ldap/search", true},
		{"ldap/entry/passwdModify", true},
		{"mcp/call", true},
		{"ldap/log/tail", false},
		{"connection/test", false},
		{"connection/connect", false},
		{"ldap/ui/state/report", true},
	}
	for _, testCase := range cases {
		if got := shouldLogRequest(testCase.method); got != testCase.want {
			t.Errorf("shouldLogRequest(%q) = %v, want %v", testCase.method, got, testCase.want)
		}
	}
}

// TestRequestSummaryRedactsSensitiveKeys：白名单之外的字段（密码、属性值、
// 任意扩展键）绝不进入摘要；mcp/call 只取 tool 名。
func TestRequestSummaryRedactsSensitiveKeys(t *testing.T) {
	params := json.RawMessage(`{"connectionId":"c1","dn":"ou=people,dc=x","filter":"(cn=alice)","scope":"sub","newPassword":"s3cret","userPassword":"s3cret"}`)
	connectionID, target, detail := requestSummary("ldap/entry/modify", params)
	if connectionID != "c1" || target != "ou=people,dc=x" {
		t.Fatalf("summary = (%q, %q)", connectionID, target)
	}
	if !strings.Contains(detail, "scope=sub") || !strings.Contains(detail, "filter=(cn=alice)") {
		t.Fatalf("detail missing scope/filter: %q", detail)
	}
	if strings.Contains(detail, "s3cret") {
		t.Fatalf("detail leaked secret: %q", detail)
	}
	_, toolTarget, toolDetail := requestSummary("mcp/call", json.RawMessage(`{"tool":"ldap_search","arguments":{"password":"s3cret"}}`))
	if toolTarget != "" || toolDetail != "tool=ldap_search" {
		t.Fatalf("mcp summary = (%q, %q)", toolTarget, toolDetail)
	}
}

// TestHandleLogsRequestsAndTail：ldap/* 请求 ok/error 都落缓冲；tail 返回
// 增量且 tail 自身不入缓冲；connection/* 不入缓冲。
func TestHandleLogsRequestsAndTail(t *testing.T) {
	handler := &pluginHandler{svc: ldapconn.NewService(), logs: logbuf.New(16)}
	noopEmitter := (*dbxpluginsdk.Emitter)(nil)

	// 业务失败（未知 connectionId）→ error 条目。
	if _, perr := handler.Handle(dbxpluginsdk.RequestContext{}, "ldap/search", json.RawMessage(`{"connectionId":"nope","filter":"(objectClass=*)"}`), noopEmitter); perr == nil {
		t.Fatal("ldap/search unknown connectionId should fail")
	}
	// connection/* 不记。
	_, _ = handler.Handle(dbxpluginsdk.RequestContext{}, "connection/disconnect", json.RawMessage(`{"connectionId":"nope"}`), noopEmitter)
	// tail 自身不记，且返回首条 error 条目。
	result, perr := handler.Handle(dbxpluginsdk.RequestContext{}, "ldap/log/tail", json.RawMessage(`{"after":0}`), noopEmitter)
	if perr != nil {
		t.Fatalf("ldap/log/tail failed: %v", perr)
	}
	payload, _ := json.Marshal(result)
	var body struct {
		Entries []logbuf.Entry `json:"entries"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("tail payload: %v", err)
	}
	if len(body.Entries) != 1 {
		t.Fatalf("tail entries = %d, want 1 (only the failed ldap/search)", len(body.Entries))
	}
	entry := body.Entries[0]
	if entry.Method != "ldap/search" || entry.Result != "error" || entry.Level != "error" {
		t.Fatalf("logged entry = %+v", entry)
	}
	if entry.DurationMs < 0 || entry.Source != "ui" {
		t.Fatalf("logged entry meta = %+v", entry)
	}
	// after 游标：无新增时返回空。
	result, _ = handler.Handle(dbxpluginsdk.RequestContext{}, "ldap/log/tail", json.RawMessage(`{"after":1}`), noopEmitter)
	payload, _ = json.Marshal(result)
	_ = json.Unmarshal(payload, &body)
	if len(body.Entries) != 0 {
		t.Fatalf("tail(after=1) entries = %d, want 0", len(body.Entries))
	}
}

// TestLogRecordNilBufferSafe：零值 handler（单测直接构造）的生命周期回调
// 与装饰器不得 panic。
func TestLogRecordNilBufferSafe(t *testing.T) {
	handler := &pluginHandler{svc: ldapconn.NewService()}
	handler.logRecord(logbuf.Entry{Method: "connect", Result: "ok"})
	if _, perr := handler.Handle(dbxpluginsdk.RequestContext{}, "ldap/search", json.RawMessage(`{"connectionId":"nope"}`), nil); perr == nil {
		t.Fatal("ldap/search unknown connectionId should fail")
	}
}
