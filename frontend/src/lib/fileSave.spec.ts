// @vitest-environment happy-dom
// fileSave unit tests: exports must land in a user-chosen path + filename.
// Tier order under test: host dbxPlugin.saveFile（host.saveFile 原生另存为）→
// File System Access showSaveFilePicker (browser/mock) → legacy <a download>.
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveBinaryFile, saveTextFile } from "./fileSave";

type SaveFileFn = (options: { fileName?: string; contentType?: string }, data: Uint8Array) => Promise<{ path: string } | null>;

interface HostSaveRecorder {
    saveFile: ReturnType<typeof vi.fn>;
    payloads: Array<{ options: Record<string, unknown>; bytes: Uint8Array }>;
    cancelled: number;
}

function installHostSave(options?: { result?: { path: string } | null; error?: unknown }): HostSaveRecorder {
    const recorder: HostSaveRecorder = {
        saveFile: vi.fn(),
        payloads: [],
        cancelled: 0,
    };
    recorder.saveFile.mockImplementation(async (opts: Record<string, unknown>, bytes: Uint8Array) => {
        recorder.payloads.push({ options: opts, bytes });
        if (options?.error !== undefined) throw options.error;
        return options?.result !== undefined ? options.result : { path: `/Users/demo/Downloads/${opts.fileName as string}` };
    });
    (window as unknown as { dbxPlugin: unknown }).dbxPlugin = { saveFile: recorder.saveFile };
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
    const calls = { clicks: 0, downloads: [] as string[], types: [] as string[] };
    vi.stubGlobal("URL", {
        createObjectURL: vi.fn((blob: Blob) => {
            calls.types.push(blob.type);
            return "blob:mock";
        }),
        revokeObjectURL: vi.fn(() => undefined),
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
    it("saves through the host saveFile bridge and reports the confirmed filename", async () => {
        const host = installHostSave({ result: { path: "/Users/demo/Docs/renamed.ldif" } });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "search.ldif", contentType: "text/plain", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "saved", name: "renamed.ldif", via: "host" });
        expect(host.payloads).toHaveLength(1);
        expect(host.payloads[0].options).toEqual({ fileName: "search.ldif", contentType: "text/plain;charset=utf-8" });
        expect(new TextDecoder().decode(host.payloads[0].bytes)).toBe(PAYLOAD_TEXT);
        expect(legacy.clicks).toBe(0);
    });

    it("treats a null host result (dialog cancel) as a silent cancellation without falling back", async () => {
        const host = installHostSave({ result: null });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "a.json", contentType: "application/json", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "cancelled", name: "a.json", via: "host" });
        expect(legacy.clicks).toBe(0);
    });

    it("falls back to the File System Access picker when the host bridge fails outright", async () => {
        installHostSave({ error: new Error("bridge exploded") });
        const picker = installShowSaveFilePicker({ name: "renamed.ldif" });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "ldap-search.ldif", contentType: "text/plain", text: PAYLOAD_TEXT });

        expect(picker.picked).toBe(1);
        expect(picker.closed).toBe(1);
        expect(legacy.clicks).toBe(0);
        expect(outcome).toEqual({ status: "saved", name: "renamed.ldif", via: "browser" });
    });

    it("saves through showSaveFilePicker when the host bridge has no saveFile (older host / mock)", async () => {
        (window as unknown as { dbxPlugin: unknown }).dbxPlugin = {};
        const picker = installShowSaveFilePicker({ name: "picked.csv" });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "ldap-search.csv", contentType: "text/csv", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "saved", name: "picked.csv", via: "browser" });
        expect(picker.writes).toEqual([10]);
        expect(legacy.clicks).toBe(0);
    });

    it("opens the picker before yielding to preserve the export button gesture", async () => {
        (window as unknown as { dbxPlugin: unknown }).dbxPlugin = {};
        const picker = installShowSaveFilePicker({ name: "picked.csv" });

        const pending = saveTextFile({ name: "ldap-search.csv", contentType: "text/csv", text: PAYLOAD_TEXT });

        // Chromium requires showSaveFilePicker to be called in the same task
        // as the trusted click. A regression that awaits host detection first
        // leaves this at zero and falls back to an anonymous download.
        expect(picker.picked).toBe(1);
        await expect(pending).resolves.toEqual({ status: "saved", name: "picked.csv", via: "browser" });
    });

    it("treats a picker AbortError as a silent cancellation without legacy download", async () => {
        (window as unknown as { dbxPlugin: unknown }).dbxPlugin = {};
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
    });

    it("falls back to legacy when the picker write fails after selection", async () => {
        (window as unknown as { dbxPlugin: unknown }).dbxPlugin = {};
        installShowSaveFilePicker({ writeError: new Error("disk full") });
        const legacy = installLegacyDownload();

        const outcome = await saveTextFile({ name: "a.ldif", contentType: "text/plain", text: PAYLOAD_TEXT });

        expect(outcome).toEqual({ status: "saved", name: "a.ldif", via: "legacy" });
        expect(legacy.clicks).toBe(1);
    });
});

describe("saveBinaryFile", () => {
    it("hands raw bytes to the host save dialog untouched", async () => {
        const host = installHostSave({ result: { path: "/tmp/photo-1.jpg" } });
        const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0x01]);

        const outcome = await saveBinaryFile({ name: "jpegPhoto-1.jpg", contentType: "image/jpeg", bytes });

        expect(outcome).toEqual({ status: "saved", name: "photo-1.jpg", via: "host" });
        expect(host.payloads[0].options).toEqual({ fileName: "jpegPhoto-1.jpg", contentType: "image/jpeg" });
        expect(host.payloads[0].bytes).toEqual(bytes);
    });

    it("falls back to a legacy blob download with the binary mime type", async () => {
        const legacy = installLegacyDownload();

        const outcome = await saveBinaryFile({ name: "jpegPhoto-1.jpg", contentType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) });

        expect(outcome).toEqual({ status: "saved", name: "jpegPhoto-1.jpg", via: "legacy" });
        expect(legacy.types).toEqual(["image/jpeg"]);
        expect(legacy.downloads).toEqual(["jpegPhoto-1.jpg"]);
    });
});
