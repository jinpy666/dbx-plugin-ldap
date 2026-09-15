/**
 * Schema metadata cache + RFC 4512 description parsing.
 *
 * Ported from tiny-rdm `frontend/src/modules/tools/ldap/composables/
 * useLdapSchemaCache.js`: a hoisted per-connection cache with TTL so schema
 * lookups (attribute autocomplete, objectClass-driven hints) survive
 * component remounts without refetching on every keystroke. The loader feeds
 * from the sidecar `ldap/schema` method (server-side cache on the Go side;
 * pass `refresh: true` to force a reload).
 */

import { ref } from 'vue';
import type { AttributeSyntaxInfo } from './valueKinds';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export interface ObjectClassAttributes {
    must: string[];
    may: string[];
}

export interface SchemaServerInfo {
    dialect?: string;
    vendorName?: string;
    productName?: string;
}

export interface SchemaMetadata {
    attributeNames: string[];
    objectClassAttributes: Record<string, ObjectClassAttributes>;
    /** 小写属性名（含别名）→ 语法语义；来自 sidecar 解析字段或 raw 定义解析。 */
    attributeInfo?: Record<string, AttributeSyntaxInfo>;
    serverInfo?: SchemaServerInfo;
    rawAttributeTypes?: string[];
    rawObjectClasses?: string[];
}

interface CacheEntry {
    payload: SchemaMetadata;
    fetchedAt: number;
}

// -- RFC 4512 description parsing (pure helpers) -----------------------------

/** Split a parenthesised definition body into top-level tokens. */
function tokenizeSchemaBody(body: string): string[] {
    const tokens: string[] = [];
    let depth = 0;
    let current = '';
    let quoted = false;
    for (const char of body) {
        if (quoted) {
            if (char === "'") quoted = false;
            else current += char;
            continue;
        }
        if (char === "'") {
            quoted = true;
            current += char;
            continue;
        }
        if (char === '(') {
            depth += 1;
            if (depth === 1) continue;
        } else if (char === ')') {
            depth -= 1;
            if (depth === 0) continue;
        }
        if (depth === 0 && /\s/.test(char)) {
            if (current) tokens.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (current) tokens.push(current);
    return tokens;
}

/** Extract the quoted / bare token list that follows `keyword` (NAME, SUP…). */
function extractKeywordValues(definition: string, keyword: string): string[] {
    const match = new RegExp(`${keyword}\\s+(?:(?:\\()\\s*([^)]*)\\)|'([^']*)'|([^\\s)]+))`, 'iu').exec(definition);
    if (!match) return [];
    if (match[1] != null) {
        return [...match[1].matchAll(/'([^']*)'|([^\s$()]+)/gu)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean);
    }
    const value = match[2] ?? match[3] ?? '';
    return value.trim() ? [value.trim()] : [];
}

function parseAttributeType(definition: string): string[] {
    return extractKeywordValues(definition, 'NAME');
}

/** raw 定义串解析：SYNTAX（剥离 {len}）/ EQUALITY / SUP / 布尔标记。 */
const SYNTAX_VALUE_RE = /\bSYNTAX\s+(\d+(?:\.\d+)+)(?:\{\d+\})?/iu;
const EQUALITY_RE = /\bEQUALITY\s+([^\s)$]+)/iu;

function parseSyntaxInfoFromDefinition(definition: string): AttributeSyntaxInfo {
    const info: AttributeSyntaxInfo = {};
    const syntax = SYNTAX_VALUE_RE.exec(definition);
    if (syntax) info.syntax = syntax[1];
    const equality = EQUALITY_RE.exec(definition);
    if (equality) info.equality = equality[1];
    if (/\bSINGLE-VALUE\b/iu.test(definition)) info.singleValue = true;
    if (/\bNO-USER-MODIFICATION\b/iu.test(definition)) info.noUserModification = true;
    return info;
}

interface ParsedObjectClass {
    names: string[];
    must: string[];
    may: string[];
}

function parseObjectClass(definition: string): ParsedObjectClass {
    const names = extractKeywordValues(definition, 'NAME');
    const must = extractKeywordValues(definition, 'MUST');
    const may = extractKeywordValues(definition, 'MAY');
    return { names, must, may };
}

interface ParsedAttributeType {
    names: string[];
    info: AttributeSyntaxInfo;
}

/**
 * 单条 attributeType 定义 → 名字列表 + 语法语义。兼容两种 wire 形状：
 * - raw RFC 4512 定义串（mock / 旧 sidecar）→ 正则解析；
 * - sidecar 结构体（{oid,name,names,syntax,...}，阶段1 起的真实格式）→ 直取字段。
 */
function parseAttributeTypeItem(item: unknown): ParsedAttributeType {
    if (item && typeof item === 'object') {
        const record = item as { name?: unknown; names?: unknown; syntax?: unknown; equality?: unknown; singleValue?: unknown; noUserModification?: unknown };
        const names = (Array.isArray(record.names) ? record.names : []).map(String).filter(Boolean);
        const primary = typeof record.name === 'string' && record.name ? record.name : '';
        if (primary && !names.some((name) => name.toLowerCase() === primary.toLowerCase())) names.unshift(primary);
        return {
            names,
            info: {
                syntax: typeof record.syntax === 'string' ? record.syntax : undefined,
                equality: typeof record.equality === 'string' ? record.equality : undefined,
                singleValue: record.singleValue === true,
                noUserModification: record.noUserModification === true,
            },
        };
    }
    const definition = String(item ?? '');
    return { names: parseAttributeType(definition), info: parseSyntaxInfoFromDefinition(definition) };
}

function parseObjectClassItem(item: unknown): ParsedObjectClass {
    if (item && typeof item === 'object') {
        const record = item as { name?: unknown; names?: unknown; must?: unknown; may?: unknown };
        const names = (Array.isArray(record.names) ? record.names : []).map(String).filter(Boolean);
        const primary = typeof record.name === 'string' && record.name ? record.name : '';
        if (primary && !names.some((name) => name.toLowerCase() === primary.toLowerCase())) names.unshift(primary);
        return {
            names,
            must: (Array.isArray(record.must) ? record.must : []).map(String),
            may: (Array.isArray(record.may) ? record.may : []).map(String),
        };
    }
    return parseObjectClass(String(item ?? ''));
}

/**
 * Derive the frontend schema metadata from the sidecar `ldap/schema` return.
 * attributeTypes / objectClasses 兼容 raw 定义串数组与结构体数组两种形状；
 * 同时透出按属性名（小写，含别名）索引的语法语义与服务器方言摘要。
 */
export function deriveSchemaMetadata(attributeTypes: unknown, objectClasses: unknown, serverInfo?: SchemaServerInfo): SchemaMetadata {
    const attributeNames: string[] = [];
    const attributeInfo: Record<string, AttributeSyntaxInfo> = {};
    const seenAttributes = new Set<string>();
    for (const item of Array.isArray(attributeTypes) ? attributeTypes : []) {
        const parsed = parseAttributeTypeItem(item);
        for (const name of parsed.names) {
            const key = name.toLowerCase();
            if (key) attributeInfo[key] = parsed.info;
            if (!key || seenAttributes.has(key)) continue;
            seenAttributes.add(key);
            attributeNames.push(name);
        }
    }

    const objectClassAttributes: Record<string, ObjectClassAttributes> = {};
    for (const item of Array.isArray(objectClasses) ? objectClasses : []) {
        const parsed = parseObjectClassItem(item);
        if (parsed.names.length === 0) continue;
        const entry: ObjectClassAttributes = { must: parsed.must, may: parsed.may };
        for (const name of parsed.names) {
            objectClassAttributes[name] = entry;
        }
    }

    return {
        attributeNames,
        objectClassAttributes,
        attributeInfo,
        serverInfo,
        rawAttributeTypes: Array.isArray(attributeTypes) ? attributeTypes.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))) : [],
        rawObjectClasses: Array.isArray(objectClasses) ? objectClasses.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))) : [],
    };
}

export interface SchemaCacheOptions {
    ttlMs?: number;
    loader?: (connectionId: string) => Promise<Partial<SchemaMetadata>>;
}

export function useLdapSchemaCache(options?: SchemaCacheOptions) {
    const ttlMs = Math.max(0, Number(options?.ttlMs) || DEFAULT_TTL_MS);
    const loader = typeof options?.loader === 'function' ? options!.loader : null;

    const loading = ref(false);
    const error = ref<unknown>(null);
    const attributeNames = ref<string[]>([]);
    const objectClassAttributes = ref<Record<string, ObjectClassAttributes>>({});
    const attributeInfo = ref<Record<string, AttributeSyntaxInfo>>({});
    const serverInfo = ref<SchemaServerInfo | undefined>(undefined);

    const cache = new Map<string, CacheEntry>();
    const inFlight = new Map<string, Promise<SchemaMetadata>>();
    let currentConnectionId = '';

    const applyEntry = (entry: CacheEntry) => {
        attributeNames.value = entry?.payload?.attributeNames || [];
        objectClassAttributes.value = entry?.payload?.objectClassAttributes || {};
        attributeInfo.value = entry?.payload?.attributeInfo || {};
        serverInfo.value = entry?.payload?.serverInfo;
    };

    const ensureLoaded = async (connectionId: string): Promise<SchemaMetadata | null> => {
        const key = String(connectionId ?? '');
        if (!key) return null;
        if (!loader) {
            const empty: CacheEntry = { payload: { attributeNames: [], objectClassAttributes: {} }, fetchedAt: Date.now() };
            applyEntry(empty);
            return empty.payload;
        }
        currentConnectionId = key;

        const cached = cache.get(key);
        if (cached && Date.now() - cached.fetchedAt < ttlMs) {
            applyEntry(cached);
            return cached.payload;
        }

        const existing = inFlight.get(key);
        if (existing) return existing;

        const pending = (async () => {
            loading.value = true;
            error.value = null;
            try {
                const payload = (await loader(key)) || {};
                const entry: CacheEntry = {
                    payload: {
                        attributeNames: payload.attributeNames || [],
                        objectClassAttributes: payload.objectClassAttributes || {},
                        attributeInfo: payload.attributeInfo || {},
                        serverInfo: payload.serverInfo,
                        rawObjectClasses: payload.rawObjectClasses,
                    },
                    fetchedAt: Date.now(),
                };
                cache.set(key, entry);
                if (currentConnectionId === key) applyEntry(entry);
                return entry.payload;
            } catch (err) {
                error.value = err;
                throw err;
            } finally {
                inFlight.delete(key);
                if (inFlight.size === 0) loading.value = false;
            }
        })();
        inFlight.set(key, pending);
        return pending;
    };

    const invalidate = (connectionId?: string) => {
        if (connectionId == null) {
            cache.clear();
            return;
        }
        cache.delete(String(connectionId));
    };

    const clear = () => {
        cache.clear();
        inFlight.clear();
        loading.value = false;
        error.value = null;
        attributeNames.value = [];
        objectClassAttributes.value = {};
        attributeInfo.value = {};
        serverInfo.value = undefined;
        currentConnectionId = '';
    };

    return {
        loading,
        error,
        attributeNames,
        objectClassAttributes,
        attributeInfo,
        serverInfo,
        ensureLoaded,
        invalidate,
        clear,
    };
}
