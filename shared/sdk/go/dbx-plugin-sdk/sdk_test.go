package dbxpluginsdk

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func TestServerInitializesAndDispatches(t *testing.T) {
	input := bytes.NewBufferString(
		"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"plugin/initialize\",\"params\":{\"host\":{\"protocolVersions\":[1]}}}\n" +
			"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"sample/ping\",\"params\":{\"name\":\"DBX\"}}\n",
	)
	var output bytes.Buffer
	server := NewServer(
		Metadata{ID: "sample.plugin", Version: "1.0.0", Capabilities: []string{"commands"}},
		HandlerFunc(func(_ RequestContext, method string, _ json.RawMessage, _ *Emitter) (any, *PluginError) {
			if method != "sample/ping" {
				return nil, MethodNotFound(method)
			}
			return map[string]any{"ok": true}, nil
		}),
	).WithIO(input, &output, &bytes.Buffer{})
	if err := server.Serve(); err != nil {
		t.Fatal(err)
	}
	var responses []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'}) {
		var response map[string]any
		if err := json.Unmarshal(line, &response); err != nil {
			t.Fatal(err)
		}
		responses = append(responses, response)
	}
	if len(responses) != 2 {
		t.Fatalf("expected 2 responses, got %d", len(responses))
	}
	initialize := responses[0]["result"].(map[string]any)
	if initialize["protocolVersion"] != float64(ProtocolVersion) {
		t.Fatalf("unexpected initialize response: %#v", initialize)
	}
	pong := responses[1]["result"].(map[string]any)
	if pong["ok"] != true {
		t.Fatalf("unexpected handler response: %#v", pong)
	}
}

func TestEmitterWritesEvents(t *testing.T) {
	var output bytes.Buffer
	emitter := &Emitter{writer: &output, mutex: &sync.Mutex{}}
	if pluginError := emitter.Event("sample/progress", map[string]any{"value": 1}); pluginError != nil {
		t.Fatal(pluginError.Message)
	}
	var event map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &event); err != nil {
		t.Fatal(err)
	}
	if event["method"] != "sample/progress" {
		t.Fatalf("unexpected event: %#v", event)
	}
}

// handler panic 不得杀死插件进程：Serve 必须存活，先回 -32603（带原 id），
// 后续请求照常服务。
func TestServerHandlerPanicRecovers(t *testing.T) {
	input := bytes.NewBufferString(
		"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sample/boom\",\"params\":null}\n" +
			"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"sample/ping\",\"params\":null}\n",
	)
	var output bytes.Buffer
	server := NewServer(
		Metadata{ID: "sample.plugin", Version: "1.0.0", Capabilities: []string{"commands"}},
		HandlerFunc(func(_ RequestContext, method string, _ json.RawMessage, _ *Emitter) (any, *PluginError) {
			if method == "sample/boom" {
				panic("handler exploded")
			}
			return map[string]any{"ok": true}, nil
		}),
	).WithIO(input, &output, &bytes.Buffer{})
	if err := server.Serve(); err != nil {
		t.Fatalf("serve must survive handler panic: %v", err)
	}
	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'})
	if len(lines) != 2 {
		t.Fatalf("expected 2 responses, got %d: %s", len(lines), output.String())
	}
	// 并发 goroutine 下响应顺序不保证，按 id 匹配。
	byID := map[string]map[string]any{}
	for _, line := range lines {
		var response map[string]any
		if err := json.Unmarshal(line, &response); err != nil {
			t.Fatal(err)
		}
		id, _ := json.Marshal(response["id"])
		byID[string(id)] = response
	}
	first, ok := byID["1"]
	if !ok {
		t.Fatalf("missing response for id 1: %s", output.String())
	}
	errFrame, _ := first["error"].(map[string]any)
	if errFrame == nil || errFrame["code"] != float64(-32603) {
		t.Fatalf("panic must yield -32603, got: %#v", first)
	}
	second, ok := byID["2"]
	if !ok {
		t.Fatalf("missing response for id 2: %s", output.String())
	}
	if _, ok := second["result"].(map[string]any); !ok {
		t.Fatalf("next request after panic must be served, got: %#v", second)
	}
}

// 单行超过 maxJSONBytes：跳过该行继续服务，Serve 不因 ErrTooLong 终止
// （对照 stdio.go 的同款「拒绝该行、进程存活」语义）。
func TestServerSkipsOversizedLineAndContinues(t *testing.T) {
	oversized := strings.Repeat("x", maxJSONBytes+16)
	input := bytes.NewBufferString(oversized + "\n" +
		"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"sample/ping\",\"params\":null}\n")
	var output bytes.Buffer
	server := NewServer(
		Metadata{ID: "sample.plugin", Version: "1.0.0", Capabilities: []string{"commands"}},
		HandlerFunc(func(_ RequestContext, method string, _ json.RawMessage, _ *Emitter) (any, *PluginError) {
			return map[string]any{"ok": true}, nil
		}),
	).WithIO(input, &output, &bytes.Buffer{})
	if err := server.Serve(); err != nil {
		t.Fatalf("serve must skip oversized line and continue, got: %v", err)
	}
	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'})
	if len(lines) != 1 {
		t.Fatalf("expected 1 response, got %d", len(lines))
	}
	var response map[string]any
	if err := json.Unmarshal(lines[0], &response); err != nil {
		t.Fatal(err)
	}
	if id, _ := json.Marshal(response["id"]); string(id) != "3" {
		t.Fatalf("request after oversized line must be served, got: %#v", response)
	}
}
