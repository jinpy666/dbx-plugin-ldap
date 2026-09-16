// @vitest-environment happy-dom
// fileSave unit tests: exports must land in a user-chosen path + filename.
// Tier order under test: host fileTransfer.beginSave (native save dialog) →
// File System Access showSaveFilePicker (browser/mock) → legacy <a download>.
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveTextFile } from "./fileSave";

interface FileTransferRecorder {
    api: {
        beginSave: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
        finish: ReturnType<typeof vi.fn>;
        cancel: ReturnType<typeof vi.fn>;
    };
    beginSaveArgs: Array<Record<string, unknown>>;
    writes: Array<{ offset: number; bytes: number }>;
    finished: number;
    cancelled: number;
}

function installFileTransfer(options?: { chunkBytes?: number; beginSaveError?: unknown; writeError?: unknown }): FileTransferRecorder {
    const recorder: FileTransferRecorder = {
        api: {
            beginSave: vi.fn(),
            write: vi.fn(),
            finish: vi.fn(),
            cancel: vi.fn(async () => undefined),
        },
        beginSaveArgs: [],
        writes: [],
        finished: 0,
        cancelled: 0,
    };
    recorder.api.beginSave.mockImplementation(async (opts: Record<string, unknown>) => {
        recorder.beginSaveArgs.push(opts);
        if (options?.beginSaveError !== undefined) throw options.beginSaveError;
        return { handleId: "handle-1", chunkBytes: options?.chunkBytes ?? 0 };
    });
    recorder.api.write.mockImplementation(async (_handleId: string, offset: number, data: Uint8Array) => {
        recorder.writes.push({ offset, bytes: data.byteLength });
        if (options?.writeError !== undefined) throw options.writeError;
        return { written: data.byteLength, nextOffset: offset + data.byteLength };
    });
    recorder.api.finish.mockImplementation(async () => {
        recorder.finished += 1;
    });
    recorder.api.cancel.mockImplementation(async () => {
        recorder.cancelled += 1;
    });
    (window as unknown as { dbxPlugin: unknown }).dbxPlugin = { fileTransfer: recorder.api };
    return recorder;
}

function installShowSaveFilePicker(overrides?: { pickError?: unknown; writeError?: unknown; name?: string }) {
    const calls = { writes: [] as Array<number>, closed: 0, picked: 0 };
    const handle = {
        name: overrides?.name,
        createWritable: async () => ({
            write: async (data: Uint8Array) => {
                calls.writes.push(data.byteLength);
                if (overrides?.writeError !== undefined) throw overrides.writeError;
            },
            close: async () => {
                calls.closed += 1;
            },
        }),
    };
    vi.stubGlobal(
        "showSaveFilePicker",
        vi.fn(async () => {
            calls.picked += 1;
            if (overrides?.pickError !== undefined) throw overrides.pickError;
            return handle;
        }),
    );
    return calls;
}

function installLegacyDownload() {
    const calls = { clicks: 0, downloads: [] as string[], revoked: 0 };
    vi.stubGlobal("URL", {
        createObjectURL: vi.fn(() => "blob:mock"),
        revokeObjectURL: vi.fn(() => {
            calls.revoked += 1;
        }),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
        calls.clicks += 1;
        calls.downloads.push(this.download);
    });
    return calls;
}

const PAYLOAD_TEXT = "0123456789"; // 10 bytes in UTF-8

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as unknown as { dbxPlugin?: unknown }).dbxPlugin;
});

describe("saveTextFile", () => {
    it("saves through the host fileTransfer bridge in chunks and reports the filename", async () => {
        const recorder = installFileTransfer({ chunkBytes: 4 });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "search.ldif", contentType: "text/plain", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "saved", name: "search.ldif", via: "host" });
        expect(recorder.beginSaveArgs).toEqual([{ name: "search.ldif", contentType: "text/plain", size: 10 }]);
        expect(recorder.writes).toEqual([
            { offset: 0, bytes: 4 },
            { offset: 4, bytes: 4 },
            { offset: 8, bytes: 2 },
        ]);
        expect(recorder.finished).toBe(1);
        expect(recorder.cancelled).toBe(0);
        expect(legacy.clicks).toBe(0);
    });

    it("writes the whole payload in one call when the host reports no chunkBytes", async () => {
        const recorder = installFileTransfer();

        const outcome = await saveTextFile({ name: "a.csv", contentType: "text/csv", text: PAYLOAD_TEXT });

        expect(outcome.status).toBe("saved");
        expect(recorder.writes).toEqual([{ offset: 0, bytes: 10 }]);
        expect(recorder.finished).toBe(1);
    });

    it("treats a host dialog cancel as a silent cancellation without falling back", async () => {
        const recorder = installFileTransfer({ beginSaveError: new Error("user cancelled the save dialog") });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "a.json", contentType: "application/json", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "cancelled", name: "a.json", via: "host" });
        // beginSave 失败时尚无句柄，没有可取消的目标。
        expect(recorder.cancelled).toBe(0);
        expect(legacy.clicks).toBe(0);
    });

    it("cancels the host handle when a chunk write fails mid-save", async () => {
        const recorder = installFileTransfer({ chunkBytes: 4, writeError: new Error("disk error") });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "a.json", contentType: "application/json", text: PAYLOAD_TEXT });

        expect(recorder.cancelled).toBe(1);
        expect(recorder.finished).toBe(0);
        expect(outcome.status).toBe("saved");
        expect(outcome.via).toBe("legacy");
        expect(legacy.clicks).toBe(1);
    });

    it("falls back to the File System Access picker when the host bridge fails outright", async () => {
        const recorder = installFileTransfer({ beginSaveError: new Error("bridge exploded") });
        const picker = installShowSaveFilePicker({ name: "renamed.ldif" });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "ldap-search.ldif", contentType: "text/plain", text: PAYLOAD_TEXT });

        expect(recorder.cancelled).toBe(0);
        expect(picker.picked).toBe(1);
        expect(picker.closed).toBe(1);
        expect(legacy.clicks).toBe(0);
        expect(outcome).toEqual({ status: "saved", name: "renamed.ldif", via: "browser" });
    });

    it("saves through showSaveFilePicker when no host bridge exists", async () => {
        const picker = installShowSaveFilePicker({ name: "picked.csv" });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "ldap-search.csv", contentType: "text/csv", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "saved", name: "picked.csv", via: "browser" });
        expect(picker.writes).toEqual([10]);
        expect(legacy.clicks).toBe(0);
    });

    it("opens the picker before yielding to preserve the export button gesture", async () => {
        const picker = installShowSaveFilePicker({ name: "picked.csv" });

        const pending = saveTextFile({ name: "ldap-search.csv", contentType: "text/csv", text: PAYLOAD_TEXT });

        // Chromium requires showSaveFilePicker to be called in the same task
        // as the trusted click. A regression that awaits host detection first
        // leaves this at zero and falls back to an anonymous download.
        expect(picker.picked).toBe(1);
        await expect(pending).resolves.toEqual({ status: "saved", name: "picked.csv", via: "browser" });
    });

    it("treats a picker AbortError as a silent cancellation without legacy download", async () => {
        const picker = installShowSaveFilePicker({ pickError: new DOMException("user aborted", "AbortError") });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "a.ldif", contentType: "text/plain", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "cancelled", name: "a.ldif", via: "browser" });
        expect(picker.picked).toBe(1);
        expect(legacy.clicks).toBe(0);
    });

    it("falls back to a legacy anchor download when no save dialog is available", async () => {
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "root-dse.txt", contentType: "text/plain", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "saved", name: "root-dse.txt", via: "legacy" });
        expect(legacy.clicks).toBe(1);
        expect(legacy.downloads).toEqual(["root-dse.txt"]);
        expect(legacy.revoked).toBeGreaterThanOrEqual(0);
    });

    it("falls back to legacy when the picker write fails after selection", async () => {
        installShowSaveFilePicker({ writeError: new Error("disk full") });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "a.ldif", contentType: "text/plain", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "saved", name: "a.ldif", via: "legacy" });
        expect(legacy.clicks).toBe(1);
    });
});
