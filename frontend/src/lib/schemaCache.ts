/**
 * Schema metadata cache + RFC 4512 description parsing.
 *
 * Ported from tiny-rdm `frontend/src/modules/tools/ldap/composables/
 * useLdapSchemaCache.js`: a hoisted per-connection cache with TTL so schema
 * lookups (attribute autocomplete, objectClass-driven hints) survive
 * component remounts without refetching on every keystroke. The loader feeds
 * from the sidecar `ldap/schema` method (server-side cache on the Go side;
 * pass `refresh: true` to force a reload).
 *
 * J-8：缓存提升为模块级单例。原实现每个 useLdapSchemaCache 实例自持
 * Map+inFlight，App(dn/wizard)/SchemaPanel/SearchForm 四个实例在同一连接、
 * 同一 TTL 窗口内最多重复拉 4 次 ldap/schema；现在共享一份缓存，四实例共用
 * 同一次拉取。useLdapSchemaCache() 退化为共享缓存的视图（每视图一组 refs +
 * currentConnectionId）。TTL 30min / inFlight 去重 / per-connection 隔离 /
 * invalidate 强刷语义全部保留；条目仍按连接过期重拉，不做无 TTL 全局常驻。
 */

import { ref, type Ref } from 'vue';
import { ldapApi } from './api';
import type { AttributeSyntaxInfo } from './valueKinds';

export interface ObjectClassAttributes {
    must: string[];
    may: string[];
}

export interface SchemaServerInfo {
    dialect?: string;
    vendorName?: string;
    productName?: string;
}

/** 匹配规则（F2b；形状与 sidecar ldap/schema 契约一致）。 */
export interface MatchingRuleDef {
    oid: string;
    names?: string[];
    desc?: string;
    syntax?: string;
}

/** 匹配规则用途（F2b）。 */
export interface MatchingRuleUseDef {
    oid: string;
    names?: string[];
    attributeTypes?: string[];
}

/** LDAP 语法（F2b）。 */
export interface LdapSyntaxDef {
    oid: string;
    desc?: string;
}

/** deriveSchemaMetadata 第 4 参：三类补充定义（旧 sidecar 缺省 = undefined）。 */
export interface ExtraSchemaDefinitions {
    matchingRules?: MatchingRuleDef[];
    matchingRuleUses?: MatchingRuleUseDef[];
    ldapSyntaxes?: LdapSyntaxDef[];
}

export interface SchemaMetadata {
    attributeNames: string[];
    objectClassAttributes: Record<string, ObjectClassAttributes>;
    /** 小写属性名（含别名）→ 语法语义；来自 sidecar 解析字段或 raw 定义解析。 */
    attributeInfo?: Record<string, AttributeSyntaxInfo>;
    serverInfo?: SchemaServerInfo;
    rawAttributeTypes?: string[];
    rawObjectClasses?: string[];
    /** 三类补充定义（F2b）；未传 extra 时缺省 undefined，面板据此隐藏对应页签。 */
    matchingRules?: MatchingRuleDef[];
    matchingRuleUses?: MatchingRuleUseDef[];
    ldapSyntaxes?: LdapSyntaxDef[];
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

/** Numeric dotted OIDs are identifiers, not user-facing attribute names. */
const NUMERIC_OID_RE = /^\d+(?:\.\d+)+$/u;

function isNumericOid(value: string): boolean {
    return NUMERIC_OID_RE.test(value.trim());
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
 * `extra`（可选第 4 参）：matchingRules / matchingRuleUses / ldapSyntaxes
 * 三类补充定义原样透传；不传时字段缺省 undefined，现有 3 参调用完全兼容。
 */
export function deriveSchemaMetadata(
    attributeTypes: unknown,
    objectClasses: unknown,
    serverInfo?: SchemaServerInfo,
    extra?: ExtraSchemaDefinitions,
): SchemaMetadata {
    const attributeNames: string[] = [];
    const attributeInfo: Record<string, AttributeSyntaxInfo> = {};
    const seenAttributes = new Set<string>();
    for (const item of Array.isArray(attributeTypes) ? attributeTypes : []) {
        const parsed = parseAttributeTypeItem(item);
        for (const name of parsed.names) {
            const key = name.toLowerCase();
            if (key) attributeInfo[key] = parsed.info;
            // Some servers expose OID-only definitions with `name` falling
            // back to the OID. Keep their syntax metadata available, but do
            // not surface the numeric identifier as an attribute name.
            if (!key || isNumericOid(name) || seenAttributes.has(key)) continue;
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
        // 三类补充定义原样透传（loader 返回什么缓存什么；不深拷贝）。
        matchingRules: extra?.matchingRules,
        matchingRuleUses: extra?.matchingRuleUses,
        ldapSyntaxes: extra?.ldapSyntaxes,
    };
}

// -- 规范 loader（模块级单一数据源，J-8）--------------------------------------

/**
 * 一次 ldap/schema 拉取 → 超集 payload：deriveSchemaMetadata 基础字段 +
 * extra 三类补充定义 + raw 定义串透出。attributeNames 保持用户可读名（下拉/
 * 面板列表用）；DN 值属性解析等 raw 消费方走 rawAttributeTypes（sidecar 透出
 * 的原始串优先，mock/旧形状回退 deriveSchemaMetadata 保留的原文）。
 */
async function fetchCanonicalSchema(): Promise<SchemaMetadata> {
    const result = await ldapApi.schema(false);
    const metadata = deriveSchemaMetadata(
        result.attributeTypes,
        result.objectClasses,
        {
            dialect: result.dialect,
            vendorName: result.vendorName,
            productName: result.productName,
        },
        // F2b：三类补充定义随规范拉取一并进缓存（旧 sidecar 缺省 undefined → 页签隐藏）。
        { matchingRules: result.matchingRules, matchingRuleUses: result.matchingRuleUses, ldapSyntaxes: result.ldapSyntaxes },
    );
    return {
        ...metadata,
        rawAttributeTypes: result.rawAttributeTypes ?? metadata.rawAttributeTypes,
        rawObjectClasses: result.rawObjectClasses ?? metadata.rawObjectClasses,
    };
}

// -- 共享缓存状态（模块级单例，J-8）--------------------------------------------

interface CacheEntry {
    payload: SchemaMetadata;
    fetchedAt: number;
}

const sharedCache = new Map<string, CacheEntry>();
const sharedInFlight = new Map<string, Promise<SchemaMetadata>>();
// loading/error 为共享 refs：任一连接的拉取状态对所有视图可见（原 per-instance
// 语义的最小共享化；同名 ref 的读写语义不变）。
const sharedLoading = ref(false);
const sharedError = ref<unknown>(null);

const DEFAULT_TTL_MS = 30 * 60 * 1000;

// -- 单测钩子（生产代码禁用；仅 spec 用于隔离模块级状态与控制拉取）--------------

type SchemaLoaderOverride = (connectionId: string) => Promise<Partial<SchemaMetadata>>;
let loaderOverride: SchemaLoaderOverride | null = null;
let ttlOverride: number | null = null;

/** 仅供单测注入规范 loader（记录调用次数/返回受控 payload）；传 null 还原内置拉取。 */
export function setSchemaLoaderForTests(loader: SchemaLoaderOverride | null) {
    loaderOverride = loader;
}

/** 仅供单测覆盖 TTL（毫秒）；传 null 还原默认 30min。 */
export function setSchemaTtlForTests(ttlMs: number | null) {
    ttlOverride = ttlMs;
}

/** 仅供单测清空共享缓存/inFlight 与共享 loading/error，隔离用例间模块级状态。 */
export function resetSchemaCacheForTests() {
    sharedCache.clear();
    sharedInFlight.clear();
    sharedLoading.value = false;
    sharedError.value = null;
}

/** useLdapSchemaCache 返回的视图切片（字段与共享缓存同名，语义保持）。 */
export interface SchemaCacheView {
    loading: Ref<boolean>;
    error: Ref<unknown>;
    attributeNames: Ref<string[]>;
    objectClassAttributes: Ref<Record<string, ObjectClassAttributes>>;
    attributeInfo: Ref<Record<string, AttributeSyntaxInfo>>;
    serverInfo: Ref<SchemaServerInfo | undefined>;
    /** raw RFC 4512 定义串（J-8 新透出）：dnAttributes 解析与面板明细栏共用。 */
    rawAttributeTypes: Ref<string[]>;
    rawObjectClasses: Ref<string[]>;
    matchingRules: Ref<MatchingRuleDef[] | undefined>;
    matchingRuleUses: Ref<MatchingRuleUseDef[] | undefined>;
    ldapSyntaxes: Ref<LdapSyntaxDef[] | undefined>;
    ensureLoaded: (connectionId: string) => Promise<SchemaMetadata | null>;
    invalidate: (connectionId?: string) => void;
    clear: () => void;
}

/**
 * 共享缓存的视图：refs 数据与拉取去重全部落在模块级 sharedCache/sharedInFlight，
 * 每次调用只自持一组视图 refs 与 currentConnectionId。
 */
export function useLdapSchemaCache(): SchemaCacheView {
    const ttlMs = Math.max(0, ttlOverride ?? DEFAULT_TTL_MS);

    const loading = sharedLoading;
    const error = sharedError;
    const attributeNames = ref<string[]>([]);
    const objectClassAttributes = ref<Record<string, ObjectClassAttributes>>({});
    const attributeInfo = ref<Record<string, AttributeSyntaxInfo>>({});
    const serverInfo = ref<SchemaServerInfo | undefined>(undefined);
    const rawAttributeTypes = ref<string[]>([]);
    const rawObjectClasses = ref<string[]>([]);
    // F2b：三类补充定义（loader 未返回时保持 undefined，面板据此隐藏页签）。
    const matchingRules = ref<MatchingRuleDef[] | undefined>(undefined);
    const matchingRuleUses = ref<MatchingRuleUseDef[] | undefined>(undefined);
    const ldapSyntaxes = ref<LdapSyntaxDef[] | undefined>(undefined);

    let currentConnectionId = '';

    const applyEntry = (entry: CacheEntry) => {
        attributeNames.value = entry?.payload?.attributeNames || [];
        objectClassAttributes.value = entry?.payload?.objectClassAttributes || {};
        attributeInfo.value = entry?.payload?.attributeInfo || {};
        serverInfo.value = entry?.payload?.serverInfo;
        rawAttributeTypes.value = entry?.payload?.rawAttributeTypes || [];
        rawObjectClasses.value = entry?.payload?.rawObjectClasses || [];
        matchingRules.value = entry?.payload?.matchingRules;
        matchingRuleUses.value = entry?.payload?.matchingRuleUses;
        ldapSyntaxes.value = entry?.payload?.ldapSyntaxes;
    };

    // 拉取 settle 后本视图补 apply：仅当视图仍停留在该连接时应用，避免串连接
    // 数据（发起方与共享等待方都会走到这里）。
    const settle = (key: string, payload: SchemaMetadata) => {
        if (currentConnectionId !== key) return payload;
        const entry = sharedCache.get(key);
        if (entry) applyEntry(entry);
        return payload;
    };

    const ensureLoaded = async (connectionId: string): Promise<SchemaMetadata | null> => {
        const key = String(connectionId ?? '');
        if (!key) return null;
        currentConnectionId = key;

        const cached = sharedCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < ttlMs) {
            applyEntry(cached);
            return cached.payload;
        }

        const existing = sharedInFlight.get(key);
        // J-8：并发视图共享同一次拉取。旧 per-instance 实现里等待方必然是发起方
        // 自身（resolve 内 apply）；共享化后等待方视图也要在 resolve 后补 apply，
        // 否则后打开的面板在去重命中时会拿到空列表。
        if (existing) return existing.then((payload) => settle(key, payload));

        const pending = (async () => {
            sharedLoading.value = true;
            sharedError.value = null;
            try {
                const raw = loaderOverride ? await loaderOverride(key) : await fetchCanonicalSchema();
                // loader 允许返回 Partial：缺省字段按空值补齐（与旧实现一致）。
                const payload: SchemaMetadata = {
                    attributeNames: raw.attributeNames || [],
                    objectClassAttributes: raw.objectClassAttributes || {},
                    attributeInfo: raw.attributeInfo || {},
                    serverInfo: raw.serverInfo,
                    rawAttributeTypes: raw.rawAttributeTypes,
                    rawObjectClasses: raw.rawObjectClasses,
                    matchingRules: raw.matchingRules,
                    matchingRuleUses: raw.matchingRuleUses,
                    ldapSyntaxes: raw.ldapSyntaxes,
                };
                const entry: CacheEntry = { payload, fetchedAt: Date.now() };
                sharedCache.set(key, entry);
                return payload;
            } catch (err) {
                sharedError.value = err;
                throw err;
            } finally {
                sharedInFlight.delete(key);
                if (sharedInFlight.size === 0) sharedLoading.value = false;
            }
        })();
        sharedInFlight.set(key, pending);
        return pending.then((payload) => settle(key, payload));
    };

    const invalidate = (connectionId?: string) => {
        if (connectionId == null) {
            sharedCache.clear();
            return;
        }
        sharedCache.delete(String(connectionId));
    };

    const clear = () => {
        sharedCache.clear();
        sharedInFlight.clear();
        sharedLoading.value = false;
        sharedError.value = null;
        attributeNames.value = [];
        objectClassAttributes.value = {};
        attributeInfo.value = {};
        serverInfo.value = undefined;
        rawAttributeTypes.value = [];
        rawObjectClasses.value = [];
        matchingRules.value = undefined;
        matchingRuleUses.value = undefined;
        ldapSyntaxes.value = undefined;
        currentConnectionId = '';
    };

    return {
        loading,
        error,
        attributeNames,
        objectClassAttributes,
        attributeInfo,
        serverInfo,
        rawAttributeTypes,
        rawObjectClasses,
        matchingRules,
        matchingRuleUses,
        ldapSyntaxes,
        ensureLoaded,
        invalidate,
        clear,
    };
}
