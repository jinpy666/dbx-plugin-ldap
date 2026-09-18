/**
 * SHA-1 / SHA-256 / SHA-512 纯 JS 兜底(FIPS 180-4)。
 *
 * DBX 宿主的插件 webview 常以局域网 HTTP 打开(非安全上下文),此时
 * `crypto.subtle` 要么为 undefined,要么调用即抛 SecurityError
 * ("The operation is insecure.")。digestSha 优先走 Web Crypto,不可用或
 * 失败时回退到本文件的纯 JS 实现,保证密码本地哈希在任何宿主形态下都可用
 * (与 lib/uuid.ts 对 randomUUID 的兜底同一模式)。输入只有密码级长度,
 * 性能不敏感。
 */

// FIPS 180-4 的初始向量与轮常量分别是前若干素数平方根/立方根的小数部分
// 前 32/64 位。为避免手抄百余个常量出错,这里按定义用 BigInt 整数开方在
// 模块加载时精确推导一次(二分,无浮点误差)。

/** 最大满足 r^k ≤ n 的整数 r(精确整数 k 次根,二分)。 */
const iroot = (n: bigint, k: bigint): bigint => {
    if (n < 2n) return n;
    let low = 1n;
    let high = 1n << (BigInt(n.toString(2).length) / k + 2n);
    while (low < high) {
        const mid = (low + high + 1n) >> 1n;
        if (mid ** k <= n) low = mid;
        else high = mid - 1n;
    }
    return low;
};

/** frac(√p) 的前 bits 位:floor(√(p·2^(2·bits))) − isqrt(p)·2^bits。 */
const sqrtFraction = (prime: bigint, bits: bigint): bigint =>
    iroot(prime << (bits * 2n), 2n) - (iroot(prime, 2n) << bits);

/** frac(∛p) 的前 bits 位:floor(∛(p·2^(3·bits))) − icbrt(p)·2^bits。 */
const cbrtFraction = (prime: bigint, bits: bigint): bigint =>
    iroot(prime << (bits * 3n), 3n) - (iroot(prime, 3n) << bits);

// 前 80 个素数:SHA-256 向量取前 8、常量取前 64;SHA-512 常量取全部 80。
const PRIMES = [
    2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n,
    31n, 37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n,
    73n, 79n, 83n, 89n, 97n, 101n, 103n, 107n, 109n, 113n,
    127n, 131n, 137n, 139n, 149n, 151n, 157n, 163n, 167n, 173n,
    179n, 181n, 191n, 193n, 197n, 199n, 211n, 223n, 227n, 229n,
    233n, 239n, 241n, 251n, 257n, 263n, 269n, 271n, 277n, 281n,
    283n, 293n, 307n, 311n, 313n, 317n, 331n, 337n, 347n, 349n,
    353n, 359n, 367n, 373n, 379n, 383n, 389n, 397n, 401n, 409n,
];

const H256: readonly number[] = PRIMES.slice(0, 8).map((p) => Number(sqrtFraction(p, 32n)));
const K256: readonly number[] = PRIMES.slice(0, 64).map((p) => Number(cbrtFraction(p, 32n)));
const H512: readonly bigint[] = PRIMES.slice(0, 8).map((p) => sqrtFraction(p, 64n));
const K512: readonly bigint[] = PRIMES.slice(0, 80).map((p) => cbrtFraction(p, 64n));

const rotr32 = (value: number, shift: number): number => (value >>> shift) | (value << (32 - shift));
const rotl32 = (value: number, shift: number): number => (value << shift) | (value >>> (32 - shift));

/** MD 补齐:消息 ‖ 0x80 ‖ 0x00… ‖ 大端比特长度,总长为 blockSize 倍数。 */
const paddedMessage = (data: Uint8Array, blockSize: number, lengthFieldBytes: number): Uint8Array => {
    const padded = new Uint8Array((Math.floor((data.length + lengthFieldBytes) / blockSize) + 1) * blockSize);
    padded.set(data);
    padded[data.length] = 0x80;
    const bitLength = data.length * 8;
    const view = new DataView(padded.buffer);
    const lengthWords = lengthFieldBytes / 4;
    for (let i = 0; i < lengthWords; i += 1) {
        const shift = (lengthWords - 1 - i) * 32;
        view.setUint32(padded.length - lengthFieldBytes + i * 4, Math.floor(bitLength / 2 ** shift) >>> 0);
    }
    return padded;
};

const wordsToBytes = (words: readonly (number | bigint)[], wordBytes: number): Uint8Array => {
    const out = new Uint8Array(words.length * wordBytes);
    const view = new DataView(out.buffer);
    for (let i = 0; i < words.length; i += 1) {
        if (wordBytes === 4) view.setUint32(i * 4, Number(words[i]) >>> 0);
        else for (let byte = 0; byte < wordBytes; byte += 1) out[i * wordBytes + byte] = Number((BigInt(words[i]) >> BigInt((wordBytes - 1 - byte) * 8)) & 0xffn);
    }
    return out;
};

/** SHA-1(FIPS 180-4 §6.1):输出 20 字节。 */
const sha1 = (data: Uint8Array): Uint8Array => {
    const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    const padded = paddedMessage(data, 64, 8);
    const view = new DataView(padded.buffer);
    const w = new Uint32Array(80);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 80; i += 1) w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        let [a, b, c, d, e] = h;
        for (let i = 0; i < 80; i += 1) {
            let f: number;
            let k: number;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
            else { f = b ^ c ^ d; k = 0xca62c1d6; }
            const temp = (rotl32(a, 5) + f + e + k + w[i]) >>> 0;
            e = d; d = c; c = rotl32(b, 30); b = a; a = temp;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
    }
    return wordsToBytes(h, 4);
};

/** SHA-256(FIPS 180-4 §6.2):输出 32 字节。 */
const sha256 = (data: Uint8Array): Uint8Array => {
    const h = H256.slice();
    const padded = paddedMessage(data, 64, 8);
    const view = new DataView(padded.buffer);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i += 1) {
            const x = w[i - 15];
            const y = w[i - 2];
            const s0 = rotr32(x, 7) ^ rotr32(x, 18) ^ (x >>> 3);
            const s1 = rotr32(y, 17) ^ rotr32(y, 19) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], last = h[7];
        for (let i = 0; i < 64; i += 1) {
            const bigS1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (last + bigS1 + ch + K256[i] + w[i]) >>> 0;
            const bigS0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (bigS0 + maj) >>> 0;
            last = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + last) >>> 0;
    }
    return wordsToBytes(h, 4);
};

const MASK64 = (1n << 64n) - 1n;
const rotr64 = (value: bigint, shift: number): bigint =>
    ((value >> BigInt(shift)) | (value << BigInt(64 - shift))) & MASK64;

/** SHA-512(FIPS 180-4 §6.4,BigInt 64 位字):输出 64 字节。 */
const sha512 = (data: Uint8Array): Uint8Array => {
    const h = H512.slice();
    const padded = paddedMessage(data, 128, 16);
    const view = new DataView(padded.buffer);
    const w = new Array<bigint>(80);
    for (let offset = 0; offset < padded.length; offset += 128) {
        for (let i = 0; i < 16; i += 1) {
            w[i] = (BigInt(view.getUint32(offset + i * 8)) << 32n) | BigInt(view.getUint32(offset + i * 8 + 4));
        }
        for (let i = 16; i < 80; i += 1) {
            const x = w[i - 15];
            const y = w[i - 2];
            const s0 = rotr64(x, 1) ^ rotr64(x, 8) ^ (x >> 7n);
            const s1 = rotr64(y, 19) ^ rotr64(y, 61) ^ (y >> 6n);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], last = h[7];
        for (let i = 0; i < 80; i += 1) {
            // (~e & g):g 非负,与按位取反后的 e 相与即得 g 的补码位选择,
            // 结果天然落在 64 位内,无需再掩码。
            const bigS1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
            const ch = (e & f) ^ (~e & g);
            const t1 = (last + bigS1 + ch + K512[i] + w[i]) & MASK64;
            const bigS0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (bigS0 + maj) & MASK64;
            last = g; g = f; f = e; e = (d + t1) & MASK64;
            d = c; c = b; b = a; a = (t1 + t2) & MASK64;
        }
        h[0] = (h[0] + a) & MASK64; h[1] = (h[1] + b) & MASK64; h[2] = (h[2] + c) & MASK64; h[3] = (h[3] + d) & MASK64;
        h[4] = (h[4] + e) & MASK64; h[5] = (h[5] + f) & MASK64; h[6] = (h[6] + g) & MASK64; h[7] = (h[7] + last) & MASK64;
    }
    return wordsToBytes(h, 8);
};

export type ShaAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

/**
 * 与 `crypto.subtle.digest` 等价的摘要入口:优先 Web Crypto,非安全上下文
 * (subtle 缺失,或调用即抛 SecurityError)时回退纯 JS 实现。
 */
export const digestSha = async (algorithm: ShaAlgorithm, data: Uint8Array): Promise<Uint8Array> => {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        try {
            return new Uint8Array(await subtle.digest(algorithm, data as BufferSource));
        } catch {
            // SecurityError 等 → 纯 JS 兜底
        }
    }
    if (algorithm === "SHA-1") return sha1(data);
    if (algorithm === "SHA-256") return sha256(data);
    return sha512(data);
};
