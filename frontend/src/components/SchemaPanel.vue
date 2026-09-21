<script setup lang="ts">
// Schema 面板：五分类主从浏览（对标 Apache Directory Studio Schema Browser）。
// 页签：属性类型 / 对象类 / 匹配规则 / 匹配规则用途 / LDAP 语法（后三类仅在
// sidecar 透出对应定义时显示）+ 关键字过滤 + 强制刷新。数据经
// useLdapSchemaCache 共享视图（J-8：进程内 per-connection TTL 30min）→
// sidecar ldap/schema（服务端缓存 cache/schema-<hash>.json，refresh=true 绕过）。
// 明细卡选中定义展示 OID/语法/匹配规则/SUP 链/反向引用等（反向引用为纯前端扫描）。
import { computed, ref, watch } from "vue";
import { Database, RefreshCw, X } from "@lucide/vue";
import {
  useLdapSchemaCache,
  type LdapSyntaxDef,
  type MatchingRuleDef,
  type MatchingRuleUseDef,
} from "../lib/schemaCache";
import { attributeValueKind } from "../lib/valueKinds";
import { useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";

interface SchemaClassRow {
  name: string;
  must: string[];
  may: string[];
  definition: string;
}

/** raw RFC 4512 定义串解析出的 attributeType 摘要（OID/别名组仅存在于 raw 串）。 */
interface RawAttributeDef {
  oid: string;
  names: string[];
  desc: string;
}

/** raw 定义串解析出的 objectClass 摘要（SUP 链的来源；结构体形状无 SUP）。 */
interface RawObjectClassDef {
  oid: string;
  names: string[];
  desc: string;
  sup: string[];
}

const props = defineProps<{
  open: boolean;
  connectionId: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "error", message: string): void;
}>();

// -- raw 定义解析（明细栏专用；schemaCache 的解析函数未导出，这里按同一规则
//    实现轻量版，行为保持一致：括号列表 / 引号单值 / 裸 token） ---------------

/** RFC 4512 关键字取值列表。 */
function extractKeywordValues(definition: string, keyword: string): string[] {
  const match = new RegExp(`${keyword}\\s+(?:(?:\\()\\s*([^)]*)\\)|'([^']*)'|([^\\s)]+))`, "iu").exec(definition);
  if (!match) return [];
  if (match[1] != null) {
    return [...match[1].matchAll(/'([^']*)'|([^\s$()]+)/gu)].map((item) => (item[1] ?? item[2] ?? "").trim()).filter(Boolean);
  }
  const value = match[2] ?? match[3] ?? "";
  return value.trim() ? [value.trim()] : [];
}

function extractDesc(definition: string): string {
  return /DESC\s+'([^']*)'/iu.exec(definition)?.[1] ?? "";
}

/** 定义串剥掉左括号后的首个 token 即 OID（"( 1.2.3 NAME … )"）。 */
function extractOid(definition: string): string {
  return definition.trim().replace(/^\(+\s*/u, "").split(/\s/u)[0] ?? "";
}

function parseRawAttributeType(definition: string): RawAttributeDef {
  const trimmed = definition.trim();
  if (trimmed.startsWith("{")) {
    // 结构体被 JSON.stringify 保留的 raw（sidecar 未透出 rawAttributeTypes）：
    // 只取 oid/name，其余留给结构化的 attributeInfo。
    try {
      const record = JSON.parse(trimmed) as { oid?: unknown; name?: unknown; names?: unknown };
      const names = (Array.isArray(record.names) ? record.names : [record.name]).map(String).filter(Boolean);
      return { oid: typeof record.oid === "string" ? record.oid : "", names, desc: "" };
    } catch {
      return { oid: "", names: [], desc: "" };
    }
  }
  return { oid: extractOid(trimmed), names: extractKeywordValues(trimmed, "NAME"), desc: extractDesc(trimmed) };
}

function parseRawObjectClass(definition: string): RawObjectClassDef {
  const trimmed = definition.trim();
  if (trimmed.startsWith("{")) {
    // 结构体形状无 SUP 字段（wire 协议未透出），SUP 链留空、明细行缺省。
    try {
      const record = JSON.parse(trimmed) as { oid?: unknown; name?: unknown; names?: unknown };
      const names = (Array.isArray(record.names) ? record.names : [record.name]).map(String).filter(Boolean);
      return { oid: typeof record.oid === "string" ? record.oid : "", names, desc: "", sup: [] };
    } catch {
      return { oid: "", names: [], desc: "", sup: [] };
    }
  }
  return {
    oid: extractOid(trimmed),
    names: extractKeywordValues(trimmed, "NAME"),
    desc: extractDesc(trimmed),
    sup: extractKeywordValues(trimmed, "SUP"),
  };
}

// 明细栏 raw 定义串：共享缓存视图透出（J-8）。sidecar 透出的原始串优先，否则
// 回退 deriveSchemaMetadata 保留的原文（raw 定义串形状时即原样），归一逻辑在
// 规范 loader 内。SUP/OID/DESC 只存在于 raw 串，objectClassAttributes 结构不含。
const rawDefs = computed<{ attributeTypes: string[]; objectClasses: string[] }>(() => ({
  attributeTypes: cache.rawAttributeTypes.value,
  objectClasses: cache.rawObjectClasses.value,
}));

// J-8：共享缓存视图（App dn/wizard、SearchForm 同源）；per-connection TTL 30min，
// inFlight 去重，refresh() 用 invalidate 强刷。
const cache = useLdapSchemaCache();
const keyword = ref("");
const selectedAttribute = ref("");
const selectedObjectClass = ref("");

// -- 分类页签（F2b 五分类主从浏览）-------------------------------------------
// attributeTypes / objectClasses 为基础分类（始终可见）；匹配规则 / 匹配规则
// 用途 / LDAP 语法仅在 sidecar 返回对应定义（非空数组）时显示。
type SchemaCategory = "attributeTypes" | "objectClasses" | "matchingRules" | "matchingRuleUses" | "syntaxes";
const activeTab = ref<SchemaCategory>("attributeTypes");
// 三类新定义以 oid 为选中键（列表无别名组歧义，oid 唯一）。
const selectedMatchingRule = ref("");
const selectedMatchingRuleUse = ref("");
const selectedSyntax = ref("");
// 选中属性的语法语义（schema attributeInfo → 无则不显示详情行）。
const selectedAttributeInfo = computed(() => {
  if (!selectedAttribute.value) return undefined;
  const info = cache.attributeInfo.value;
  if (!info) return undefined;
  const key = selectedAttribute.value.toLowerCase();
  return info[key] ?? info[Object.keys(info).find((name) => name.toLowerCase() === key) ?? ""];
});

// 明细数据索引：小写类名/属性名 → raw 摘要；别名键指向同一摘要。
const attributeRawIndex = computed<Map<string, RawAttributeDef>>(() => {
  const index = new Map<string, RawAttributeDef>();
  for (const definition of rawDefs.value.attributeTypes) {
    const parsed = parseRawAttributeType(definition);
    for (const name of parsed.names) {
      const key = name.toLowerCase();
      if (key && !index.has(key)) index.set(key, parsed);
    }
  }
  return index;
});

const objectClassRawIndex = computed<Map<string, RawObjectClassDef>>(() => {
  const index = new Map<string, RawObjectClassDef>();
  for (const definition of rawDefs.value.objectClasses) {
    const parsed = parseRawObjectClass(definition);
    for (const name of parsed.names) {
      const key = name.toLowerCase();
      if (key && !index.has(key)) index.set(key, parsed);
    }
  }
  return index;
});

// 小写名 → 该定义全部名字（小写）：MUST/MAY/SUP 里的引用按别名组匹配。
const definitionNameGroups = computed<Map<string, Set<string>>>(() => {
  const groups = new Map<string, Set<string>>();
  const addGroup = (names: string[]) => {
    const group = new Set(names.map((name) => name.toLowerCase()).filter(Boolean));
    for (const key of group) if (!groups.has(key)) groups.set(key, group);
  };
  for (const parsed of attributeRawIndex.value.values()) addGroup(parsed.names);
  for (const parsed of objectClassRawIndex.value.values()) addGroup(parsed.names);
  return groups;
});

function objectClassEntry(name: string) {
  const source = cache.objectClassAttributes.value;
  return source[name] ?? source[Object.keys(source).find((key) => key.toLowerCase() === name.toLowerCase()) ?? ""];
}

/**
 * 反向引用（纯前端计算）：扫描全部 objectClass 的 SUP/MUST/MAY，收集引用了
 * 目标名（含别名）的类。attributeType 命中 MUST/MAY，objectClass 命中 SUP。
 */
function referencedClassesOf(target: string): string[] {
  if (!target) return [];
  const key = target.toLowerCase();
  const group = definitionNameGroups.value.get(key);
  const hit = (reference: string): boolean => {
    const referenceKey = reference.toLowerCase();
    return referenceKey === key || (group?.has(referenceKey) ?? false);
  };
  const classes: string[] = [];
  const seen = new Set<string>();
  for (const [name, parsed] of objectClassRawIndex.value) {
    if (name === key || seen.has(name)) continue;
    const entry = objectClassEntry(name);
    const references = [...parsed.sup, ...(entry?.must ?? []), ...(entry?.may ?? [])];
    if (references.some(hit)) {
      seen.add(name);
      const primary = parsed.names[0] ?? name;
      if (!classes.some((existing) => existing.toLowerCase() === primary.toLowerCase())) classes.push(primary);
    }
  }
  return classes.sort((left, right) => left.localeCompare(right));
}

/** SUP 链：沿 raw 定义的 superior 逐级向上展开，visited 防环。 */
function superiorChainOf(name: string): string[] {
  const chain: string[] = [];
  const visited = new Set<string>([name.toLowerCase()]);
  let cursor = name.toLowerCase();
  for (;;) {
    const next = objectClassRawIndex.value.get(cursor)?.sup[0];
    if (!next) break;
    const key = next.toLowerCase();
    if (visited.has(key)) break;
    visited.add(key);
    chain.push(next);
    cursor = key;
  }
  return chain;
}

/** 清空全部五类选中（明细卡回到占位态）。 */
function clearSelections() {
  selectedAttribute.value = "";
  selectedObjectClass.value = "";
  selectedMatchingRule.value = "";
  selectedMatchingRuleUse.value = "";
  selectedSyntax.value = "";
}

/** 同类再点取消选中；换类选中互斥（主从浏览单一明细语义）。 */
function selectAttribute(name: string) {
  const next = selectedAttribute.value === name ? "" : name;
  clearSelections();
  selectedAttribute.value = next;
}

function selectObjectClass(name: string) {
  const next = selectedObjectClass.value === name ? "" : name;
  clearSelections();
  selectedObjectClass.value = next;
}

function selectMatchingRule(oid: string) {
  const next = selectedMatchingRule.value === oid ? "" : oid;
  clearSelections();
  selectedMatchingRule.value = next;
}

function selectMatchingRuleUse(oid: string) {
  const next = selectedMatchingRuleUse.value === oid ? "" : oid;
  clearSelections();
  selectedMatchingRuleUse.value = next;
}

function selectSyntax(oid: string) {
  const next = selectedSyntax.value === oid ? "" : oid;
  clearSelections();
  selectedSyntax.value = next;
}

// 切换页签即清空选中：明细卡跟随当前分类。
watch(activeTab, () => clearSelections());

// -- 明细卡（选中 attributeType / objectClass 的结构化展示）-------------------

const selectedAttributeRaw = computed(() =>
  selectedAttribute.value ? attributeRawIndex.value.get(selectedAttribute.value.toLowerCase()) : undefined,
);
const selectedAttributeKind = computed(() =>
  selectedAttribute.value ? attributeValueKind(selectedAttribute.value, selectedAttributeInfo.value) : "",
);
const selectedAttributeReferences = computed(() =>
  selectedAttribute.value ? referencedClassesOf(selectedAttribute.value) : [],
);

const selectedObjectClassRaw = computed(() =>
  selectedObjectClass.value ? objectClassRawIndex.value.get(selectedObjectClass.value.toLowerCase()) : undefined,
);
const selectedObjectClassEntry = computed(() => (selectedObjectClass.value ? objectClassEntry(selectedObjectClass.value) : undefined));
const selectedObjectClassSupers = computed(() => (selectedObjectClass.value ? superiorChainOf(selectedObjectClass.value) : []));
const selectedObjectClassReferences = computed(() =>
  selectedObjectClass.value ? referencedClassesOf(selectedObjectClass.value) : [],
);

const rawDefinition = ref<SchemaClassRow>();
// 空列两态（UI 扫描 P2-4）：有过滤字时是"无匹配"，不是"Schema 为空"。
const hasKeyword = computed(() => keyword.value.trim() !== "");
const attributeEmptyText = computed(() => (hasKeyword.value ? t("schema.noMatch", { keyword: keyword.value.trim() }) : t("schema.empty")));
const objectClassEmptyText = computed(() => (hasKeyword.value ? t("schema.noMatch", { keyword: keyword.value.trim() }) : t("schema.empty")));
// 三类新页签列表（MR/MRU/Syntax）共用同一两态文案。
const listEmptyText = computed(() => (hasKeyword.value ? t("schema.noMatch", { keyword: keyword.value.trim() }) : t("schema.empty")));
// 明细卡未选中占位：用 schema.detailsEmpty（"选择左侧定义查看明细"），
// 避免误显 schema.empty（"Schema 为空"，语义像拉取失败）。
const detailEmptyText = computed(() => t("schema.detailsEmpty"));

const attributeRows = computed(() => {
  const needle = keyword.value.trim().toLowerCase();
  return cache.attributeNames.value.filter((name) => !needle || name.toLowerCase().includes(needle));
});

const objectClassRows = computed<SchemaClassRow[]>(() => {
  const needle = keyword.value.trim().toLowerCase();
  const source = cache.objectClassAttributes.value;
  const names = Object.keys(source);
  const seen = new Set<string>();
  const rows: SchemaClassRow[] = [];
  for (const name of names) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    if (needle && !name.toLowerCase().includes(needle)) continue;
    const entry = source[name];
    rows.push({ name, must: entry.must ?? [], may: entry.may ?? [], definition: "" });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
});

// -- 三类补充分类（F2b）：列表行 + 页签可见性 + 明细数据源 --------------------

/** 列表行主文本：名称组优先（逗号连接），无名称回退 OID。 */
function namesOrOid(names: string[] | undefined, oid: string): string {
  return names?.length ? names.join(", ") : oid;
}

/** Syntax 列表行主文本：DESC 优先，缺省回退 OID。 */
function syntaxLabel(row: LdapSyntaxDef): string {
  return row.desc?.trim() || row.oid;
}

/** 列表过滤：任一字段（名称/OID/描述等）含关键字即命中；空关键字全通过。 */
function matchesKeyword(...fields: Array<string | undefined>): boolean {
  const needle = keyword.value.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}

const matchingRuleRows = computed(() =>
  (cache.matchingRules.value ?? [])
    .filter((row) => matchesKeyword(namesOrOid(row.names, row.oid), row.oid, row.desc))
    .sort((left, right) => namesOrOid(left.names, left.oid).localeCompare(namesOrOid(right.names, right.oid))),
);

const matchingRuleUseRows = computed(() =>
  (cache.matchingRuleUses.value ?? [])
    .filter((row) => matchesKeyword(namesOrOid(row.names, row.oid), row.oid, ...(row.attributeTypes ?? [])))
    .sort((left, right) => namesOrOid(left.names, left.oid).localeCompare(namesOrOid(right.names, right.oid))),
);

const syntaxRows = computed(() =>
  (cache.ldapSyntaxes.value ?? [])
    .filter((row) => matchesKeyword(syntaxLabel(row), row.oid, row.desc))
    .sort((left, right) => syntaxLabel(left).localeCompare(syntaxLabel(right))),
);

// 页签可见性按「未过滤总数」判断：过滤字把列表清空不应导致页签闪没。
const categoryTabs = computed(() => {
  const tabs: Array<{ key: SchemaCategory; label: string }> = [
    { key: "attributeTypes", label: t("schema.attributeTypes") },
    { key: "objectClasses", label: t("schema.objectClasses") },
  ];
  // 三类为空（旧 sidecar undefined / 空数组）时隐藏对应页签。
  if ((cache.matchingRules.value ?? []).length > 0) tabs.push({ key: "matchingRules", label: t("schema.matchingRules") });
  if ((cache.matchingRuleUses.value ?? []).length > 0) tabs.push({ key: "matchingRuleUses", label: t("schema.matchingRuleUses") });
  if ((cache.ldapSyntaxes.value ?? []).length > 0) tabs.push({ key: "syntaxes", label: t("schema.syntaxes") });
  return tabs;
});

// 刷新后某分类可能消失（服务端不再透出）：当前页签失效则回退基础分类。
watch(categoryTabs, (tabs) => {
  if (!tabs.some((tab) => tab.key === activeTab.value)) activeTab.value = "attributeTypes";
});

// 选中明细数据源：按 oid 精确匹配（选中键即 oid）。
const selectedMatchingRuleDef = computed(() =>
  selectedMatchingRule.value ? (cache.matchingRules.value ?? []).find((row) => row.oid === selectedMatchingRule.value) : undefined,
);
const selectedMatchingRuleUseDef = computed(() =>
  selectedMatchingRuleUse.value ? (cache.matchingRuleUses.value ?? []).find((row) => row.oid === selectedMatchingRuleUse.value) : undefined,
);
const selectedSyntaxDef = computed(() =>
  selectedSyntax.value ? (cache.ldapSyntaxes.value ?? []).find((row) => row.oid === selectedSyntax.value) : undefined,
);

watch(
  () => [props.open, props.connectionId] as const,
  ([open, connectionId]) => {
    if (!open || !connectionId) return;
    void cache.ensureLoaded(connectionId).catch((cause) => emit("error", cause instanceof Error ? cause.message : String(cause)));
  },
  { immediate: true },
);

async function refresh() {
  try {
    const { ldapApi } = await import("../lib/api");
    // Bypass the server-side cache first, then drop the in-process entry so
    // the loader refetches the fresh payload.
    await ldapApi.schema(true);
    cache.invalidate(props.connectionId);
    await cache.ensureLoaded(props.connectionId);
  } catch (cause) {
    emit("error", cause instanceof Error ? cause.message : String(cause));
  }
}

// Esc 关闭 + Tab 焦点陷阱（useModalA11y 统一接线）。
useModalA11y(
  () => props.open,
  { close: () => emit("close") },
);
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal panel-modal" role="dialog" aria-modal="true" :aria-label="t('schema.title')">
      <header>
        <h2><Database aria-hidden="true" style="width: 14px; height: 14px" /> {{ t("schema.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <div class="settings-field" style="flex-direction: row; align-items: center; gap: 8px">
        <input v-model="keyword" type="text" :placeholder="t('schema.searchPlaceholder')" spellcheck="false" style="flex: 1" />
        <button type="button" class="toolbar-button" :title="t('schema.refresh')" @click="refresh">
          <RefreshCw :class="{ spinning: cache.loading.value }" /><span>{{ t("schema.refresh") }}</span>
        </button>
      </div>
      <p class="hint">{{ t("schema.refreshHint") }}</p>
      <div class="settings-body">
        <!-- 五分类页签（对标 ADS Schema Browser）：空分类页签隐藏；键盘交互走原生 button。 -->
        <div class="mode-switch schema-tabs" role="tablist" :aria-label="t('schema.title')">
          <button
            v-for="tab in categoryTabs"
            :key="tab.key"
            type="button"
            role="tab"
            :class="{ 'is-active': activeTab === tab.key }"
            :aria-selected="activeTab === tab.key"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </div>
        <div class="schema-cols">
          <!-- 当前分类列表列：一次只渲染激活页签的列表（复用现有行/选中交互）。 -->
          <div class="schema-col">
            <template v-if="activeTab === 'attributeTypes'">
              <h3>{{ t("schema.attributeTypes") }} <span class="muted">({{ attributeRows.length }})</span></h3>
              <ul>
                <li v-for="name in attributeRows" :key="name" class="mono schema-attribute-row" :class="{ 'is-selected': name === selectedAttribute }" @click="selectAttribute(name)">
                  <button type="button" class="schema-attribute-button mono" @click.stop="selectAttribute(name)">{{ name }}</button>
                  <div v-if="name === selectedAttribute && selectedAttributeInfo" class="schema-def">
                    <div v-if="selectedAttributeInfo.syntax">{{ t("schema.syntax") }}: <span class="mono">{{ selectedAttributeInfo.syntax }}</span></div>
                    <div v-if="selectedAttributeInfo.equality">{{ t("schema.equality") }}: {{ selectedAttributeInfo.equality }}</div>
                    <div v-if="selectedAttributeInfo.singleValue">{{ t("schema.singleValue") }}</div>
                    <div v-if="selectedAttributeInfo.noUserModification">{{ t("schema.noUserModification") }}</div>
                  </div>
                </li>
                <li v-if="attributeRows.length === 0" class="muted">{{ attributeEmptyText }}</li>
              </ul>
            </template>
            <template v-else-if="activeTab === 'objectClasses'">
              <h3>{{ t("schema.objectClasses") }} <span class="muted">({{ objectClassRows.length }})</span></h3>
              <ul>
                <li
                  v-for="row in objectClassRows"
                  :key="row.name"
                  class="schema-attribute-row schema-oc-row"
                  :class="{ 'is-selected': row.name === selectedObjectClass }"
                  :title="row.definition"
                  @click="selectObjectClass(row.name)"
                >
                  <strong class="mono">{{ row.name }}</strong>
                  <div v-if="row.must.length" class="schema-def">{{ t("schema.must") }}: {{ row.must.join(", ") }}</div>
                  <div v-if="row.may.length" class="schema-def">{{ t("schema.may") }}: {{ row.may.join(", ") }}</div>
                </li>
                <li v-if="objectClassRows.length === 0" class="muted">{{ objectClassEmptyText }}</li>
              </ul>
            </template>
            <!-- 三类补充分类（F2b）：行样式/过滤/选中交互沿用属性列模式。 -->
            <template v-else-if="activeTab === 'matchingRules'">
              <h3>{{ t("schema.matchingRules") }} <span class="muted">({{ matchingRuleRows.length }})</span></h3>
              <ul>
                <li v-for="row in matchingRuleRows" :key="row.oid" class="schema-attribute-row" :class="{ 'is-selected': row.oid === selectedMatchingRule }" @click="selectMatchingRule(row.oid)">
                  <button type="button" class="schema-attribute-button mono" @click.stop="selectMatchingRule(row.oid)">{{ namesOrOid(row.names, row.oid) }}</button>
                </li>
                <li v-if="matchingRuleRows.length === 0" class="muted">{{ listEmptyText }}</li>
              </ul>
            </template>
            <template v-else-if="activeTab === 'matchingRuleUses'">
              <h3>{{ t("schema.matchingRuleUses") }} <span class="muted">({{ matchingRuleUseRows.length }})</span></h3>
              <ul>
                <li
                  v-for="row in matchingRuleUseRows"
                  :key="row.oid"
                  class="schema-attribute-row"
                  :class="{ 'is-selected': row.oid === selectedMatchingRuleUse }"
                  @click="selectMatchingRuleUse(row.oid)"
                >
                  <button type="button" class="schema-attribute-button mono" @click.stop="selectMatchingRuleUse(row.oid)">{{ namesOrOid(row.names, row.oid) }}</button>
                </li>
                <li v-if="matchingRuleUseRows.length === 0" class="muted">{{ listEmptyText }}</li>
              </ul>
            </template>
            <template v-else>
              <h3>{{ t("schema.syntaxes") }} <span class="muted">({{ syntaxRows.length }})</span></h3>
              <ul>
                <li v-for="row in syntaxRows" :key="row.oid" class="schema-attribute-row" :class="{ 'is-selected': row.oid === selectedSyntax }" @click="selectSyntax(row.oid)">
                  <button type="button" class="schema-attribute-button mono" @click.stop="selectSyntax(row.oid)">{{ syntaxLabel(row) }}</button>
                </li>
                <li v-if="syntaxRows.length === 0" class="muted">{{ listEmptyText }}</li>
              </ul>
            </template>
          </div>
          <!-- 明细卡（Master-Details）：OID/NAME/DESC 标签沿用 RFC 4512 关键字
               （预置文案键未覆盖这三个字段名）；其余标题走 schema.* 键。 -->
          <div class="schema-col schema-detail-col">
            <h3>{{ t("schema.details") }}</h3>
            <div class="schema-detail-body">
              <dl v-if="selectedAttribute" class="kv-grid">
                <dt>OID</dt>
                <dd class="mono">{{ selectedAttributeRaw?.oid || "—" }}</dd>
                <dt>NAME</dt>
                <dd class="mono">{{ selectedAttributeRaw?.names.join(", ") || selectedAttribute }}</dd>
                <template v-if="selectedAttributeRaw?.desc">
                  <dt>DESC</dt>
                  <dd>{{ selectedAttributeRaw.desc }}</dd>
                </template>
                <template v-if="selectedAttributeInfo?.syntax">
                  <dt>{{ t("schema.syntax") }}</dt>
                  <dd class="mono">{{ selectedAttributeInfo.syntax }}</dd>
                </template>
                <template v-if="selectedAttributeInfo?.equality">
                  <dt>{{ t("schema.equality") }}</dt>
                  <dd>{{ selectedAttributeInfo.equality }}</dd>
                </template>
                <template v-if="selectedAttributeInfo?.singleValue">
                  <dt>{{ t("schema.singleValue") }}</dt>
                  <dd>✓</dd>
                </template>
                <template v-if="selectedAttributeInfo?.noUserModification">
                  <dt>{{ t("schema.noUserModification") }}</dt>
                  <dd>✓</dd>
                </template>
                <dt>{{ t("schema.kind") }}</dt>
                <dd class="mono">{{ selectedAttributeKind }}</dd>
                <template v-if="selectedAttributeReferences.length">
                  <dt>{{ t("schema.referencedBy") }}</dt>
                  <dd>{{ selectedAttributeReferences.join(", ") }}</dd>
                </template>
              </dl>
              <dl v-else-if="selectedObjectClass" class="kv-grid">
                <dt>OID</dt>
                <dd class="mono">{{ selectedObjectClassRaw?.oid || "—" }}</dd>
                <dt>NAME</dt>
                <dd class="mono">{{ selectedObjectClassRaw?.names.join(", ") || selectedObjectClass }}</dd>
                <template v-if="selectedObjectClassRaw?.desc">
                  <dt>DESC</dt>
                  <dd>{{ selectedObjectClassRaw.desc }}</dd>
                </template>
                <template v-if="selectedObjectClassSupers.length">
                  <dt>{{ t("schema.superior") }}</dt>
                  <dd>{{ selectedObjectClassSupers.join(" → ") }}</dd>
                </template>
                <template v-if="selectedObjectClassEntry?.must.length">
                  <dt>{{ t("schema.must") }}</dt>
                  <dd>{{ selectedObjectClassEntry.must.join(", ") }}</dd>
                </template>
                <template v-if="selectedObjectClassEntry?.may.length">
                  <dt>{{ t("schema.may") }}</dt>
                  <dd>{{ selectedObjectClassEntry.may.join(", ") }}</dd>
                </template>
                <template v-if="selectedObjectClassReferences.length">
                  <dt>{{ t("schema.referencedBy") }}</dt>
                  <dd>{{ selectedObjectClassReferences.join(", ") }}</dd>
                </template>
              </dl>
              <!-- 匹配规则明细（F2b）：OID/名称/描述/语法 OID。 -->
              <dl v-else-if="selectedMatchingRuleDef" class="kv-grid">
                <dt>OID</dt>
                <dd class="mono">{{ selectedMatchingRuleDef.oid || "—" }}</dd>
                <dt>NAME</dt>
                <dd class="mono">{{ namesOrOid(selectedMatchingRuleDef.names, selectedMatchingRuleDef.oid) }}</dd>
                <template v-if="selectedMatchingRuleDef.desc">
                  <dt>DESC</dt>
                  <dd>{{ selectedMatchingRuleDef.desc }}</dd>
                </template>
                <template v-if="selectedMatchingRuleDef.syntax">
                  <dt>{{ t("schema.syntax") }}</dt>
                  <dd class="mono">{{ selectedMatchingRuleDef.syntax }}</dd>
                </template>
              </dl>
              <!-- 匹配规则用途明细（F2b）：OID/名称/适用于属性列表。 -->
              <dl v-else-if="selectedMatchingRuleUseDef" class="kv-grid">
                <dt>OID</dt>
                <dd class="mono">{{ selectedMatchingRuleUseDef.oid || "—" }}</dd>
                <dt>NAME</dt>
                <dd class="mono">{{ namesOrOid(selectedMatchingRuleUseDef.names, selectedMatchingRuleUseDef.oid) }}</dd>
                <dt>{{ t("schema.applies") }}</dt>
                <dd class="mono">{{ selectedMatchingRuleUseDef.attributeTypes?.length ? selectedMatchingRuleUseDef.attributeTypes.join(", ") : "—" }}</dd>
              </dl>
              <!-- LDAP 语法明细（F2b）：OID/描述。 -->
              <dl v-else-if="selectedSyntaxDef" class="kv-grid">
                <dt>OID</dt>
                <dd class="mono">{{ selectedSyntaxDef.oid || "—" }}</dd>
                <template v-if="selectedSyntaxDef.desc">
                  <dt>DESC</dt>
                  <dd>{{ selectedSyntaxDef.desc }}</dd>
                </template>
              </dl>
              <p v-else class="muted">{{ detailEmptyText }}</p>
            </div>
          </div>
        </div>
      </div>
      <footer>
        <button type="button" @click="emit('close')">{{ t("close") }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 页签化后列表区固定为「单列表 + 明细」双列：scoped 覆盖全局 .schema-cols
   （不动全局样式），明细信息更宽，占更大列宽。列必须用 minmax(0,·) 而非裸
   fr——裸 fr 的自动下限是列内容 min-content，宽字体/窄弹窗下列宽会被列表
   列的不可断行内容夺走，明细列被压到 ~90px、OID 逐字符断行（走查实测）。 */
.schema-cols {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
}
/* 分类页签行：复用全局 .mode-switch 样式，仅固定行高避免被拉伸。 */
.schema-tabs {
  flex: 0 0 auto;
}
/* 明细卡容器沿用属性列 ul 的盒样式（边框/圆角/滚动），内容走 kv-grid。 */
.schema-detail-body {
  min-height: 0;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: auto;
  padding: 6px 8px;
}
/* objectClass 行改为可点选：沿用属性列的指针手型。 */
.schema-oc-row {
  cursor: pointer;
}
</style>
