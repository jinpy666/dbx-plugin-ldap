package mcp

// tools_schema_test.go：tools/list 输出的 schema 形状红线（严格 MCP 宿主
// 兼容轮）。Go nil 切片会序列化成 "required":null，zcode 的 tools/list
// zod 校验直接拒收整个服务器（2026-09-14 真机接入实测：stdio 连接失败，
// 错误 "Invalid result for tools/list: expected array, received null"）。

import (
	"encoding/json"
	"strings"
	"testing"

	"io.dbx.ldap.plugin/internal/ldapconn"
)

// 全量与只读两种清单都不得出现 "required":null；required 空时键必须缺席。
func TestToolDefinitionsNeverMarshalRequiredNull(t *testing.T) {
	server := NewServer(ldapconn.NewService(), nil)
	for _, scope := range []string{"", "no-such-connection"} {
		raw, err := json.Marshal(server.Tools(scope))
		if err != nil {
			t.Fatalf("marshal tools(%q): %v", scope, err)
		}
		if strings.Contains(string(raw), `"required":null`) {
			t.Fatalf("tools(%q) contains required:null (strict MCP hosts reject the server): %s", scope, raw)
		}
	}
}

// 审查 H2：searchDigest 代码接受的 sizeLimit 必须在 ldap_search_digest 的
// inputSchema 正式声明——严格宿主会丢弃未声明参数，宽松宿主照传，同一个
// 参数两种命运（"代码接受但 schema 未声明"双态）。
func TestSearchDigestSchemaDeclaresSizeLimit(t *testing.T) {
	server := NewServer(ldapconn.NewService(), nil)
	for _, tool := range server.Tools("")["tools"].([]map[string]any) {
		if tool["name"] != "ldap_search_digest" {
			continue
		}
		schema := tool["inputSchema"].(map[string]any)
		properties := schema["properties"].(map[string]any)
		sizeLimit, ok := properties["sizeLimit"].(map[string]any)
		if !ok {
			t.Fatalf("ldap_search_digest schema must declare sizeLimit; properties = %v", properties)
		}
		if sizeLimit["type"] != "integer" {
			t.Errorf("sizeLimit.type = %v, want integer", sizeLimit["type"])
		}
		return
	}
	t.Fatal("ldap_search_digest not found in tool list")
}
