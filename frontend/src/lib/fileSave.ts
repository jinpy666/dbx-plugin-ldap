// 导出落盘：三级回退，目标都是"用户自己选目录和文件名"，解决 Blob 匿名
// 下载"下载完找不到文件"的问题。
// 1. 宿主桥 dbxPlugin.saveFile（host.saveFile）：宿主原生另存为对话框 +
//    宿主侧落盘（沙箱 iframe 无法触发下载，WKWebView 会取消 blob 导航），
//    用户取消时 resolve null。DBX desktop ≥0.2.111 起提供。
// 2. showSaveFilePicker（File System Access API）：mock / 浏览器等无宿主
//    保存桥的 Chromium 环境仍能选路径+文件名。
// 3. Blob <a download>：最后兜底，但通过返回的 via 让调用方明确提示
//    "进了浏览器默认下载目录"。
// 宿主返回 null 或选择器 AbortError 视为用户主动取消：返回 cancelled，
// 调用方静默收场，不弹错误也不偷偷换通道落盘。

export type SaveVia = "host" | "browser" | "legacy";

export type SaveFileOutcome = {
    status: "saved" | "cancelled";
    name: string;
    via: SaveVia;
};

/** 兼容旧名：文本导出的返回类型与二进制导出一致。 */
export type SaveTextOutcome = SaveFileOutcome;

export interface SaveTextOptions {
    name: string;
    contentType: string;
    text: string;
}

export interface SaveBinaryOptions {
    name: string;
    contentType: string;
    bytes: Uint8Array;
}

type HostSaveFile = (options: { fileName?: string; contentType?: string }, data: Uint8Array) => Promise<{ path: string } | null>;

const textEncoder = new TextEncoder();

const isCancelCause = (cause: unknown): boolean => {
    if (cause instanceof DOMException) return cause.name === "AbortError";
    const message = cause instanceof Error ? cause.message : String(cause ?? "");
    return /cancel|abort/i.test(message);
};

function hostSaveFile(): HostSaveFile | undefined {
    const candidate = (window.dbxPlugin as unknown as { saveFile?: HostSaveFile } | undefined)?.saveFile;
    return typeof candidate === "function" ? candidate : undefined;
}

/** 宿主确认的落盘名：对话框里用户可能改名，取返回路径末段回显。 */
function basenameOf(path: string | undefined, fallback: string): string {
    const base = typeof path === "string" && path ? path.split(/[\\/]/).pop() || "" : "";
    return base || fallback;
}

async function saveViaHost(name: string, contentType: string, bytes: Uint8Array): Promise<SaveFileOutcome | undefined> {
    const saveFile = hostSaveFile();
    if (!saveFile) return undefined;
    try {
        const result = await saveFile({ fileName: name, contentType }, bytes);
        if (result === null) return { status: "cancelled", name, via: "host" };
        return { status: "saved", name: basenameOf(result?.path, name), via: "host" };
    } catch {
        // 桥损坏等真实故障 → 交给下一级通道，保证导出仍然发生。
        return undefined;
    }
}

async function saveViaFileSystemAccess(name: string, bytes: Uint8Array): Promise<SaveFileOutcome | undefined> {
    const picker = window.showSaveFilePicker;
    if (typeof picker !== "function") return undefined;
    let handle: DbxSaveFileHandle;
    try {
        handle = await picker({ suggestedName: name });
    } catch (cause) {
        if (isCancelCause(cause)) return { status: "cancelled", name, via: "browser" };
        return undefined;
    }
    try {
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        const chosen = typeof handle.name === "string" && handle.name ? handle.name : name;
        return { status: "saved", name: chosen, via: "browser" };
    } catch {
        // 对话框已选但写入失败 → 走兜底下载，至少导出不丢。
        return undefined;
    }
}

function saveViaLegacyDownload(name: string, blobType: string, bytes: Uint8Array): SaveFileOutcome {
    // new Uint8Array(bytes) 复制进独立 ArrayBuffer：BlobPart 不接受 ArrayBufferLike 视图。
    const blob = new Blob([new Uint8Array(bytes)], { type: blobType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { status: "saved", name, via: "legacy" };
}

async function saveBytes(name: string, contentType: string, bytes: Uint8Array): Promise<SaveFileOutcome> {
    // `showSaveFilePicker()` must be invoked while the export button's user
    // gesture is still active. Do not first await the optional host bridge in
    // browser-only mode: that extra turn makes Chromium reject the picker
    // with NotAllowedError and silently sends the file to the default
    // download folder instead.
    if (!hostSaveFile() && typeof window.showSaveFilePicker === "function") {
        const viaPicker = await saveViaFileSystemAccess(name, bytes);
        if (viaPicker) return viaPicker;
    }

    const viaHost = await saveViaHost(name, contentType, bytes);
    if (viaHost) return viaHost;
    const viaPicker = await saveViaFileSystemAccess(name, bytes);
    if (viaPicker) return viaPicker;
    return saveViaLegacyDownload(name, contentType, bytes);
}

export function saveTextFile(options: SaveTextOptions): Promise<SaveFileOutcome> {
    return saveBytes(options.name, `${options.contentType};charset=utf-8`, textEncoder.encode(options.text));
}

export function saveBinaryFile(options: SaveBinaryOptions): Promise<SaveFileOutcome> {
    return saveBytes(options.name, options.contentType || "application/octet-stream", options.bytes);
}
