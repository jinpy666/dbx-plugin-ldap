<script setup lang="ts">
// 搜索表单：可视化条件构建器（FilterGroup 递归树，AND/OR 嵌套 ≤2 层）+
// 源码模式（RFC 4515 串直接编辑，双向：串→结构尽力解析，失败保持源码模式）
// + scope/attributes/sizeLimit/pageSize/typesOnly/derefAliases
// + 预设（持久化过滤器串，应用时重建构建器；sidecar 不存 conditions）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { ChevronDown, ChevronUp, Clock3, Copy, FolderInput, History, Pencil, Play, RotateCcw, Save, Trash2 } from "@lucide/vue";
import { getLdapConnectionId, ldapApi, type LdapSearchPreset, type LdapScope } from "../lib/api";
import { validateLDAPFilter, buildNodeFilter, collectBuilderErrors, parseFilterStructure, toBuilderRoot, createBuilderClause, createBuilderGroup, type BuilderGroup } from "../lib/ldapFilter";
import { parseLdapSearchCommand, type LdapSearchCommandFailure } from "../lib/ldapSearchCommand";
import { parsePsAdCommand } from "../lib/psCommandImport";
import { useLdapSchemaCache } from "../lib/schemaCache";
import { t, workbenchLocale } from "../lib/i18n";
import FilterGroup from "./FilterGroup.vue";

// 表单模型类型唯一权威定义在 lib/useSearchSession.ts（审计 J-10）：此处只做
// 类型导入并原样 re-export，保持既有 `import SearchForm, { type SearchFormModel }`
// 消费方兼容，消除两份会漂移的双定义。
import type { SearchFormModel } from "../lib/useSearchSession";

export type { SearchFormModel };

const props = defineProps<{
  baseDn: string;
  disabled?: boolean;
  running?: boolean;
}>();

const emit = defineEmits<{
  (e: "run", model: SearchFormModel): void;
  (e: "notify", message: string): void;
  (e: "error", message: string): void;
}>();

/** 表单默认值：匹配全部 + 连接 Base + 子树范围 + 全属性（重置共用同一份）。 */
function defaultSearchModel(baseDn = props.baseDn): SearchFormModel {
  return {
    baseDn,
    filter: "(objectClass=*)",
    scope: "sub",
    attributes: "",
    sizeLimit: "500",
    pageSize: "500",
    typesOnly: false,
    derefAliases: "never",
    sortBy: "",
    sortOrder: "asc",
  };
}

const draft = ref<SearchFormModel>(defaultSearchModel());

// -- filter builder / source modes --------------------------------------------

const builderMode = ref(true);
const builderRoot = ref<BuilderGroup>(createBuilderGroup({ children: [createBuilderClause()] }));
const sourceFilter = ref("");
const sourceParseError = ref(false);
const filterErrorId = useId();
const sizeLimitErrorId = useId();
const pageSizeErrorId = useId();

const ATTR_LIST_ID = "ldap-builder-attr-options";
// schema 不可用时的常用属性兜底（tiny-rdm 常用集）。
const COMMON_ATTRIBUTES = [
  "objectClass", "cn", "sn", "givenName", "uid", "mail", "ou", "o", "dc",
  "displayName", "telephoneNumber", "member", "description", "title",
  "sAMAccountName", "userPrincipalName", "objectGUID", "createTimestamp", "modifyTimestamp",
];

// 属性 datalist 数据源：共享缓存视图（J-8：与 App/SchemaPanel 同源，同连接
// 同 TTL 窗口只拉一次 ldap/schema）。
const { attributeNames, ensureLoaded } = useLdapSchemaCache();

const attributeOptions = computed(() => {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const name of [...COMMON_ATTRIBUTES, ...attributeNames.value]) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(name);
  }
  return options;
});

const generatedFilter = computed(() => buildNodeFilter(builderRoot.value));
const builderErrors = computed(() => collectBuilderErrors(builderRoot.value));
const builderValid = computed(() => builderErrors.value.length === 0);

const builderErrorMessage = computed(() => {
  const first = builderErrors.value[0];
  if (!first) return "";
  if (first.code === "attribute_required" || first.code === "attribute_invalid") return t("search.builderAttrRequired");
  return t("search.builderValueRequired");
});

const sourceValid = computed(() => {
  const value = sourceFilter.value.trim();
  // 空过滤器 = 匹配全部（运行时回退 (objectClass=*)），合法不算错。
  return value === "" || validateLDAPFilter(value);
});

const filterValid = computed(() => (builderMode.value ? builderValid.value : sourceValid.value));

function switchToSource() {
  if (props.disabled) return;
  sourceFilter.value = generatedFilter.value || draft.value.filter;
  sourceParseError.value = false;
  builderMode.value = false;
}

function switchToBuilder() {
  if (props.disabled) return;
  const parsed = toBuilderRoot(parseFilterStructure(sourceFilter.value));
  if (!parsed) {
    // 解析失败：保持源码模式（源码是唯一权威表示）。
    sourceParseError.value = true;
    return;
  }
  builderRoot.value = parsed;
  sourceParseError.value = false;
  builderMode.value = true;
}

/** 过滤器串 → 构建器，解析失败保持源码模式（源码是唯一权威表示）。
 * 预设、MCP intent 与 ldapsearch 命令导入共用这一落地路径。 */
function presentFilter(filter: string) {
  const fromFilter = toBuilderRoot(parseFilterStructure(filter));
  if (fromFilter) {
    builderRoot.value = fromFilter;
    builderMode.value = true;
    sourceParseError.value = false;
  } else {
    sourceFilter.value = filter;
    builderMode.value = false;
  }
}

/** 重置（快捷条图标 / 高级区「重置」共用）：整表还原默认搜索——过滤器回
 * 匹配全部（构建器单条存在子句）、Base 回连接默认、范围/数值框/属性回默认，
 * 命令导入行与错误提示一并清空。这是「改乱/清空后一键还原」的兜底入口。 */
function resetSearch() {
  if (props.disabled) return;
  draft.value = defaultSearchModel();
  commandDraft.value = "";
  commandError.value = "";
  commandWarnings.value = [];
  commandApplied.value = false;
  presentFilter("(objectClass=*)");
  emit("notify", t("search.resetDone"));
}

// -- 折叠快捷条（对标 Apache Directory Studio 的快捷搜索形态）------------------
// 默认折叠：完整面板常驻太占空间。高级区用 hidden 属性收起而非卸载，
// 构建器/源码输入态与焦点都保留，展开即时还原，切换不改任何表单值。
// 偏好记忆 localStorage；宿主 webview 禁存储时静默降级为仅内存态（同 DnTree 侧栏宽）。

const SEARCH_COLLAPSED_KEY = "dbx.ldap.ui.searchCollapsed";

function readStoredCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(SEARCH_COLLAPSED_KEY);
    // 无记录视为折叠（新用户默认紧凑形态）；只有显式 "0" 才记忆为展开。
    return stored === null ? true : stored === "1";
  } catch {
    return true;
  }
}

function persistCollapsed(value: boolean) {
  try {
    localStorage.setItem(SEARCH_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    /* 存储不可用（隐私模式等）：仅内存态 */
  }
}

const collapsed = ref(readStoredCollapsed());

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  // 面板跟随各自锚点分写两份模板，切换形态时不把打开状态带过去。
  historyOpen.value = false;
  persistCollapsed(collapsed.value);
}

/** 宿主入口（MCP focus intent 等接线用）：把表单展开到完整形态，不动任何表单值。 */
function expandSearch() {
  collapsed.value = false;
  historyOpen.value = false;
  persistCollapsed(collapsed.value);
}

// -- 历史过滤器（对账表 P1，对标 ADS 搜索历史）---------------------------------
// 本地留存最近 N 条搜索过滤器（localStorage，宿主 webview 禁存储时静默降级，
// 同 DnTree 侧栏宽）。应用只回填表单不自动运行，保持"先确认后运行"的节奏。

interface SearchHistoryEntry {
  filter: string;
  baseDn: string;
  scope: LdapScope;
  attributes: string;
  timestamp: number;
}

// 历史键按连接派生（审计 J-3）：全局键会让切换连接后应用历史时把上一台
// 目录的 baseDn/条件灌进当前表单。getLdapConnectionId 是非响应式模块 getter，
// 键必须在保存/读取时刻现取（不可固化为顶层常量）；连接未知（宿主上下文
// 未就绪）时统一落 "default" 段。旧全局键一次性忽略：不读取也不迁移，
// 其内容随各连接新键的写入自然淘汰。
const SEARCH_HISTORY_KEY_PREFIX = "dbx.ldap.ui.searchHistory";
const SEARCH_HISTORY_MAX = 10;

function searchHistoryKey(): string {
  const connectionId = getLdapConnectionId().trim();
  return `${SEARCH_HISTORY_KEY_PREFIX}.${connectionId || "default"}`;
}

// 存储内容可能被旧版本或人为写坏：读取时只接受形状完整的条目。
function isHistoryEntry(value: unknown): value is SearchHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.filter === "string" &&
    typeof entry.baseDn === "string" &&
    typeof entry.attributes === "string" &&
    (entry.scope === "base" || entry.scope === "one" || entry.scope === "sub") &&
    (entry.timestamp === undefined || (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)))
  );
}

function readStoredHistory(): SearchHistoryEntry[] {
  try {
    // 每次读取现取按连接派生的键：切连接后读到的就是新连接自己的历史。
    const parsed: unknown = JSON.parse(localStorage.getItem(searchHistoryKey()) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(isHistoryEntry).map((entry) => ({ ...entry, timestamp: entry.timestamp ?? 0 })).slice(0, SEARCH_HISTORY_MAX)
      : [];
  } catch {
    return []; // 存储不可用/JSON 损坏：降级为空历史
  }
}

function persistHistory() {
  try {
    localStorage.setItem(searchHistoryKey(), JSON.stringify(searchHistory.value));
  } catch {
    /* 存储不可用（隐私模式等）：仅内存态 */
  }
}

const searchHistory = ref<SearchHistoryEntry[]>(readStoredHistory());

function sameHistoryEntry(a: SearchHistoryEntry, b: SearchHistoryEntry): boolean {
  return a.filter === b.filter && a.baseDn === b.baseDn && a.scope === b.scope && a.attributes === b.attributes;
}

/** 宿主（App）在搜索成功后调用入队并持久化：与队首逐字段相同不重复记，
 * 更早的相同条目前移（对标 ADS 语义），上限 10 条。filter 存实际生效串
 * （toModel 已兜底 (objectClass=*)，照存）。写回前按当前连接现读：组件
 * 不随连接切换重建（App 无 :key），仅信内存态会把新连接存储覆盖回旧列表。 */
function recordSearch(model: SearchFormModel) {
  const entry: SearchHistoryEntry = {
    filter: model.filter,
    baseDn: model.baseDn,
    scope: model.scope,
    attributes: model.attributes,
    timestamp: Date.now(),
  };
  const current = readStoredHistory();
  if (current[0] && sameHistoryEntry(current[0], entry)) return;
  searchHistory.value = [entry, ...current.filter((existing) => !sameHistoryEntry(existing, entry))].slice(0, SEARCH_HISTORY_MAX);
  persistHistory();
}

// 两种形态各挂一个触发按钮（快捷条 / filter-head 右侧），切换同一个下拉状态；
// 面板绝对定位于各自按钮下方，因此按分支各写一份面板模板（不引入浮动层）。
const historyOpen = ref(false);
// filter-head 常驻 DOM（靠 hidden 收起），两个锚点须各自持 ref，
// 外点判定对两个容器做 containment（同一时刻只有一个面板可见）。
const historyRootCompact = ref<HTMLElement | null>(null);
const historyRootExpanded = ref<HTMLElement | null>(null);

function toggleHistory() {
  if (props.disabled) return;
  // 打开面板时按当前连接现读刷新内存态（组件不随连接切换重建，
  // setup 时的初值在切连接后会陈旧）；关闭不刷。
  if (!historyOpen.value) searchHistory.value = readStoredHistory();
  historyOpen.value = !historyOpen.value;
}

function applyHistory(entry: SearchHistoryEntry) {
  if (props.disabled) return;
  draft.value.baseDn = entry.baseDn;
  draft.value.scope = entry.scope;
  draft.value.attributes = entry.attributes;
  // 过滤器串走既有 presentFilter：可解析进构建器，不可解析落源码模式（源码是唯一权威表示）。
  presentFilter(entry.filter);
  historyOpen.value = false;
  emit("notify", t("search.historyApplied"));
}

function formatHistoryTime(timestamp: number): string {
  if (!timestamp) return "—";
  try {
    return new Intl.DateTimeFormat(workbenchLocale.value, { dateStyle: "short", timeStyle: "short" }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function clearHistory() {
  // 搜索历史只是本地辅助数据，直接清空避免宿主 webview 的原生确认框
  // 被拦截后看起来像按钮失效；面板保持打开并显示空状态。
  searchHistory.value = [];
  persistHistory();
}

// 外点/Esc 关闭：containment 判定（面板内点击不算外点），mount 注册、卸载清理（同 DnTree 右键菜单）。
function onHistoryDocClick(event: MouseEvent) {
  if (!historyOpen.value) return;
  const target = event.target as Node;
  if (historyRootCompact.value?.contains(target) || historyRootExpanded.value?.contains(target)) return;
  historyOpen.value = false;
}

function onHistoryDocKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") historyOpen.value = false;
}

onMounted(() => {
  document.addEventListener("click", onHistoryDocClick);
  document.addEventListener("keydown", onHistoryDocKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onHistoryDocClick);
  document.removeEventListener("keydown", onHistoryDocKeydown);
});

// -- base DN / fields ---------------------------------------------------------

// 树节点联动改写 Base DN 的一次性高亮（UI 扫描 P2-7：此前静默改写，
// 整树搜索悄然变单条目搜索）。变化时高亮 1.6s + title 说明。
const baseDnHighlighted = ref(false);
let baseDnHighlightTimer = 0;

// highlight=false 供初始化/自动定位使用（首次回填不算"跟随选中"），
// 并取消进行中的高亮。
function applyBaseDn(next: string, highlight = true) {
  const changed = next !== draft.value.baseDn && next.trim() !== "";
  draft.value.baseDn = next;
  window.clearTimeout(baseDnHighlightTimer);
  if (!changed || !highlight) {
    baseDnHighlighted.value = false;
    return;
  }
  baseDnHighlighted.value = true;
  baseDnHighlightTimer = window.setTimeout(() => (baseDnHighlighted.value = false), 1600);
}

onBeforeUnmount(() => window.clearTimeout(baseDnHighlightTimer));

defineExpose({ applyBaseDn, runSubtreeAt, runFilterAt, applyIntentSearch, expandSearch, recordSearch });

// 树右键「搜索此子树」直达（此前只改 Base 不执行，用户预期是马上出结果集）：
// Base 指到该节点、范围强制切到子树并立即运行。过滤器沿用表单当前配置；
// 构建器存在半填/未填子句（表单本身不可运行）时回退匹配全部
// (objectClass=*)——右键动作是浏览意图，必须保证出结果集而不是静默失败。
function runSubtreeAt(dn: string) {
  if (props.disabled || !numericValid.value) return;
  applyBaseDn(dn);
  draft.value.scope = "sub";
  const model = toModel();
  emit("run", filterValid.value ? model : { ...model, filter: "(objectClass=*)" });
}

/** 树右键「成员」直达：立即以指定过滤器在指定 Base 下做子树搜索。
 * 过滤器由调用方组织（如 (memberOf=<组DN>)）；源码模式承载该过滤器，
 * 用户可在结果区继续改；Base/范围语义同 runSubtreeAt。 */
function runFilterAt(baseDn: string, filter: string) {
  if (props.disabled || !numericValid.value) return;
  // 防呆：空过滤器视为匹配全部，与 toModel 的兜底语义一致，保证必出结果集。
  const effectiveFilter = filter.trim() === "" ? "(objectClass=*)" : filter;
  // 切到源码模式承载调用方过滤器（源码是唯一权威表示，构建器无需逆向解析）。
  sourceFilter.value = effectiveFilter;
  sourceParseError.value = false;
  builderMode.value = false;
  applyBaseDn(baseDn);
  draft.value.scope = "sub";
  emit("run", { ...toModel(), filter: effectiveFilter });
}

/** MCP UI intent（useUiIntent）落表：条件整体替换走既有 preset 反序列化
 * 路径（过滤器串 → 构建器，解析失败保持源码模式）；scope/sizeLimit 越界
 * 值兜底当前值。返回组装好的模型供 App 触发 runSearch。 */
function applyIntentSearch(params: {
  baseDn?: string;
  filter?: string;
  scope?: string;
  attributes?: string[];
  sizeLimit?: number;
}): SearchFormModel {
  const filter = (params.filter ?? "").trim() || "(objectClass=*)";
  presentFilter(filter);
  const scope = (params.scope ?? "").trim().toLowerCase();
  const sizeLimit = Number(params.sizeLimit);
  draft.value = {
    ...draft.value,
    baseDn: (params.baseDn ?? "").trim() || draft.value.baseDn,
    filter,
    scope: scope === "base" || scope === "one" || scope === "sub" ? scope : draft.value.scope,
    attributes: Array.isArray(params.attributes) && params.attributes.length ? params.attributes.join(", ") : draft.value.attributes,
    sizeLimit: Number.isFinite(sizeLimit) && sizeLimit > 0 ? String(sizeLimit) : draft.value.sizeLimit,
  };
  return toModel();
}

function parseAttributes(): string[] | undefined {
  const list = draft.value.attributes
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

// 与 lib/useSearchSession.ts 的 positiveInt 语义一致（正整数解析）；
// lib 未导出该函数且不在本组件可改范围内，故本文件保留此副本，
// 两处如需演进须同步。
function positiveNumber(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// 数值字段输入校验（UI 扫描 P2-16）：非法输入不再静默按"无限制"发出；
// 留空或 0 合法（= 不限制），负数/非数字给行内红字。
function numericInvalid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && (!/^\d+$/u.test(trimmed) || !Number.isSafeInteger(Number(trimmed)));
}
const sizeLimitInvalid = computed(() => numericInvalid(draft.value.sizeLimit));
const pageSizeInvalid = computed(() => numericInvalid(draft.value.pageSize));
const numericValid = computed(() => !sizeLimitInvalid.value && !pageSizeInvalid.value);

function activeFilter(): string {
  return builderMode.value ? generatedFilter.value : sourceFilter.value.trim();
}

// 快捷条过滤器框：构建器模式只展示生成串，用户一旦输入即落源码模式
// （源码是唯一权威表示，同 runFilterAt），快捷条因此不设第二套过滤器状态。
const compactFilterValue = computed(() => (builderMode.value ? generatedFilter.value : sourceFilter.value));

function onCompactFilterInput(event: Event) {
  if (props.disabled) return;
  sourceFilter.value = (event.target as HTMLInputElement).value;
  sourceParseError.value = false;
  builderMode.value = false;
}

// 快捷条行内错误：空构建器条件（attribute_required）不算错——与右键子树搜索
// 的兜底同义（匹配全部），红字常驻只会骚扰；条件填坏或源码非法才提示，
// Run 按钮 title 始终兜底说明不可运行的原因。
const compactFilterError = computed(() => {
  if (filterValid.value) return "";
  if (!builderMode.value) return t("search.filterInvalid");
  const first = builderErrors.value[0];
  return first && first.code !== "attribute_required" ? builderErrorMessage.value : "";
});

function toModel(): SearchFormModel {
  return { ...draft.value, filter: activeFilter() || "(objectClass=*)" };
}

function run() {
  if (props.disabled || props.running || !filterValid.value || !numericValid.value) return;
  emit("run", toModel());
}

// -- ldapsearch command import --------------------------------------------------

const COMMAND_FAILURE_KEYS = {
  empty: "search.commandErrorEmpty",
  missingValue: "search.commandErrorMissingValue",
  missingBaseDn: "search.commandErrorMissingBaseDn",
  unknownOption: "search.commandErrorUnknownOption",
  scope: "search.commandErrorScope",
  derefAliases: "search.commandErrorDerefAliases",
  sizeLimit: "search.commandErrorSizeLimit",
  filter: "search.commandErrorFilter",
  filterFile: "search.commandErrorFilterFile",
} as const satisfies Record<LdapSearchCommandFailure["reason"], string>;

const commandDraft = ref("");
const commandError = ref("");
const commandWarnings = ref<string[]>([]);
const commandApplied = ref(false);

function commandFailureMessage(failure: LdapSearchCommandFailure): string {
  const params: Record<string, string> = {};
  if (failure.flag) params.flag = failure.flag;
  if (failure.value) params.value = failure.value;
  return t(COMMAND_FAILURE_KEYS[failure.reason], params);
}

function applyCommand() {
  if (props.disabled) return;
  const commandText = commandDraft.value.trim();
  commandApplied.value = false;
  // PowerShell AD/QAD 命令（Get-ADUser/Get-QADUser…）走专用解析器（阶段4）
  if (/^get-(ad|qad)/iu.test(commandText)) {
    const result = parsePsAdCommand(commandText);
    if (!result.ok) {
      commandWarnings.value = [];
      commandError.value = t("search.psCommandError", { value: result.value ?? "" });
      return;
    }
    draft.value = {
      ...draft.value,
      baseDn: result.search.baseDn || draft.value.baseDn,
      filter: result.search.filter,
      scope: result.search.scope,
      attributes: result.search.attributes.join(", "),
      sizeLimit: String(result.search.sizeLimit ?? 0),
    };
    presentFilter(result.search.filter);
    const warnings: string[] = [];
    for (const note of result.notes) {
      if (note === "noSearchBase") warnings.push(t("search.psNoteNoSearchBase"));
      else if (note.startsWith("op:")) warnings.push(t("search.psNoteOp", { op: note.slice(3) }));
    }
    if (result.ignored.length > 0) warnings.push(t("search.psIgnored", { flags: result.ignored.join(" ") }));
    commandWarnings.value = warnings;
    commandError.value = "";
    commandApplied.value = true;
    emit("notify", t("search.commandApplied"));
    return;
  }
  const result = parseLdapSearchCommand(commandDraft.value);
  commandApplied.value = false;
  if (!result.ok) {
    commandWarnings.value = [];
    commandError.value = commandFailureMessage(result);
    return;
  }
  // 命令没带 -b 时保留当前 Base DN（可能来自树节点联动），不覆盖为空。
  commandError.value = "";
  draft.value = {
    ...draft.value,
    baseDn: result.search.baseDn || draft.value.baseDn,
    filter: result.search.filter,
    scope: result.search.scope,
    attributes: result.search.attributes.join(", "),
    sizeLimit: String(result.search.sizeLimit ?? 0),
    typesOnly: result.search.typesOnly,
    derefAliases: result.search.derefAliases ?? draft.value.derefAliases,
  };
  presentFilter(result.search.filter);
  const warnings: string[] = [];
  if (result.ignoredConnection.length) {
    warnings.push(t("search.commandWarnConnection", { flags: result.ignoredConnection.join(" ") }));
  }
  if (result.ignoredUnsupported.length) {
    warnings.push(t("search.commandWarnUnsupported", { flags: result.ignoredUnsupported.join(" ") }));
  }
  if (result.notes.includes("scopeChildren")) warnings.push(t("search.commandNoteScopeChildren"));
  commandWarnings.value = warnings;
  commandApplied.value = true;
  emit("notify", t("search.commandApplied"));
}

// -- presets -------------------------------------------------------------------

const presets = ref<LdapSearchPreset[]>([]);
const selectedPresetId = ref("");
const presetNameDraft = ref("");
const presetPending = ref(false);

async function loadPresets() {
  if (props.disabled) return;
  try {
    const result = await ldapApi.presetsList();
    presets.value = Array.isArray(result.presets) ? result.presets : [];
  } catch {
    // presets are a convenience feature; a missing/failed backend must not
    // break the workbench — keep the local list empty.
    presets.value = [];
  }
}

function applyPreset() {
  const preset = presets.value.find((entry) => entry.id === selectedPresetId.value);
  if (!preset) return;
  presetNameDraft.value = preset.name;
  draft.value = {
    ...draft.value,
    baseDn: preset.baseDn || "",
    filter: preset.filter || "(objectClass=*)",
    scope: preset.scope || "sub",
    attributes: Array.isArray(preset.attributes) ? preset.attributes.join(", ") : "",
    sizeLimit: String(preset.sizeLimit ?? 0),
  };
  // 过滤器串是后端持久化的权威值；旧 mock 的 conditions 不参与恢复。
  presentFilter(preset.filter || "(objectClass=*)");
  emit("notify", t("search.presetApplied"));
}

async function savePreset() {
  if (props.disabled || presetPending.value || !filterValid.value || !numericValid.value) return;
  const name = presetNameDraft.value.trim();
  if (!name) return;
  const filter = activeFilter() || "(objectClass=*)";
  // 重名处理：未选中预设时输入已存在的名字 → 原地更新该预设（沿用其 id），
  // 不产生同名双条目；选中状态下保存仍按所选 id 覆盖（含改名）。
  const existingByName = selectedPresetId.value ? undefined : presets.value.find((entry) => entry.name === name);
  // F11：覆盖保存沿用所选预设的分组——表单本身不编辑分组，分组由动作按钮管理。
  const selected = presets.value.find((entry) => entry.id === selectedPresetId.value);
  const preset: LdapSearchPreset = {
    id: selectedPresetId.value || existingByName?.id || "",
    name,
    baseDn: draft.value.baseDn.trim(),
    filter,
    scope: draft.value.scope,
    attributes: parseAttributes(),
    sizeLimit: positiveNumber(draft.value.sizeLimit),
    ...(selected?.group ? { group: selected.group } : {}),
  };
  if (await persistPreset(preset)) emit("notify", t("search.presetSaved"));
}

// 动作/表单共用的保存路径：服务端返回的 preset（含服务端生成的 id）替换
// 旧条目并选中；失败走 error 横幅（预设是便利功能，不让弹层打断主流程）。
async function persistPreset(preset: LdapSearchPreset): Promise<boolean> {
  presetPending.value = true;
  try {
    const result = await ldapApi.presetsSave(preset);
    const saved = result.preset;
    presets.value = [...presets.value.filter((entry) => entry.id !== saved.id), saved];
    selectedPresetId.value = saved.id;
    presetNameDraft.value = saved.name;
    return true;
  } catch (cause) {
    emit("error", cause instanceof Error ? cause.message : String(cause));
    return false;
  } finally {
    presetPending.value = false;
  }
}

// -- 预设动作（F11）：分组渲染 / 重命名 / 创建副本 / 设置分组 -------------------

// 下拉按 group 分组：具名组按首次出现顺序在前，未分组固定垫底；
// 分组名做小标题（optgroup label）。空串/纯空白 group 一律视为未分组。
const groupedPresets = computed(() => {
  const named: Array<{ key: string; label: string; items: LdapSearchPreset[] }> = [];
  const byKey = new Map<string, (typeof named)[number]>();
  let ungrouped: (typeof named)[number] | null = null;
  for (const preset of presets.value) {
    const key = preset.group?.trim() ?? "";
    if (!key) {
      ungrouped ??= { key: "", label: t("presetActions.ungrouped"), items: [] };
      ungrouped.items.push(preset);
      continue;
    }
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: key, items: [] };
      byKey.set(key, group);
      named.push(group);
    }
    group.items.push(preset);
  }
  return ungrouped ? [...named, ungrouped] : named;
});

const selectedPreset = computed(() => presets.value.find((entry) => entry.id === selectedPresetId.value) ?? null);

/** 产出带/不带 group 的预设副本：清空分组时彻底删除键（缺省 = 未分组契约，
 * 不能留 group: undefined 的悬空键——JSON 序列化虽会丢弃，但内存对象/测试
 * 断言都按"键不存在"语义走）。 */
function presetWithGroup(preset: LdapSearchPreset, group: string): LdapSearchPreset {
  const next = { ...preset };
  if (group) next.group = group;
  else delete next.group;
  return next;
}

// 行内小输入框编辑器：null = 关闭；rename 预填名称、group 预填当前分组
// （未分组预填空）。Enter 提交、Esc 取消；键盘完全可完成（原生按钮/输入框）。
const presetEditor = ref<"rename" | "group" | null>(null);
const presetEditorDraft = ref("");
const presetEditorInput = ref<HTMLInputElement | null>(null);

// rename 空值不可提交（无有效名）；group 空值 = 清空分组回到未分组，合法。
const presetEditorInvalid = computed(() => presetEditor.value === "rename" && presetEditorDraft.value.trim() === "");

function openPresetEditor(kind: "rename" | "group") {
  const preset = selectedPreset.value;
  if (!preset || props.disabled) return;
  presetEditor.value = kind;
  presetEditorDraft.value = kind === "rename" ? preset.name : preset.group ?? "";
  void nextTick(() => presetEditorInput.value?.focus());
}

function cancelPresetEditor() {
  presetEditor.value = null;
  presetEditorDraft.value = "";
}

async function commitPresetEditor() {
  const preset = selectedPreset.value;
  const kind = presetEditor.value;
  if (!preset || !kind || props.disabled || presetPending.value || presetEditorInvalid.value) return;
  const value = presetEditorDraft.value.trim();
  if (kind === "rename" && value === preset.name) {
    // 名称未变：视为取消，不发无效保存。
    cancelPresetEditor();
    return;
  }
  const next: LdapSearchPreset = kind === "rename" ? { ...preset, name: value } : presetWithGroup(preset, value);
  cancelPresetEditor();
  if (await persistPreset(next)) emit("notify", t("search.presetSaved"));
}

// 副本名查重：以原名为基底，在现有预设名集合内递增后缀（" (2)"、" (3)"…）
// 直到唯一。否则连续创建副本会叠出多条同名（如 "People (2)" ×2），
// 下拉里既无法区分也无从定位。
function uniqueDuplicateName(baseName: string): string {
  const taken = new Set(presets.value.map((entry) => entry.name));
  let suffix = 2;
  while (taken.has(`${baseName} (${suffix})`)) suffix += 1;
  return `${baseName} (${suffix})`;
}

async function duplicateSelectedPreset() {
  const preset = selectedPreset.value;
  if (!preset || props.disabled || presetPending.value) return;
  // id 传空让 sidecar 重新生成（与新保存同一契约）；副本名查重递增保证唯一，
  // 分组沿用原预设。persistPreset 路径与成功文案不变。
  if (await persistPreset({ ...preset, id: "", name: uniqueDuplicateName(preset.name) })) emit("notify", t("search.presetSaved"));
}

// 预设删除行内两步确认（审计 J-5）：宿主 webview 可能拦截 window.confirm
// 原生确认框（同 clearHistory 既有顾虑，原实现与之自相矛盾）。首次点击进入
// 确认态（按钮文案切到既有 t("confirm")，title 展示带预设名的不可撤销提示），
// 3 秒无操作自动回落；确认态再次点击才执行删除。切换/取消选中预设即解除。
const presetRemoveArmed = ref(false);
let presetRemoveArmTimer = 0;

function disarmPresetRemove() {
  window.clearTimeout(presetRemoveArmTimer);
  presetRemoveArmTimer = 0;
  presetRemoveArmed.value = false;
}

function requestRemovePreset() {
  if (props.disabled || presetPending.value || !selectedPresetId.value) return;
  if (!presetRemoveArmed.value) {
    presetRemoveArmed.value = true;
    window.clearTimeout(presetRemoveArmTimer);
    presetRemoveArmTimer = window.setTimeout(disarmPresetRemove, 3000);
    return;
  }
  disarmPresetRemove();
  void removePreset();
}

async function removePreset() {
  if (props.disabled || presetPending.value || !selectedPresetId.value) return;
  const id = selectedPresetId.value;
  // 预设是持久化数据（UI 扫描 P2-21）：确认已由 requestRemovePreset 的
  // 两步交互完成，误删不可恢复。
  presetPending.value = true;
  try {
    await ldapApi.presetsRemove(id);
    presets.value = presets.value.filter((entry) => entry.id !== id);
    selectedPresetId.value = "";
    emit("notify", t("search.presetRemoved"));
  } catch (cause) {
    emit("error", cause instanceof Error ? cause.message : String(cause));
  } finally {
    presetPending.value = false;
  }
}

watch(selectedPresetId, () => disarmPresetRemove());
onBeforeUnmount(disarmPresetRemove);

// schema 属性下拉加载（现取模式）：getLdapConnectionId 是非响应式模块 getter，
// 不能固化为挂载时的一次性读取——挂载早于宿主上下文注入时读到空串
// （ensureLoaded 契约对空串直接跳过，无副作用但也无重试），且组件不随连接
// 切换重建（App 无 :key），切换后旧连接的属性列表会一直残留。与
// searchHistoryKey() 同一约定：调用时刻现取连接 id；失败静默（下拉仍有
// COMMON_ATTRIBUTES 兜底）。重试挂在 baseDn 变化上——App 每次连接同步都会
// 重置树根，与本组件 presets 的按连接重载信号一致；共享缓存（J-8）有 TTL
// 与 inFlight 去重，重复调用零成本。
function loadSchemaAttributes() {
  void ensureLoaded(getLdapConnectionId()).catch(() => undefined);
}

watch(
  () => props.baseDn,
  (next) => {
    draft.value.baseDn = next;
    void loadPresets();
    // 连接上下文（重）就绪：随 presets 一起按当前连接现取刷新属性下拉。
    loadSchemaAttributes();
  },
);

onMounted(() => {
  void loadPresets();
  // 挂载时现取初载；上下文未就绪时读空串静默跳过，随 baseDn 变化重试。
  loadSchemaAttributes();
});

const scopeOptions = computed(() => [
  { value: "base" as LdapScope, label: t("search.scopeBase") },
  { value: "one" as LdapScope, label: t("search.scopeOne") },
  { value: "sub" as LdapScope, label: t("search.scopeSub") },
]);

const derefOptions = computed(() => [
  { value: "never" as const, label: t("search.derefNever") },
  { value: "searching" as const, label: t("search.derefSearching") },
  { value: "finding" as const, label: t("search.derefFinding") },
  { value: "always" as const, label: t("search.derefAlways") },
]);

// RFC 2891 服务器端排序方向选项（升/降；属性名留空 = 不请求排序）。
const sortOrderOptions = computed(() => [
  { value: "asc" as const, label: t("search.sortAsc") },
  { value: "desc" as const, label: t("search.sortDesc") },
]);
</script>

<template>
  <form class="search-form" @submit.prevent="run">
    <div class="search-form-compact">
      <label class="field">
        <input
          v-model="draft.baseDn"
          type="text"
          class="mono"
          :class="{ 'base-dn-flash': baseDnHighlighted }"
          :title="baseDnHighlighted ? t('search.baseFollowed') : undefined"
          :aria-label="t('search.baseDn')"
          :disabled="disabled"
          spellcheck="false"
        />
      </label>
      <select v-model="draft.scope" class="compact-scope" :aria-label="t('search.scope')" :disabled="disabled">
        <option v-for="option in scopeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <input
        v-if="collapsed"
        :value="compactFilterValue"
        type="text"
        class="mono compact-filter"
        :placeholder="t('search.filterPlaceholder')"
        :aria-label="t('search.filter')"
        :aria-invalid="!builderMode && !sourceValid"
        :disabled="disabled"
        spellcheck="false"
        @input="onCompactFilterInput"
      />
      <span v-if="collapsed && compactFilterError" class="form-error" role="alert">{{ compactFilterError }}</span>
      <!-- 重置（快捷条）：条件改乱/清空后一键还原默认搜索（图标省空间，说明在 title）。 -->
      <button
        type="button"
        class="toolbar-button compact-reset"
        :disabled="disabled"
        :aria-label="t('search.reset')"
        :title="t('search.reset')"
        @click="resetSearch"
      >
        <RotateCcw aria-hidden="true" />
      </button>
      <!-- 历史入口（快捷条）：置于筛选条件切换与搜索之间左侧；切换与展开态同一个下拉状态。 -->
      <div ref="historyRootCompact" class="search-history">
        <button
          type="button"
          class="toolbar-button history-toggle"
          :disabled="disabled"
          :aria-expanded="historyOpen"
          :aria-label="t('search.historyTitle')"
          :title="t('search.historyTitle')"
          @click="toggleHistory"
        >
          <History aria-hidden="true" />{{ t("search.historyTitle") }}
        </button>
        <!-- 面板绝对定位于本按钮下方；两种形态共享状态/处理器，模板按锚点各写一份（不引入浮动层）。 -->
        <div v-if="historyOpen" class="history-panel">
          <div class="history-head">
            <span>{{ t("search.historyTitle") }}</span>
            <button
              type="button"
              class="history-clear"
              :disabled="!searchHistory.length"
              :aria-label="t('search.historyClear')"
              :title="t('search.historyClear')"
              @click.stop.prevent="clearHistory"
            >
              <Trash2 aria-hidden="true" />{{ t("search.historyClear") }}
            </button>
          </div>
          <p v-if="searchHistory.length === 0" class="history-empty">{{ t("search.historyEmpty") }}</p>
          <ul v-else class="history-list">
            <li v-for="(entry, index) in searchHistory" :key="`${entry.timestamp}-${index}`">
              <button type="button" class="history-item" :title="entry.filter" @click="applyHistory(entry)">
                <span class="history-index" aria-hidden="true">{{ index + 1 }}</span>
                <span class="history-content">
                  <span class="mono history-filter">{{ entry.filter }}</span>
                  <span class="history-meta">{{ entry.scope }} · {{ entry.baseDn || "—" }} · {{ entry.attributes || "—" }}</span>
                  <span class="history-time"><Clock3 aria-hidden="true" />{{ formatHistoryTime(entry.timestamp) }}</span>
                </span>
              </button>
            </li>
          </ul>
        </div>
      </div>
      <button type="button" class="toolbar-button compact-toggle" :aria-expanded="!collapsed" :aria-label="t('search.advanced')" :title="t(collapsed ? 'search.advancedExpand' : 'search.advancedCollapse')" @click="toggleCollapsed">
        <component :is="collapsed ? ChevronDown : ChevronUp" aria-hidden="true" />{{ t("search.advanced") }}
      </button>
      <button
        class="primary-button compact"
        type="submit"
        :disabled="disabled || running || !filterValid || !numericValid"
        :title="!numericValid ? t('search.invalidNumber') : !filterValid ? t('search.filterInvalid') : activeFilter() || t('search.filterAll')"
      >
        <Play aria-hidden="true" />{{ running ? t("search.running") : t("search.run") }}
      </button>
    </div>

    <div class="search-advanced" :class="{ 'is-collapsed': collapsed }" :aria-hidden="collapsed" :inert="collapsed || undefined">
      <div class="search-advanced-inner">
    <div class="command-import">
      <span class="command-import-label">{{ t("search.commandImport") }}</span>
      <input
        v-model="commandDraft"
        type="text"
        class="mono command-input"
        :placeholder="t('search.commandPlaceholder')"
        :aria-label="t('search.commandImport')"
        :disabled="disabled"
        spellcheck="false"
        @keydown.enter.prevent="applyCommand"
      />
      <button type="button" class="primary-button compact" :disabled="disabled || !commandDraft.trim()" @click="applyCommand">
        {{ t("search.commandApply") }}
      </button>
      <!-- Compatibility input for older automation clients; the visible path above is the single-line importer. -->
      <textarea
        v-model="commandDraft"
        class="legacy-command-textarea mono"
        rows="1"
        tabindex="-1"
        aria-hidden="true"
        :disabled="disabled"
      />
      <div class="command-actions command-actions-legacy">
        <button type="button" :disabled="disabled || !commandDraft.trim()" @click="applyCommand">{{ t("search.commandApply") }}</button>
      </div>
      <p v-if="commandError" class="form-error" role="alert">{{ commandError }}</p>
      <p v-for="warning in commandWarnings" :key="warning" class="command-warn">{{ warning }}</p>
      <p v-if="commandApplied" class="command-ok">{{ t("search.commandApplied") }}</p>
    </div>

        <div class="filter-block">
      <div class="filter-head">
        <span>{{ t("search.filter") }}</span>
        <!-- 模式切换留在高级区内部；历史入口固定在上方快捷条，避免切换时顶部布局跳动。 -->
        <span class="filter-head-tools">
          <span class="mode-switch">
            <button type="button" :class="{ 'is-active': builderMode }" :disabled="disabled" @click="builderMode || switchToBuilder()">
              {{ t("search.modeBuilder") }}
            </button>
            <button type="button" :class="{ 'is-active': !builderMode }" :disabled="disabled" @click="builderMode && switchToSource()">
              {{ t("search.modeSource") }}
            </button>
          </span>
          <!-- 重置（高级区）：还原整表默认（过滤器/Base/范围/数值框），与快捷条图标同一动作。 -->
          <button type="button" class="toolbar-button" :disabled="disabled" :title="t('search.reset')" @click="resetSearch">
            <RotateCcw aria-hidden="true" />{{ t("search.reset") }}
          </button>
        </span>
      </div>

      <div v-if="builderMode" class="filter-builder">
        <FilterGroup
          :group="builderRoot"
          :depth="0"
          :disabled="disabled"
          :list-id="ATTR_LIST_ID"
          :attribute-options="attributeOptions"
        />
        <p class="qb-preview mono" :title="t('search.filter')">{{ generatedFilter || "(objectClass=*)" }}</p>
      </div>
      <div v-else class="filter-source">
        <input
          v-model="sourceFilter"
          type="text"
          class="mono"
          :placeholder="t('search.filterPlaceholder')"
          :aria-label="t('search.filter')"
          :aria-invalid="!sourceValid"
          :aria-describedby="!sourceValid || sourceParseError ? filterErrorId : undefined"
          :disabled="disabled"
          spellcheck="false"
          @input="sourceParseError = false"
        />
        <span v-if="!sourceValid || sourceParseError" :id="filterErrorId" class="form-error" role="alert">{{ !sourceValid ? t("search.filterInvalid") : t("search.builderParseFailed") }}</span>
      </div>
      <p class="filter-hint">{{ t("search.filterEmptyHint") }}</p>
    </div>

    <div class="search-extra">
      <label class="field">
        <span>{{ t("search.attributes") }}</span>
        <input v-model="draft.attributes" type="text" :disabled="disabled" spellcheck="false" />
      </label>
      <label class="field" :title="t('search.numericHint')">
        <span>{{ t("search.sizeLimit") }}</span>
        <input v-model="draft.sizeLimit" type="text" inputmode="numeric" :disabled="disabled" class="numeric" :aria-invalid="sizeLimitInvalid" :aria-describedby="sizeLimitInvalid ? sizeLimitErrorId : undefined" />
        <span v-if="sizeLimitInvalid" :id="sizeLimitErrorId" class="form-error" role="alert">{{ t("search.invalidNumber") }}</span>
      </label>
      <label class="field" :title="t('search.numericHint')">
        <span>{{ t("search.pageSize") }}</span>
        <input v-model="draft.pageSize" type="text" inputmode="numeric" :disabled="disabled" class="numeric" :aria-invalid="pageSizeInvalid" :aria-describedby="pageSizeInvalid ? pageSizeErrorId : undefined" />
        <span v-if="pageSizeInvalid" :id="pageSizeErrorId" class="form-error" role="alert">{{ t("search.invalidNumber") }}</span>
      </label>
      <label class="field">
        <span>{{ t("search.typesOnly") }}</span>
        <select v-model="draft.typesOnly" :disabled="disabled">
          <option :value="false">{{ t("search.typesOnlyNo") }}</option>
          <option :value="true">{{ t("search.typesOnlyYes") }}</option>
        </select>
      </label>
      <label class="field">
        <span>{{ t("search.deref") }}</span>
        <select v-model="draft.derefAliases" :disabled="disabled">
          <option v-for="option in derefOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <!-- RFC 2891 服务器端排序：属性留空 = 不请求排序；紧凑条折叠形态下不展开显示。 -->
      <label class="field" :title="t('search.sortByHint')">
        <span>{{ t("search.sortBy") }}</span>
        <input v-model="draft.sortBy" type="text" :disabled="disabled" spellcheck="false" :placeholder="t('search.sortByHint')" />
      </label>
      <label class="field" :title="t('search.sortByHint')">
        <span>{{ t("search.sortOrder") }}</span>
        <select v-model="draft.sortOrder" :disabled="disabled">
          <option v-for="option in sortOrderOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
    </div>
    <div class="search-presets">
      <span class="muted">{{ t("search.presets") }}</span>
      <!-- F11：按 group 分组渲染（具名组在前，未分组垫底做小标题）。 -->
      <select v-model="selectedPresetId" :disabled="disabled || presetPending" @change="applyPreset">
        <option value="">{{ t("search.presetsEmpty") }}</option>
        <optgroup v-for="group in groupedPresets" :key="group.key || '__ungrouped__'" :label="group.label">
          <option v-for="preset in group.items" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
        </optgroup>
      </select>
      <input v-model="presetNameDraft" type="text" class="preset-input" :placeholder="t('search.presetName')" :disabled="disabled || presetPending" />
      <button type="button" class="toolbar-button" :disabled="disabled || presetPending || !presetNameDraft.trim() || !filterValid || !numericValid" :title="t('search.presetSave')" @click="savePreset">
        <Save aria-hidden="true" /><span>{{ t("search.presetSave") }}</span>
      </button>
      <!-- F11 每条目动作：重命名 / 创建副本 / 设置分组（需先选中一条预设）。
           三个原生按钮 Tab 可达，动作打开行内小输入框（Enter 提交 / Esc 取消）。 -->
      <button type="button" class="toolbar-button preset-rename" :disabled="disabled || presetPending || !selectedPresetId" :title="t('presetActions.rename')" :aria-label="t('presetActions.rename')" @click="openPresetEditor('rename')">
        <Pencil aria-hidden="true" />
      </button>
      <button type="button" class="toolbar-button preset-duplicate" :disabled="disabled || presetPending || !selectedPresetId" :title="t('presetActions.duplicate')" :aria-label="t('presetActions.duplicate')" @click="duplicateSelectedPreset">
        <Copy aria-hidden="true" />
      </button>
      <button type="button" class="toolbar-button preset-group" :disabled="disabled || presetPending || !selectedPresetId" :title="t('presetActions.group')" :aria-label="t('presetActions.group')" @click="openPresetEditor('group')">
        <FolderInput aria-hidden="true" />
      </button>
      <!-- 删除走行内两步确认：确认态文案用既有 confirm 键，title 展示带名的不可撤销提示。 -->
      <button
        type="button"
        class="toolbar-button preset-remove"
        :class="{ 'is-armed': presetRemoveArmed }"
        :disabled="disabled || presetPending || !selectedPresetId"
        :title="presetRemoveArmed && selectedPreset ? t('search.presetRemoveConfirm', { name: selectedPreset.name }) : t('search.presetRemove')"
        :aria-label="t('search.presetRemove')"
        @click="requestRemovePreset"
      >
        <Trash2 aria-hidden="true" /><span v-if="presetRemoveArmed">{{ t("confirm") }}</span>
      </button>
    </div>
    <!-- 行内编辑行（重命名/设置分组共用）：group 清空提交 = 回到未分组。 -->
    <div v-if="presetEditor" class="preset-editor">
      <input
        ref="presetEditorInput"
        v-model="presetEditorDraft"
        type="text"
        class="mono preset-input"
        :placeholder="presetEditor === 'group' ? t('presetActions.groupPlaceholder') : t('search.presetName')"
        :aria-label="presetEditor === 'rename' ? t('presetActions.rename') : t('presetActions.group')"
        :aria-invalid="presetEditorInvalid"
        :disabled="disabled || presetPending"
        spellcheck="false"
        @keydown.enter.prevent="commitPresetEditor"
        @keydown.esc.prevent="cancelPresetEditor"
      />
      <button type="button" class="toolbar-button" :disabled="disabled || presetPending || presetEditorInvalid" :title="presetEditor === 'rename' ? t('presetActions.rename') : t('presetActions.group')" @click="commitPresetEditor">
        <Save aria-hidden="true" /><span>{{ presetEditor === "rename" ? t("presetActions.rename") : t("presetActions.group") }}</span>
      </button>
      <button type="button" class="toolbar-button" :disabled="presetPending" :title="t('cancel')" @click="cancelPresetEditor">{{ t("cancel") }}</button>
    </div>
      </div>
    </div>
  </form>
</template>

<style scoped>
/* F11 预设动作的行内编辑行：占满高级区整行（父容器为 grid），
   输入框比预设名输入稍宽，便于编辑较长名称/分组名。 */
.preset-editor {
  display: flex;
  align-items: center;
  gap: 5px;
  grid-column: 1 / -1;
}
.preset-editor .preset-input {
  width: 220px !important;
  flex: 0 1 220px;
}
</style>
