// 导出落盘：三级回退，目标都是"用户自己选目录和文件名"，解决 Blob 匿名
// 下载"下载完找不到文件"的问题。
// 1. 宿主桥 fileTransfer.beginSave（optional 1.1 特性）：宿主原生另存为
//    对话框（与 SSH 插件下载链路同一写法），分块 write → finish，失败 cancel。
// 2. showSaveFilePicker（File System Access API）：mock / 浏览器等无宿主桥
//    的 Chromium 环境仍能选路径+文件名。
// 3. Blob <a download>：旧桥兜底，行为同旧 downloadText，但通过返回的 via
//    让调用方明确提示"进了浏览器默认下载目录"。
// 用户主动取消对话框（AbortError / cancel 语义错误）返回 cancelled，调用方
// 静默收场，不弹错误也不偷偷换通道落盘。

export type SaveTextVia = "host" | "browser" | "legacy";

export type SaveTextOutcome =
    | { status: "saved"; name: string; via: SaveTextVia }
    | { status: "cancelled"; name: string; via: SaveTextVia };

export interface SaveTextOptions {
    name: string;
    contentType: string;
    text: string;
}

const textEncoder = new TextEncoder();

const isCancelCause = (cause: unknown): boolean => {
    if (cause instanceof DOMException) return cause.name === "AbortError";
    const message = cause instanceof Error ? cause.message : String(cause ?? "");
    return /cancel|abort/i.test(message);
};

async function saveViaHost(name: string, contentType: string, bytes: Uint8Array): Promise<SaveTextOutcome | undefined> {
    const fileTransfer = window.dbxPlugin?.fileTransfer;
    if (!fileTransfer) return undefined;
    let handleId = "";
    try {
        const target = await fileTransfer.beginSave({ name, contentType, size: bytes.byteLength });
        handleId = target.handleId;
        const chunkBytes = Number(target.chunkBytes) > 0 ? Number(target.chunkBytes) : bytes.byteLength;
        let offset = 0;
        while (offset < bytes.byteLength) {
            const end = Math.min(offset + chunkBytes, bytes.byteLength);
            const write = await fileTransfer.write(handleId, offset, bytes.subarray(offset, end));
            offset = typeof write?.nextOffset === "number" ? write.nextOffset : end;
        }
        await fileTransfer.finish(handleId);
        return { status: "saved", name, via: "host" };
    } catch (cause) {
        if (handleId) await fileTransfer.cancel(handleId).catch(() => undefined);
        if (isCancelCause(cause)) return { status: "cancelled", name, via: "host" };
        // 桥损坏等真实故障 → 交给下一级通道，保证导出仍然发生。
        return undefined;
    }
}

async function saveViaFileSystemAccess(name: string, bytes: Uint8Array): Promise<SaveTextOutcome | undefined> {
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

function saveViaLegacyDownload(name: string, contentType: string, text: string): SaveTextOutcome {
    const blob = new Blob([text], { type: `${contentType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { status: "saved", name, via: "legacy" };
}

export async function saveTextFile(options: SaveTextOptions): Promise<SaveTextOutcome> {
    const { name, contentType, text } = options;
    const bytes = textEncoder.encode(text);

    // `showSaveFilePicker()` must be invoked while the export button's user
    // gesture is still active. Do not first await the optional host bridge in
    // browser-only mode: that extra turn makes Chromium reject the picker
    // with NotAllowedError and silently sends the file to the default
    // download folder instead.
    if (!window.dbxPlugin?.fileTransfer && typeof window.showSaveFilePicker === "function") {
        const viaPicker = await saveViaFileSystemAccess(name, bytes);
        if (viaPicker) return viaPicker;
    }

    const viaHost = await saveViaHost(name, contentType, bytes);
    if (viaHost) return viaHost;
    const viaPicker = await saveViaFileSystemAccess(name, bytes);
    if (viaPicker) return viaPicker;
    return saveViaLegacyDownload(name, contentType, text);
}
