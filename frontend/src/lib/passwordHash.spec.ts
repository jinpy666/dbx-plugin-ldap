// passwordHash unit tests (M6 N2): known vectors built with node:crypto
// (never hard-coded by hand), parse round-trips for every supported scheme
// and plaintext passthrough, plus random-password length/alphabet checks.
// MD5/crypt are intentionally absent — unsupported by decision (see lib head).
// node:crypto is the reference implementation; Buffer stays out of scope
// (frontend tsconfig has no node types), so bytes travel as Uint8Array.
// @ts-expect-error node builtin module has no types under types:["vite/client"]; runtime is vitest's node env
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    PASSWORD_SCHEMES,
    generateRandomPassword,
    hashPassword,
    parsePasswordHash,
    verifyPasswordHash,
    type PasswordScheme,
} from "./passwordHash";

const fromBase64 = (value: string): Uint8Array => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

/** Build the expected RFC 2307 storage string with node:crypto (reference implementation). */
const expectedHash = (plain: string, algorithm: "sha1" | "sha256" | "sha512", salt?: Uint8Array): string => {
    const hash = createHash(algorithm).update(plain, "utf8");
    if (!salt) return hash.digest("base64");
    const digest = new Uint8Array(hash.update(salt).digest());
    const combined = new Uint8Array(digest.length + salt.length);
    combined.set(digest, 0);
    combined.set(salt, digest.length);
    return btoa(String.fromCharCode(...combined));
};

describe("hashPassword", () => {
    it("matches the known unsalted vector for {SHA} on \"password\"", async () => {
        // RFC 2307 classic vector: sha1("password") base64.
        expect(await hashPassword("password", "{SHA}")).toBe("{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=");
        // Cross-checked against node:crypto so the vector is not hand-written.
        expect(await hashPassword("password", "{SHA}")).toBe(`{SHA}${expectedHash("password", "sha1")}`);
    });

    it("matches node:crypto vectors for {SHA256} and {SHA512}", async () => {
        expect(await hashPassword("password", "{SHA256}")).toBe(`{SHA256}${expectedHash("password", "sha256")}`);
        expect(await hashPassword("password", "{SHA512}")).toBe(`{SHA512}${expectedHash("password", "sha512")}`);
        expect(await hashPassword("", "{SHA256}")).toBe(`{SHA256}${expectedHash("", "sha256")}`);
    });

    it("appends a fresh 16-byte salt for {SSHA} that survives parse + re-hash verification", async () => {
        const stored = await hashPassword("password", "{SSHA}");
        const parsed = parsePasswordHash(stored);
        expect(parsed?.scheme).toBe("{SSHA}");
        // Salted digest = sha1(plain ‖ salt): derive the salt from the stored
        // blob tail and rebuild with node:crypto instead of a fixed string.
        const payload = fromBase64(parsed!.params!);
        expect(payload.length).toBe(20 + 16);
        const salt = payload.subarray(20);
        expect(stored).toBe(`{SSHA}${expectedHash("password", "sha1", salt)}`);
        expect(await verifyPasswordHash("password", stored)).toBe(true);
        expect(await verifyPasswordHash("Password", stored)).toBe(false);
    });

    it("salted schemes produce a different blob per call (random salt)", async () => {
        const first = await hashPassword("password", "{SSHA256}");
        const second = await hashPassword("password", "{SSHA256}");
        expect(first).not.toBe(second);
        const payload = fromBase64(parsePasswordHash(first)!.params!);
        expect(payload.length).toBe(32 + 16);
        expect(first.startsWith("{SSHA256}")).toBe(true);
    });

    it("{SSHA512} round-trips against node:crypto and verifyPasswordHash", async () => {
        const stored = await hashPassword("p@ss wörd", "{SSHA512}");
        const payload = fromBase64(parsePasswordHash(stored)!.params!);
        expect(payload.length).toBe(64 + 16);
        const salt = payload.subarray(64);
        expect(stored).toBe(`{SSHA512}${expectedHash("p@ss wörd", "sha512", salt)}`);
        expect(await verifyPasswordHash("p@ss wörd", stored)).toBe(true);
        expect(await verifyPasswordHash("p@ss word", stored)).toBe(false);
    });

    it("passes {CLEARTEXT} through unchanged (including empty strings)", async () => {
        expect(await hashPassword("secret", "{CLEARTEXT}")).toBe("secret");
        expect(await hashPassword("", "{CLEARTEXT}")).toBe("");
        expect(await hashPassword("  spaced  ", "{CLEARTEXT}")).toBe("  spaced  ");
    });

    it("covers every declared scheme without dropping one", async () => {
        expect(PASSWORD_SCHEMES).toHaveLength(7);
        for (const scheme of PASSWORD_SCHEMES) {
            const stored = await hashPassword("password", scheme);
            if (scheme === "{CLEARTEXT}") expect(stored).toBe("password");
            else expect(parsePasswordHash(stored)?.scheme).toBe(scheme);
        }
    });
});

// 非安全上下文模拟:DBX 宿主的插件 webview 常以局域网 HTTP 打开,此时
// crypto.subtle 为 undefined;部分引擎(Gecko 风格)则保留 subtle 但调用
// 即抛 SecurityError("The operation is insecure.")。两种形态都要兜底。
type CryptoHost = { subtle?: unknown };

const hideSubtle = (): (() => void) => {
    const host = globalThis.crypto as unknown as CryptoHost;
    const descriptor =
        Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle") ??
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), "subtle");
    Object.defineProperty(host, "subtle", { configurable: true, value: undefined });
    return () => {
        if (descriptor) Object.defineProperty(globalThis.crypto, "subtle", { ...descriptor, configurable: true });
        else delete (globalThis.crypto as unknown as CryptoHost).subtle;
    };
};

describe("hashPassword / verifyPasswordHash 在 crypto.subtle 不可用时(非安全上下文兜底)", () => {
    let restoreSubtle: (() => void) | undefined;

    beforeEach(() => {
        restoreSubtle = hideSubtle();
    });

    afterEach(() => {
        restoreSubtle?.();
        restoreSubtle = undefined;
    });

    it("unsalted 方案仍与 node:crypto 向量完全一致", async () => {
        expect(await hashPassword("password", "{SHA}")).toBe(`{SHA}${expectedHash("password", "sha1")}`);
        expect(await hashPassword("password", "{SHA256}")).toBe(`{SHA256}${expectedHash("password", "sha256")}`);
        expect(await hashPassword("password", "{SHA512}")).toBe(`{SHA512}${expectedHash("password", "sha512")}`);
    });

    it("salted 方案以 node:crypto 按存储盐重建,且 verifyPasswordHash 正确往返", async () => {
        const cases = [
            ["{SSHA}", "sha1", 20],
            ["{SSHA256}", "sha256", 32],
            ["{SSHA512}", "sha512", 64],
        ] as const;
        for (const [scheme, algorithm, digestLength] of cases) {
            const stored = await hashPassword("password", scheme);
            const payload = fromBase64(parsePasswordHash(stored)!.params!);
            expect(payload.length).toBe(digestLength + 16);
            const salt = payload.subarray(digestLength);
            expect(stored).toBe(`${scheme}${expectedHash("password", algorithm, salt)}`);
            expect(await verifyPasswordHash("password", stored)).toBe(true);
            expect(await verifyPasswordHash("Pass word", stored)).toBe(false);
        }
    });

    it("跨块与多字节输入(>256 字节、CJK/emoji)仍与 node:crypto 一致", async () => {
        const longPlain = "x".repeat(200) + "密码+☕";
        expect(await hashPassword(longPlain, "{SHA}")).toBe(`{SHA}${expectedHash(longPlain, "sha1")}`);
        expect(await hashPassword(longPlain, "{SHA256}")).toBe(`{SHA256}${expectedHash(longPlain, "sha256")}`);
        expect(await hashPassword(longPlain, "{SHA512}")).toBe(`{SHA512}${expectedHash(longPlain, "sha512")}`);
    });

    it("subtle 存在但 digest 抛 SecurityError(Gecko 风格)时同样回退", async () => {
        const host = globalThis.crypto as unknown as CryptoHost;
        Object.defineProperty(host, "subtle", {
            configurable: true,
            value: { digest: () => Promise.reject(new DOMException("The operation is insecure.", "SecurityError")) },
        });
        expect(await hashPassword("password", "{SHA}")).toBe(`{SHA}${expectedHash("password", "sha1")}`);
        expect(await verifyPasswordHash("password", "{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=")).toBe(true);
    });
});

describe("parsePasswordHash", () => {
    const schemeCases: PasswordScheme[] = ["{SSHA}", "{SSHA256}", "{SSHA512}", "{SHA}", "{SHA256}", "{SHA512}"];

    it("recognises every supported hash scheme prefix", () => {
        for (const scheme of schemeCases) {
            const stored = `${scheme}cGF5bG9hZA==`;
            expect(parsePasswordHash(stored)).toEqual({ scheme, params: stored.slice(scheme.length) });
        }
    });

    it("is case-insensitive on the scheme label", () => {
        expect(parsePasswordHash("{ssha}abc=")).toEqual({ scheme: "{SSHA}", params: "abc=" });
        expect(parsePasswordHash("{Ssha512}x==")).toEqual({ scheme: "{SSHA512}", params: "x==" });
    });

    it("treats prefix-less non-empty values as plaintext", () => {
        expect(parsePasswordHash("plain-secret")).toEqual({ scheme: "{CLEARTEXT}" });
        expect(parsePasswordHash("  plain-secret  ")).toEqual({ scheme: "{CLEARTEXT}" });
        expect(parsePasswordHash("{CLEARTEXT}plain")).toEqual({ scheme: "{CLEARTEXT}", params: "plain" });
    });

    it("returns null for empty values and unknown scheme labels", () => {
        expect(parsePasswordHash("")).toBeNull();
        expect(parsePasswordHash("   ")).toBeNull();
        expect(parsePasswordHash("{MD5}abc=")).toBeNull();
        expect(parsePasswordHash("{CRYPT}$2y$05$abc")).toBeNull();
        expect(parsePasswordHash("{ARGON2}$argon2id$v=19$m=65536")).toBeNull();
    });
});

describe("verifyPasswordHash", () => {
    it("rejects plaintext and malformed stores instead of throwing", async () => {
        expect(await verifyPasswordHash("x", "")).toBe(false);
        expect(await verifyPasswordHash("x", "plaintext")).toBe(false);
        expect(await verifyPasswordHash("x", "{SHA}not-base64!!")).toBe(false);
        expect(await verifyPasswordHash("x", "{SSHA}aGk=")).toBe(false); // payload shorter than salt
    });
});

describe("generateRandomPassword", () => {
    const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    it("defaults to 16 characters", () => {
        expect(generateRandomPassword()).toHaveLength(16);
    });

    it("honours the requested length and clamps invalid input", () => {
        expect(generateRandomPassword(8)).toHaveLength(8);
        expect(generateRandomPassword(32)).toHaveLength(32);
        expect(generateRandomPassword(0)).toHaveLength(16);
        expect(generateRandomPassword(-5)).toHaveLength(16);
        expect(generateRandomPassword(Number.NaN)).toHaveLength(16);
        expect(generateRandomPassword(9999)).toHaveLength(128);
    });

    it("draws only from the unambiguous alphabet", () => {
        for (let i = 0; i < 50; i += 1) {
            const password = generateRandomPassword(24);
            for (const char of password) expect(ALPHABET).toContain(char);
        }
    });

    it("is random enough that two calls differ", () => {
        const seen = new Set(Array.from({ length: 32 }, () => generateRandomPassword()));
        expect(seen.size).toBe(32);
    });
});
