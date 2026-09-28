package dbxpluginsdk

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

const ProtocolVersion = 1

const maxJSONBytes = 8 * 1024 * 1024

type Metadata struct {
	ID           string
	Version      string
	Capabilities []string
}

type RequestContext struct {
	RequestID json.RawMessage
	Driver    string
}

type PluginError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func NewError(code int, message string) *PluginError {
	return &PluginError{Code: code, Message: message}
}

func MethodNotFound(method string) *PluginError {
	return NewError(-32601, fmt.Sprintf("Method not found: %s", method))
}

type Handler interface {
	Handle(context RequestContext, method string, params json.RawMessage, emitter *Emitter) (any, *PluginError)
}

type HandlerFunc func(context RequestContext, method string, params json.RawMessage, emitter *Emitter) (any, *PluginError)

func (handler HandlerFunc) Handle(
	context RequestContext,
	method string,
	params json.RawMessage,
	emitter *Emitter,
) (any, *PluginError) {
	return handler(context, method, params, emitter)
}

type Emitter struct {
	writer io.Writer
	mutex  *sync.Mutex
}

func (emitter *Emitter) Event(method string, params any) *PluginError {
	if !validProtocolName(method) {
		return NewError(-32600, "Invalid event method")
	}
	return emitter.write(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func (emitter *Emitter) respond(id json.RawMessage, result any, pluginError *PluginError) *PluginError {
	response := map[string]any{"jsonrpc": "2.0", "id": id}
	if pluginError != nil {
		response["error"] = pluginError
	} else {
		response["result"] = result
	}
	return emitter.write(response)
}

func (emitter *Emitter) write(value any) *PluginError {
	payload, err := json.Marshal(value)
	if err != nil {
		return NewError(-32603, err.Error())
	}
	if len(payload) > maxJSONBytes {
		return NewError(-32600, "JSON message is too large")
	}
	emitter.mutex.Lock()
	defer emitter.mutex.Unlock()
	if _, err := emitter.writer.Write(append(payload, '\n')); err != nil {
		return NewError(-32000, err.Error())
	}
	return nil
}

type Server struct {
	metadata Metadata
	handler  Handler
	input    io.Reader
	output   io.Writer
	errors   io.Writer
}

func NewServer(metadata Metadata, handler Handler) *Server {
	return &Server{
		metadata: metadata,
		handler:  handler,
		input:    os.Stdin,
		output:   os.Stdout,
		errors:   os.Stderr,
	}
}

func (server *Server) WithIO(input io.Reader, output io.Writer, errorsWriter io.Writer) *Server {
	server.input = input
	server.output = output
	server.errors = errorsWriter
	return server
}

func (server *Server) Serve() error {
	if server.handler == nil {
		return errors.New("plugin handler is required")
	}
	if !validProtocolName(server.metadata.ID) {
		return errors.New("plugin id is invalid")
	}
	emitter := &Emitter{writer: server.output, mutex: &sync.Mutex{}}
	// 单一 bufio.Reader 贯穿整个 Serve：跳过超长行后重建 Scanner 时，reader
	// 缓冲里已预读的后续请求字节不丢（临时 reader 的预读会随对象被丢弃）。
	reader := bufio.NewReader(server.input)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), maxJSONBytes)
	var workers sync.WaitGroup
	for {
		for scanner.Scan() {
			payload := bytes.TrimSpace(scanner.Bytes())
			if len(payload) == 0 {
				continue
			}
			request, err := decodeRequest(payload)
			if err != nil {
				fmt.Fprintf(server.errors, "[dbx-plugin-sdk-go] %v\n", err)
				continue
			}
			if request.Method == "plugin/initialize" {
				if len(request.ID) == 0 {
					fmt.Fprintln(server.errors, "[dbx-plugin-sdk-go] plugin/initialize must be a request")
					continue
				}
				result, pluginError := server.initialize(request.Params)
				if writeError := emitter.respond(request.ID, result, pluginError); writeError != nil {
					return errors.New(writeError.Message)
				}
				continue
			}
			workers.Add(1)
			go func(request protocolRequest) {
				defer workers.Done()
				// handler panic 不得杀死插件进程（全连接被拆）：恢复后回
				// -32603 并继续服务后续请求。
				defer func() {
					if r := recover(); r != nil {
						fmt.Fprintf(server.errors, "[dbx-plugin-sdk-go] recovered handler panic: %v\n", r)
						if len(request.ID) > 0 {
							_ = emitter.respond(request.ID, nil, NewError(-32603, fmt.Sprintf("Internal error: %v", r)))
						}
					}
				}()
				result, pluginError := server.handler.Handle(
					RequestContext{RequestID: request.ID, Driver: request.Driver},
					request.Method,
					request.Params,
					emitter,
				)
				if len(request.ID) == 0 {
					if pluginError != nil {
						fmt.Fprintf(server.errors, "[dbx-plugin-sdk-go] %s\n", pluginError.Message)
					}
					return
				}
				if writeError := emitter.respond(request.ID, result, pluginError); writeError != nil {
					fmt.Fprintf(server.errors, "[dbx-plugin-sdk-go] failed to write response: %s\n", writeError.Message)
				}
			}(request)
		}
		err := scanner.Err()
		if err == nil {
			break
		}
		if errors.Is(err, bufio.ErrTooLong) {
			// 单行超限：跳过该行剩余部分后重建 Scanner 继续服务（对照
			// mcp/stdio.go 的「拒绝该行、进程存活」语义），宿主侧失控
			// 输出不再拆掉插件。
			fmt.Fprintf(server.errors, "[dbx-plugin-sdk-go] request line exceeds %d bytes; line skipped\n", maxJSONBytes)
			if skipErr := skipRemainderOfLine(reader); skipErr != nil {
				break
			}
			scanner = bufio.NewScanner(reader)
			scanner.Buffer(make([]byte, 64*1024), maxJSONBytes)
			continue
		}
		return err
	}
	workers.Wait()
	return nil
}

// skipRemainderOfLine 丢弃超长行的剩余字节（到换行为止）。必须在贯穿 Serve
// 的同一 bufio.Reader 上执行：Scanner 在 ErrTooLong 时已把行前缀读进自身
// 缓冲，行尾仍留在 input 中；reader 的预读由重建的 Scanner 继续消费。
func skipRemainderOfLine(reader *bufio.Reader) error {
	_, err := reader.ReadString('\n')
	return err
}

func (server *Server) initialize(params json.RawMessage) (any, *PluginError) {
	var request struct {
		Host struct {
			ProtocolVersions []int `json:"protocolVersions"`
		} `json:"host"`
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, NewError(-32602, "Invalid initialize parameters")
	}
	for _, version := range request.Host.ProtocolVersions {
		if version == ProtocolVersion {
			return map[string]any{
				"protocolVersion": ProtocolVersion,
				"capabilities":    server.metadata.Capabilities,
				"plugin": map[string]string{
					"id":      server.metadata.ID,
					"version": server.metadata.Version,
				},
			}, nil
		}
	}
	return nil, NewError(-32001, "DBX and plugin do not share a protocol version")
}

type protocolRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Driver  string          `json:"driver"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func decodeRequest(payload []byte) (protocolRequest, error) {
	var request protocolRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return request, err
	}
	if request.JSONRPC != "2.0" {
		return request, errors.New("request does not declare jsonrpc 2.0")
	}
	if !validProtocolName(request.Method) {
		return request, errors.New("request method is invalid")
	}
	if len(request.Params) == 0 {
		request.Params = json.RawMessage("null")
	}
	return request, nil
}

func validProtocolName(value string) bool {
	if len(value) == 0 || len(value) > 256 {
		return false
	}
	for index, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' {
			continue
		}
		if index > 0 && (character == '.' || character == '_' || character == ':' || character == '/' || character == '-') {
			continue
		}
		return false
	}
	return true
}
