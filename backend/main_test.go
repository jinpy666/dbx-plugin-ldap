package main

// main_test.go：入口互斥的纯逻辑（--mcp 标志识别；true 时 main 提前进入
// stdio MCP 服务器分支，不装配 SDK Server/Emitter）与 ldap/check 桥层
// 参数门（envelope/检查语义在 internal/ldapconn check_test.go 覆盖）。

import (
	"encoding/json"
	"testing"

	"io.dbx.ldap.plugin/internal/ldapconn"
)

func TestMcpStdioRequested(t *testing.T) {
	cases := []struct {
		args []string
		want bool
	}{
		{args: []string{"--mcp"}, want: true},
		{args: []string{"--mcp", "--other"}, want: true},
		{args: []string{"--other", "--mcp"}, want: true},
		{args: []string{"--mcp=false"}, want: false},
		{args: []string{"-mcp"}, want: false},
		{args: []string{"--verbose"}, want: false},
		{args: nil, want: false},
	}
	for _, testCase := range cases {
		if got := mcpStdioRequested(testCase.args); got != testCase.want {
			t.Errorf("mcpStdioRequested(%v) = %v, want %v", testCase.args, got, testCase.want)
		}
	}
}

// TestForwardCheckParamGates：ldap/check 桥层错误分级——connectionId 缺失
// 是参数错误（-32602）；未知 connectionId / 非法 level 是业务错误（-32000），
// 二者都不产出检查包络。
func TestForwardCheckParamGates(t *testing.T) {
	handler := &pluginHandler{svc: ldapconn.NewService()}

	if _, perr := handler.forwardCheck(json.RawMessage(`{"level":"network"}`)); perr == nil || perr.Code != -32602 {
		t.Fatalf("missing connectionId perr = %v, want code -32602", perr)
	}
	if _, perr := handler.forwardCheck(json.RawMessage(`{"connectionId":"nope"}`)); perr == nil || perr.Code != -32000 {
		t.Fatalf("unknown connectionId perr = %v, want code -32000", perr)
	}
	if _, perr := handler.forwardCheck(json.RawMessage(`{"connectionId":"nope","level":"trace"}`)); perr == nil || perr.Code != -32000 {
		t.Fatalf("invalid level perr = %v, want code -32000", perr)
	}
}
