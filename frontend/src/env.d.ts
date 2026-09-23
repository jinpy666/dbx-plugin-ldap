interface DbxPluginBinaryEvent {
  channel: string;
  /** 当前宿主桥投递零拷贝字节；旧桥（Host API 1.0）投递 base64 字符串。 */
  data?: Uint8Array;
  dataBase64?: string;
}

interface DbxPluginBackendEvent {
  type?: "event";
  method: string;
  params: Record<string, unknown>;
}

// Current bridges also send environment updates through onEvent (no method/params).
type DbxPluginEvent = DbxPluginBackendEvent | { type: "env"; locale?: string; theme?: DbxPluginTheme };

interface DbxPluginTheme {
  appearance: "light" | "dark";
  /** 宿主根节点解析后的设计令牌（--color-* / --radius-* / --font-*），Host API 1.0 无此字段。 */
  tokens: Record<string, string>;
}

/**
 * `<domain>/ui/intent` 事件载荷（M1 MCP UI intent 通道；sidecar `mcp/call`
 * 经 emitter 下发，shared/frontend/uiIntent 消费并回报
 * `<domain>/ui/state/report`）。
 */
interface DbxPluginUiIntentEvent {
  intentId: string;
  action: string;
  params?: Record<string, unknown>;
}

/** `<domain>/ui/state/report` 的请求体（intent 回报或快照型）。 */
interface DbxPluginUiStateReport {
  intentId?: string;
  status: "applied" | "rejected" | "snapshot";
  summary?: {
    count?: number;
    truncated?: boolean;
    rows?: Array<Record<string, unknown>>;
    anchor?: string;
    reason?: string;
  };
}

interface DbxPluginAppearance {
  colorScheme: "light" | "dark";
  colors: {
    background: string;
    foreground: string;
    muted: string;
    mutedForeground: string;
    accent: string;
    accentForeground: string;
    border: string;
    destructive: string;
  };
  terminal: { fontFamily: string; fontSize: number };
  ui?: { fontFamily: string };
}

interface DbxPluginApi {
  ready: Promise<Record<string, unknown>>;
  readonly context?: Record<string, unknown>;
  readonly appearance?: DbxPluginAppearance;
  readonly theme?: DbxPluginTheme;
  readonly locale: string;
  /** 宿主能力位（Host API 1.2 起）；storage 缺失表示该宿主无持久化桥。 */
  readonly capabilities?: { storage?: boolean };
  /** 持久化 UI 状态桥（单值 256 KiB / 总量 1 MiB）；配 capabilities.storage 使用，经 shared/frontend/pluginStorage 读写。 */
  readonly storage?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  invoke<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  sendBinary(channel: string, data: Uint8Array | ArrayBuffer | string): Promise<void>;
  onEvent(listener: (event: DbxPluginEvent) => void): () => void;
  onBinary(listener: (event: DbxPluginBinaryEvent) => void): () => void;
  onAppearanceChange?(listener: (appearance: DbxPluginAppearance) => void): () => void;
  onLocaleChange?(listener: (locale: string) => void): () => void;
  onContext?(listener: (context: Record<string, unknown>) => void): () => void;
  /** Legacy optional callback; current bridges use onContext. */
  onContextChange?(listener: (context: Record<string, unknown>) => void): () => void;
  decodeBase64(value: string): Uint8Array;
  encodeBase64(value: Uint8Array | ArrayBuffer): string;
  /**
   * 宿主原生另存为对话框（host.saveFile）：宿主侧落盘，沙箱 iframe 无法
   * 触发下载。用户取消 resolve null；DBX desktop ≥0.2.111 起提供，旧桥为
   * undefined。
   */
  readonly saveFile?: (options: { fileName?: string; contentType?: string }, data: Uint8Array | ArrayBuffer | string) => Promise<{ path: string } | null>;
  readonly workbenchState?: { set(state: Record<string, unknown>): Promise<void> };
  readonly clipboard?: { readText(): Promise<string>; writeText(text: string): Promise<void> };
}

interface DbxSaveFileHandle {
  readonly name?: string;
  createWritable(): Promise<{
    write(data: Uint8Array | ArrayBuffer): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface Window {
  dbxPlugin: DbxPluginApi;
  /** File System Access API：无宿主桥的浏览器/mock 环境也能选目录+文件名。 */
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<DbxSaveFileHandle>;
}
