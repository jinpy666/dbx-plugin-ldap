<script setup lang="ts">
// 条目编辑器：查看/编辑/新增三形态。
// 表单模式 = 属性行（属性名 + 多行值）；LDIF 模式 = RFC 2849 文本双向同步
// （serializeEntriesToLdif / parseLdif）；关联模式 = 只读关联视图
// （AssociationPanel，仅查看已有条目时开放，不触碰编辑状态）。新增走
// ldap/entry/add，修改走 ldap/entry/modify（按行 diff 生成 add/replace/delete
// changes）。
import { computed, nextTick, ref, useId, watch } from "vue";
import { Copy, Plus, Trash2, X } from "@lucide/vue";
import { ldapApi, type LdapEntry } from "../lib/api";
import { parseLdif, serializeEntriesToLdif } from "../lib/ldif";
import { attrRowsToAttributes, diffChanges, type AttrRowDraftSource, type LdapModifyChange } from "../lib/ldapDiff";
import { joinRdnAndParent, isLikelyDn, isLikelyRdn, splitFirstDnRdn } from "../lib/dn";
import { missingRequiredAttributes } from "../lib/entryValidation";
import type { LdapSchema } from "../lib/newEntryTemplates";
import { useModalA11y, decideBackdropClose } from "../lib/modal";
import { looksBinaryAttribute } from "../lib/binaryValue";
import { attributeValueKind, isBinaryKind } from "../lib/valueKinds";
import { builtinAttributeInfo, builtinAttributeNames } from "../lib/builtinSchema";
import { objectGuidDisplay, objectSidDisplay } from "../lib/adValues";
import { writeClipboardText } from "../lib/clipboard";
import { t } from "../lib/i18n";
import PasswordAttributeEditor from "./PasswordAttributeEditor.vue";
import BinaryValueEditor from "./BinaryValueEditor.vue";
import DatetimeValueEditor from "./DatetimeValueEditor.vue";
import DnValueEditor from "./DnValueEditor.vue";
import UacValueEditor from "./UacValueEditor.vue";
import AssociationPanel from "./AssociationPanel.vue";
import ObjectClassPickerDialog from "./ObjectClassPickerDialog.vue";

export interface AttrRowDraft extends AttrRowDraftSource {
  /** 源值自身含换行：编辑后按行重切分为多值（歧义提示用）。 */
  multiline?: boolean;
}

type EditorMode = "view" | "edit" | "add";
// 页签三态：form/ldif 双向同步沿用原 ldifMode 布尔语义；assoc 为只读关联视图。
type EditorTab = "form" | "ldif" | "assoc";

const props = defineProps<{
  canWrite: boolean;
  open: boolean;
  /** view/edit: an existing entry; add: the parent DN to create under. */
  entry?: LdapEntry;
  parentDn?: string;
  /** add 态的属性预填（复制条目）：entry 为空时生效，rows 由预填属性铺开。 */
  addPrefill?: { rdn?: string; attributes: Record<string, string[]> };
  /** 关联视图的搜索根（透传给 AssociationPanel）。 */
  baseDn?: string;
  /** 打开时的初始页签；仅 view 态的非 form 值生效，默认不影响既有调用方。 */
  initialTab?: EditorTab;
  /** 关联双栏会话中的嵌入展示；此时焦点管理由外层复合弹窗负责。 */
  presentation?: "modal" | "relation";
  /** schema 推导的 DN 值属性名（透传给 AssociationPanel；缺省/空时 panel 用内置兜底表）。 */
  dnAttributes?: string[];
  schema?: LdapSchema;
  loading?: boolean;
  /** Core fields are visible, but regular batches are still arriving. */
  loadingMore?: boolean;
  /** Association/binary fields are fetched only after the relevant tab opens. */
  loadingDeferred?: boolean;
  deferredAttributeCount?: number;
  loadError?: string;
  loadErrorDetail?: string;
  requestedDn?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "saved", dn: string, mode: "add" | "edit"): void;
  (e: "error", message: string): void;
  (e: "notify", message: string): void;
  (e: "openEntry", dn: string): void;
  (e: "openRelatedEntry", dn: string, attribute?: string): void;
  (e: "retry"): void;
  (e: "loadDeferred"): void;
}>();

const mode = ref<EditorMode>("view");
const dnDraft = ref("");
const rdnDraft = ref("");
const rows = ref<AttrRowDraft[]>([]);
const ldifText = ref("");
const editorTab = ref<EditorTab>("form");
const ldifError = ref("");
// LDIF 模式 DN 行锁定信号（UI 扫描 P2-13）：LDIF 里的 dn 与原条目不一致时提示。
const ldifDnChanged = ref(false);
const saving = ref(false);
// 变更预览（仅 edit 态）：save 先 diff 出 changes 并挂起，确认后才真正发
// modify；取消则只关预览层、编辑原样保留。
const changesOpen = ref(false);
const pendingChanges = ref<LdapModifyChange[]>([]);
// objectClass 选择器（chips 行「添加」）：记录目标行，选中类写回该行。
const ocPickerOpen = ref(false);
const activeOcRow = ref<AttrRowDraft | null>(null);
const attrEditor = ref<HTMLElement>();
const requiredErrorId = useId();
const rdnErrorId = useId();
const parentErrorId = useId();
let suppressLdifSync = false;
let initializedIdentity = "";

const isAdd = computed(() => mode.value === "add");
const isRelationPresentation = computed(() => props.presentation === "relation");
const editable = computed(() => props.canWrite && !saving.value && !props.loading && !props.loadingMore && !props.loadingDeferred && !props.loadError);
const ldifDraft = computed(() => {
  if (editorTab.value !== "ldif") return undefined;
  const parsed = parseLdif(ldifText.value);
  return parsed.errors.length === 0 ? parsed.entries[0] : undefined;
});
const activeDnParts = computed(() => editorTab.value === "ldif"
  ? splitFirstDnRdn(ldifDraft.value?.dn ?? "")
  : { rdn: rdnDraft.value, parentDn: dnDraft.value });
const rdnField = computed({ get: () => activeDnParts.value.rdn, set: (value: string) => { rdnDraft.value = value; } });
// 新增态 RDN 客户端预检（UI 扫描 P2-6）：逗号/空段/缺 `=` 提前拦截，
// 不等服务器报 invalid DN。空值仍走原有"DN 为空"保存守卫，不在此提示。
const rdnInvalid = computed(() => {
  if (!isAdd.value) return false;
  const rdn = activeDnParts.value.rdn;
  return rdn !== "" && !isLikelyRdn(rdn);
});
const parentInvalid = computed(() => {
  if (!isAdd.value) return false;
  const parent = activeDnParts.value.parentDn;
  return parent !== "" && !isLikelyDn(parent);
});
const missingRequired = computed(() => {
  if (!props.canWrite || props.loading || props.loadError) return [];
  const attributes = editorTab.value === "ldif" ? ldifDraft.value?.attributes : rowsToAttributes();
  return attributes ? missingRequiredAttributes(attributes, isAdd.value ? undefined : props.entry?.attributes, props.schema) : [];
});
const fieldMissing = (name: string) => missingRequired.value.some((attribute) => attribute.toLowerCase() === name.split(";")[0].trim().toLowerCase());
const dirty = computed(() => {
  if (mode.value === "add") return true;
  const source = props.entry;
  if (!source) return false;
  const current = rowsToAttributes();
  const originalKeys = Object.keys(source.attributes);
  const currentKeys = Object.keys(current);
  if (originalKeys.length !== currentKeys.length) return true;
  return currentKeys.some((key) => (current[key] ?? []).join("\n") !== (source.attributes[key] ?? []).join("\n"));
});

function entryToRows(entry: LdapEntry): AttrRowDraft[] {
  return Object.keys(entry.attributes)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const values = entry.attributes[name] ?? [];
      return {
        name,
        valuesText: values.join("\n"),
        sourceValues: values,
        // 值本身含换行时，编辑该行后的重切分歧义（round-3 保真只覆盖未编辑
        // 行）——标记出来提示用户：这一行编辑会按行拆分成多值。
        multiline: values.some((value) => value.includes("\n")),
      };
    });
}

function rowsToAttributes(): Record<string, string[]> {
  return attrRowsToAttributes(rows.value);
}

function syncLdifFromRows() {
  if (suppressLdifSync) return;
  const attributes = rowsToAttributes();
  if (isAdd.value) {
    const dn = joinRdnAndParent(rdnDraft.value, dnDraft.value);
    ldifText.value = serializeEntriesToLdif([{ dn, attributes }], { includeVersion: false });
  } else {
    ldifText.value = serializeEntriesToLdif([{ dn: dnDraft.value, attributes }], { includeVersion: false });
  }
}

function syncRowsFromLdif() {
  const result = parseLdif(ldifText.value);
  if (result.errors.length > 0) {
    ldifError.value = result.errors.map((error) => `L${error.line}: ${error.message}`).join("; ");
    return false;
  }
  ldifError.value = "";
  const entry = result.entries[0];
  if (!entry) {
    ldifError.value = "no entry";
    return false;
  }
  rows.value = entryToRows(entry);
  if (isAdd.value) {
    const { rdn, parentDn } = splitFirstDnRdn(entry.dn);
    rdnDraft.value = rdn;
    dnDraft.value = parentDn;
  } else {
    // 编辑态忽略 LDIF 中的 DN 变更（P2-13）：LDIF 的 dn 行不是改名入口
    // （改名走 Modify DN），照单全收会把 modify 发往不存在的 DN。
    ldifDnChanged.value = props.entry != null && entry.dn !== props.entry.dn;
    dnDraft.value = props.entry ? props.entry.dn : entry.dn;
  }
  return true;
}

// LDIF 模式内实时提示 dn 变更（UI 扫描 P2-23）：无需切回表单即可看到
// 「dn 行不能用于重命名」。编辑态仅在 ldif 页签下解析比对，add 态 dn 合法可编辑。
watch([ldifText, editorTab], ([text, tab]) => {
  if (tab !== "ldif" || isAdd.value) return;
  const result = parseLdif(text);
  const dn = result.entries[0]?.dn;
  ldifDnChanged.value = dn != null && props.entry != null && dn !== props.entry.dn;
});

function initFor(mode_: EditorMode, entry?: LdapEntry, parentDn?: string) {
  const nextIdentity = entry ? `entry:${entry.dn.toLowerCase()}` : `add:${parentDn ?? ""}`;
  const preserveTab = initializedIdentity === nextIdentity;
  initializedIdentity = nextIdentity;
  mode.value = mode_;
  // 页签初始态：view 态尊重 initialTab（树「查看成员」直开关联页），其余
  // （含 add）一律回落表单——默认值不影响既有调用方的打开行为。
  const requestedTab = props.initialTab;
  if (!preserveTab) {
    editorTab.value = mode_ === "view" && (requestedTab === "ldif" || requestedTab === "assoc") ? requestedTab : "form";
  }
  ldifError.value = "";
  ldifDnChanged.value = false;
  saving.value = false;
  // 重新打开时清掉上一轮的预览/选择器状态（否则层会残留到新条目会话）。
  changesOpen.value = false;
  pendingChanges.value = [];
  ocPickerOpen.value = false;
  activeOcRow.value = null;
  if (mode_ === "add") {
    dnDraft.value = parentDn || "";
    // 复制条目预填：RDN 属性名保留（值待填），属性行由预填铺开
    //（多值行天然支持，属性 datalist/MUST 标记照常生效）。
    rdnDraft.value = props.addPrefill?.rdn ?? "";
    rows.value = props.addPrefill
      ? entryToRows({ dn: "", attributes: props.addPrefill.attributes })
      : [{ name: "objectClass", valuesText: "top" }];
    ldifText.value = "";
    syncLdifFromRows();
    return;
  }
  if (!entry) return;
  dnDraft.value = entry.dn;
  rdnDraft.value = splitFirstDnRdn(entry.dn).rdn;
  rows.value = entryToRows(entry);
  ldifText.value = serializeEntriesToLdif([{ dn: entry.dn, attributes: entry.attributes }], { includeVersion: false });
  if (editorTab.value === "assoc") emit("loadDeferred");
}

watch(
  () => [props.open, props.entry, props.parentDn, props.loading, props.loadingMore, props.loadingDeferred, props.loadError] as const,
  ([open]) => {
    if (!open) {
      initializedIdentity = "";
      return;
    }
    if (props.loading || props.loadError) return;
    initFor(props.entry ? "view" : "add", props.entry, props.parentDn);
  },
  { immediate: true },
);

watch([rows, rdnDraft], () => {
  if (editorTab.value !== "form") return;
  syncLdifFromRows();
}, { deep: true });

function switchToLdif() {
  if (editorTab.value !== "ldif") syncLdifFromRows();
  editorTab.value = "ldif";
  // An LDIF is expected to represent the complete entry, including binary
  // values.  Request those fields only when the user explicitly enters it.
  emit("loadDeferred");
}

// 离开 LDIF 页签的共用守卫：先把 LDIF 文本解析回 rows，成功才允许切走。
// 切到关联页同样必须过这里——LDIF 里的编辑若不落回 rows，切回表单时会被
// rows→LDIF 重同步覆盖（用户编辑静默丢失）。
function leaveLdif(): boolean {
  if (editorTab.value !== "ldif") return true;
  suppressLdifSync = true;
  const ok = syncRowsFromLdif();
  suppressLdifSync = false;
  return ok;
}

function switchToForm() {
  if (!leaveLdif()) return;
  editorTab.value = "form";
}

function switchToAssoc() {
  // 关联本身是只读视图（不触碰 rows/LDIF 状态），但离开 LDIF 仍须先把文本
  // 解析回 rows；解析失败保持 LDIF 页签（与切表单同语义，错误提示在场）。
  if (!leaveLdif()) return;
  editorTab.value = "assoc";
  emit("loadDeferred");
}

function addRow() {
  rows.value.push({ name: "", valuesText: "" });
}

async function focusRequiredAttribute(name: string) {
  if (!leaveLdif()) return;
  editorTab.value = "form";
  let index = rows.value.findIndex((row) => row.name.split(";")[0].trim().toLowerCase() === name.toLowerCase());
  if (index < 0) {
    index = rows.value.length;
    rows.value.push({ name, valuesText: "" });
  }
  await nextTick();
  attrEditor.value?.querySelectorAll(".attr-row")[index]?.querySelector<HTMLElement>("textarea, .attr-value-cell input, .attr-value-cell select")?.focus();
}

// M6 N2/N3 + 阶段2（值编辑器注册表）：按属性名/语法分流值编辑器。
// 分流数据源 = valueKinds 注册表（对齐 Apache Directory Studio valueeditors
// plugin.xml 的「属性名 + 语法 OID」双绑定）：schema 的 attributeInfo 优先，
// 内置表（builtinSchema）兜底。LDIF 模式始终是纯文本，不走分流。
type RowEditorKind = "password" | "binary" | "datetime" | "filetime" | "dn" | "boolean" | "integer" | "uac" | "oid" | "text";

function editorKind(name: string): RowEditorKind {
  const key = name.trim().toLowerCase();
  if (!key) return "text";
  if (key === "userpassword" || key === "unicodepwd" || key.endsWith("password")) return "password";
  if (looksBinaryAttribute(key)) return "binary";
  const info = schemaAttributeInfo(key);
  const kind = attributeValueKind(key, info, props.schema?.serverInfo?.dialect);
  if (isBinaryKind(kind)) return "binary";
  // oid（supportedControl 等 OID 语法）此前未映射、落回 text：这里接上，
  // 表单页签给出带格式的单行输入与行内校验。
  if (kind === "datetime" || kind === "filetime" || kind === "dn" || kind === "boolean" || kind === "integer" || kind === "uac" || kind === "oid") return kind;
  return "text";
}

// 属性语法信息：schema attributeInfo（后端为小写键）→ 大小写不敏感扫描 →
// 内置兜底表（builtinSchema）。
function schemaAttributeInfo(key: string) {
  const info = props.schema?.attributeInfo;
  if (info) {
    const direct = info[key];
    if (direct) return direct;
    const matched = Object.keys(info).find((name) => name.toLowerCase() === key);
    if (matched) return info[matched];
  }
  return builtinAttributeInfo(key);
}

// 单值编辑器（时间/布尔/整数/DN 选择/UAC/OID）只在行确实是单值时生效；多值行
// （member 可达数百值）降级回 textarea，避免选择器覆盖丢数据。布尔再约束
// 当前值为 TRUE/FALSE/空，非常规值保持文本以防意外改写。oid 虽无专用"选择器"，
// 但单行 input 会吞掉换行分隔的多值（supportedControl 等常多值），同样降级。
const SINGLE_VALUE_KINDS: ReadonlyArray<RowEditorKind> = ["datetime", "filetime", "boolean", "integer", "dn", "uac", "oid"];

function rowEditorKind(row: AttrRowDraft): RowEditorKind {
  const kind = editorKind(row.name);
  if (SINGLE_VALUE_KINDS.includes(kind) && rowValues(row).length > 1) return "text";
  if (kind === "boolean" && row.valuesText.trim() !== "" && !/^(true|false)$/iu.test(row.valuesText.trim())) return "text";
  return kind;
}

// AD objectGUID / objectSid：BinaryValueEditor 之外的一行人类可读预览
//（ADS 行为：仅显示解码，编辑仍走原始 base64/hex）。
function decodedIdentifier(row: AttrRowDraft): string {
  if (editorKind(row.name) !== "binary") return "";
  const key = row.name.trim().toLowerCase();
  const value = rowValues(row)[0] ?? "";
  if (key === "objectguid") return objectGuidDisplay(value);
  if (key === "objectsid") return objectSidDisplay(value);
  return "";
}

const attributeListId = useId();

// 当前条目生效的 objectClass（view/edit 来自条目属性；add 来自草稿行），
// 小写比较；供 MUST 标记与属性补全排序。
const entryObjectClasses = computed<string[]>(() => {
  const source = isAdd.value
    ? rows.value.filter((row) => row.name.trim().toLowerCase() === "objectclass").flatMap((row) => rowValues(row))
    : props.entry?.attributes["objectClass"] ?? [];
  return source.map((value) => value.trim().toLowerCase()).filter(Boolean);
});

function objectClassDef(name: string) {
  const classes = props.schema?.objectClassAttributes ?? {};
  return classes[name] ?? classes[Object.keys(classes).find((key) => key.toLowerCase() === name) ?? ""];
}

// 条目 objectClass 的 MUST 属性（小写集合），属性行旁打 ★ 提示。
const mustAttributes = computed<Set<string>>(() => {
  const set = new Set<string>();
  for (const objectClass of entryObjectClasses.value) {
    for (const attribute of objectClassDef(objectClass)?.must ?? []) set.add(attribute.trim().toLowerCase());
  }
  return set;
});

// 属性名补全（datalist）：MUST 优先 → MAY → schema 全量 → 内置常用表兜底。
const attributeOptions = computed<string[]>(() => {
  const seen = new Set<string>();
  const options: string[] = [];
  const push = (name: string) => {
    const key = String(name ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    options.push(String(name));
  };
  for (const objectClass of entryObjectClasses.value) {
    const def = objectClassDef(objectClass);
    for (const attribute of def?.must ?? []) push(attribute);
  }
  for (const objectClass of entryObjectClasses.value) {
    const def = objectClassDef(objectClass);
    for (const attribute of def?.may ?? []) push(attribute);
  }
  for (const name of props.schema?.attributeNames ?? []) push(name);
  for (const name of builtinAttributeNames()) push(name);
  return options;
});

const isIntegerShape = (value: string) => /^[+-]?\d+$/.test(value.trim());
// OID 形状（RFC 4512 dottedDecimal）：空值合法（留白等价删除），非空必须
// 至少一段数字、多段点分，如 2.16.840.1.113730.3.4.2。
const isOidShape = (value: string) => /^\d+(\.\d+)+$/.test(value.trim());

// DatetimeValueEditor 的 kind 收窄（模板 v-else-if 无法让 TS 收窄联合类型）。
function datetimeKind(row: AttrRowDraft): "datetime" | "filetime" {
  return rowEditorKind(row) === "filetime" ? "filetime" : "datetime";
}

function valueFormatLabel(row: AttrRowDraft): string {
  if (isObjectClassRow(row)) return t("ldap.valueEditors.formatObjectClass");
  switch (editorKind(row.name)) {
    case "password": return t("ldap.valueEditors.formatPassword");
    case "binary": return t("ldap.valueEditors.formatBinary");
    case "datetime": return t("ldap.valueEditors.formatGeneralizedTime");
    case "filetime": return t("ldap.valueEditors.formatFiletime");
    case "dn": return t("ldap.valueEditors.formatDn");
    case "boolean": return t("ldap.valueEditors.formatBoolean");
    case "integer": return t("ldap.valueEditors.formatInteger");
    case "uac": return t("ldap.valueEditors.formatUac");
    case "oid": return t("ldap.valueEditors.formatOid");
    default: return t("ldap.valueEditors.formatText");
  }
}

function rowValues(row: AttrRowDraft): string[] {
  return row.valuesText === "" ? [] : row.valuesText.split("\n");
}

// -- objectClass 专用 chips 行（对标 ADS ObjectClass Editor）------------------
// objectClass 是结构多值属性：textarea 的"一行一值"对类名不直观也不防错，
// 改为 chip 展示 + 选择器补加；值仍落回 valuesText（\n 连接），与 LDIF 双向
// 同步、diff 保存路径完全不变。该行天然多值，不受单值降级影响。

function isObjectClassRow(row: AttrRowDraft): boolean {
  return row.name.trim().toLowerCase() === "objectclass";
}

// chips 展示/写回统一走这里：滤掉空段（LDIF 往返不产生，防御性），保持原序。
function objectClassValues(row: AttrRowDraft): string[] {
  return rowValues(row).map((value) => value.trim()).filter(Boolean);
}

function removeObjectClass(row: AttrRowDraft, value: string) {
  const values = objectClassValues(row);
  const index = values.indexOf(value);
  if (index < 0) return;
  values.splice(index, 1);
  // 仅剩最后一个类时按钮已 disabled，这里是双保险；写回 valuesText 后既有
  // rows→LDIF watch 自动同步，保存仍走 diffChanges 的 replace 路径。
  row.valuesText = values.join("\n");
}

function openObjectClassPicker(row: AttrRowDraft) {
  activeOcRow.value = row;
  ocPickerOpen.value = true;
}

// picker 选中一个类：写回目标行 valuesText（\n 连接），可连续添加。
function onPickerAdd(className: string) {
  const row = activeOcRow.value;
  const name = className.trim();
  if (!row || !name) return;
  const values = objectClassValues(row);
  if (values.some((value) => value.toLowerCase() === name.toLowerCase())) return;
  values.push(name);
  row.valuesText = values.join("\n");
}

// 已用类（小写）传给 picker 做「已选禁点」。
const pickerUsedClasses = computed<string[]>(() =>
  activeOcRow.value ? objectClassValues(activeOcRow.value).map((value) => value.toLowerCase()) : [],
);

// 随机生成的明文只在通知里出现一次（不进 rows、不进 LDIF、不落盘）。
function onPlainGenerated(plain: string) {
  emit("notify", t("ldap.passwordEditor.plainNotice", { plain }));
}

// 复制入口（DN / 属性值 / LDIF 文本共用）：宿主桥缺失或写入失败时如实通知，
// 不假装"已复制"。复制是只读动作，不受 editable 门禁限制。
async function copyText(text: string) {
  emit("notify", (await writeClipboardText(text)) ? t("copied") : t("copyFailed"));
}

function removeRow(index: number) {
  rows.value.splice(index, 1);
}

async function save() {
  if (!editable.value) return;
  if (editorTab.value === "ldif" && !syncRowsFromLdif()) return;
  // Validate the parsed draft too; a valid form RDN cannot authorize a new LDIF DN.
  if (rdnInvalid.value || parentInvalid.value || missingRequired.value.length > 0) return;
  if (isAdd.value) {
    // add 态不做预览（新条目没有"原值"可比，提交即创建），保持直接保存。
    saving.value = true;
    try {
      const dn = joinRdnAndParent(rdnDraft.value, dnDraft.value);
      if (!dn) {
        emit("error", t("editor.rdn"));
        return;
      }
      if (!isLikelyDn(dn)) {
        emit("error", t("editor.dnInvalid"));
        return;
      }
      await ldapApi.entryAdd(dn, rowsToAttributes());
      emit("saved", dn, "add");
    } catch (cause) {
      emit("error", cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.value = false;
    }
    return;
  }
  // edit 态：先 diff 并挂起变更（对标 ADS 保存前确认的习惯）——确认前不发
  // modify、不置 saving，用户可取消回编辑；无差异分支保持原语义。
  const source = props.entry!;
  const changes = diffChanges(source.attributes, rowsToAttributes());
  if (changes.length === 0) {
    // 无差异不再静默关闭（P2-13）：区分"没有修改"与"修改被丢弃"。
    emit("notify", t("editor.noChanges"));
    emit("close");
    return;
  }
  pendingChanges.value = changes;
  changesOpen.value = true;
}

// 预览层按 op（add/replace/delete）分组渲染，组内保持 diffChanges 顺序。
const CHANGE_OP_ORDER = ["add", "replace", "delete"] as const;
const groupedChanges = computed<{ op: (typeof CHANGE_OP_ORDER)[number]; changes: LdapModifyChange[] }[]>(() =>
  CHANGE_OP_ORDER
    .map((op) => ({ op, changes: pendingChanges.value.filter((change) => change.operation === op) }))
    .filter((group) => group.changes.length > 0),
);

// 值预览：多值截断为前 3 个 + "…"；delete 的 values 恒为空，调用方隐藏。
function changeValuesPreview(change: LdapModifyChange): string {
  if (change.values.length === 0) return "";
  const head = change.values.slice(0, 3).join(", ");
  return change.values.length > 3 ? `${head}, …` : head;
}

// 预览「确认保存」：真正执行 modify。saving/in-flight/错误处理与原 save 的
// edit 分支一致；关闭预览后再进入 saving，footer 保存按钮照常显示 "…"。
async function confirmChanges() {
  if (saving.value || pendingChanges.value.length === 0) return;
  const changes = pendingChanges.value;
  changesOpen.value = false;
  saving.value = true;
  try {
    await ldapApi.entryModify(dnDraft.value, changes);
    emit("saved", dnDraft.value, "edit");
  } catch (cause) {
    emit("error", cause instanceof Error ? cause.message : String(cause));
  } finally {
    saving.value = false;
    pendingChanges.value = [];
  }
}

// 预览「取消」：只关预览层，rows/草稿原样保留（不丢编辑），可继续改再存。
function cancelChanges() {
  changesOpen.value = false;
  pendingChanges.value = [];
}

const title = computed(() => (props.loading || props.loadError
  ? `${t("editor.viewTitle")} · ${props.requestedDn || ""}`
  : isAdd.value ? t("editor.addTitle") : `${t("editor.viewTitle")} · ${rdnDraft.value || dnDraft.value}`));

// 关闭守卫：提交在途 / 可写且有未保存修改时否决。Esc 与遮罩点击共用同一条
// 判定（UI 扫描 P1-1：此前遮罩 @click.self 直接 close 绕过保护丢改动）；
// ✕/取消仍为显式放弃入口。只读态无改动可做，始终放行。
function canRequestClose(): boolean {
  if (props.loading || props.loadError) return true;
  // 二层 UI 在场时先明确处置（确认/取消、加类完成），Esc/遮罩不动编辑器。
  if (changesOpen.value || ocPickerOpen.value) return false;
  return !saving.value && !(props.canWrite && dirty.value);
}

useModalA11y(
  () => props.open && !isRelationPresentation.value,
  { close: () => emit("close"), allowClose: canRequestClose },
);

// 遮罩点击走与 Esc 相同的守卫：dirty 时静默否决（footer 已有"有未保存的
// 修改"提示），弹窗保持打开、输入不丢。
function onBackdropClick() {
  if (decideBackdropClose(canRequestClose()).kind !== "close") return;
  emit("close");
}

function onAssociationOpen(dn: string) {
  emit("openEntry", dn);
}

function onAssociationRelation(dn: string, attribute?: string) {
  emit("openRelatedEntry", dn, attribute);
}
</script>

<template>
  <div v-if="open" :class="isRelationPresentation ? 'entry-editor-relation-host' : 'modal-backdrop'" @click.self="onBackdropClick">
    <div class="modal editor-modal" :class="{ 'editor-modal--relation': isRelationPresentation }" role="dialog" :aria-modal="isRelationPresentation ? undefined : 'true'" :aria-label="title" :aria-busy="loading || loadingMore || loadingDeferred || undefined">
      <header>
        <h2>{{ title }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <div v-if="loading" class="empty" role="status">{{ t("editor.loading") }}</div>
      <div v-else-if="loadError" class="empty request-error" role="alert">
        <p :title="loadErrorDetail || loadError">{{ loadError }}</p>
        <button type="button" @click="emit('retry')">{{ t("retry") }}</button>
      </div>
      <template v-else>
      <p v-if="loadingMore || loadingDeferred" class="hint" role="status">{{ t("editor.loading") }}</p>
      <div v-if="isAdd" class="attr-row">
        <label class="field">
          <span class="muted">{{ t("editor.rdn") }}</span>
          <input v-model="rdnField" type="text" name="attr-name" class="mono" :disabled="!editable || editorTab === 'ldif'" :aria-invalid="rdnInvalid" :aria-describedby="rdnInvalid ? rdnErrorId : undefined" spellcheck="false" />
          <span v-if="rdnInvalid" :id="rdnErrorId" class="form-error" role="alert">{{ t("editor.rdnInvalid") }}</span>
        </label>
        <label class="field">
          <span class="muted">{{ t("editor.parentDn") }}</span>
          <input :value="activeDnParts.parentDn" type="text" class="mono" :disabled="true" :aria-invalid="parentInvalid" :aria-describedby="parentInvalid ? parentErrorId : undefined" spellcheck="false" />
          <span v-if="parentInvalid" :id="parentErrorId" class="form-error" role="alert">{{ t("editor.dnInvalid") }}</span>
        </label>
      </div>
      <div v-else class="entry-dn-row">
        <p class="entry-dn" :title="dnDraft">{{ dnDraft }}</p>
        <button class="icon-button" :title="t('copyDn')" :aria-label="t('copyDn')" @click="copyText(dnDraft)"><Copy aria-hidden="true" /></button>
      </div>
      <div class="mode-switch-row">
        <div class="mode-switch">
          <button :class="{ 'is-active': editorTab === 'form' }" @click="switchToForm">{{ t("editor.formMode") }}</button>
          <button :class="{ 'is-active': editorTab === 'ldif' }" @click="switchToLdif">{{ t("editor.ldifMode") }}</button>
          <!-- 关联是只读视图，仅查看已有条目（view 态）时可用；新增态没有属性上下文。 -->
          <button v-if="!isAdd && entry" :class="{ 'is-active': editorTab === 'assoc' }" @click="switchToAssoc">{{ t("editor.assocMode") }}</button>
        </div>
        <button v-if="editorTab === 'ldif'" class="icon-button" :title="t('editor.copyLdif')" :aria-label="t('editor.copyLdif')" :disabled="ldifText === ''" @click="copyText(ldifText)"><Copy aria-hidden="true" /></button>
      </div>
      <p v-if="!canWrite" class="hint">{{ t("editor.readonlyHint") }}</p>
      <p v-if="ldifError" class="form-error">{{ t("editor.ldifParseError", { error: ldifError }) }}</p>
      <p v-if="ldifDnChanged" class="hint">{{ t("editor.ldifDnLocked") }}</p>
      <div v-if="missingRequired.length > 0 && editorTab !== 'assoc'" :id="requiredErrorId" class="form-error required-attributes" role="alert">
        <span>{{ t("editor.requiredAttributes") }}</span>
        <button v-for="attribute in missingRequired" :key="attribute" type="button" :aria-label="t('editor.locateAttribute', { attribute })" :disabled="!editable" @click="focusRequiredAttribute(attribute)">{{ attribute }}</button>
      </div>
      <template v-if="editorTab === 'form'">
        <div ref="attrEditor" class="attr-editor">
          <div class="attr-column-labels" aria-hidden="true">
            <span>{{ t("editor.attribute") }}</span>
            <span>{{ t("editor.values") }}</span>
            <span></span>
          </div>
          <p v-if="rows.length === 0" class="empty" role="status">{{ t("editor.noAttributes") }}</p>
          <datalist :id="attributeListId">
            <option v-for="option in attributeOptions" :key="option" :value="option" />
          </datalist>
          <div v-for="(row, index) in rows" :key="index" class="attr-row">
            <div class="attr-name-field">
              <input v-model="row.name" type="text" name="attr-name" :list="attributeListId" :placeholder="t('editor.attribute')" :aria-label="t('editor.attribute')" :disabled="!editable" spellcheck="false" />
              <div class="attr-meta">
                <span class="attr-format-label">{{ valueFormatLabel(row) }}</span>
                <span v-if="rowValues(row).length > 1" class="attr-count-label">{{ t("editor.valueCount", { count: rowValues(row).length }) }}</span>
                <span v-if="mustAttributes.has(row.name.split(';')[0].trim().toLowerCase())" class="must-label must-mark" :title="t('editor.requiredAttributes')">★ MUST</span>
              </div>
            </div>
            <div class="attr-value-field">
              <span class="attr-value-cell" role="group" :aria-label="row.name || t('editor.values')" :aria-describedby="fieldMissing(row.name) ? requiredErrorId : undefined">
              <!-- objectClass 专用 chips 行：每 chip 一个类值，天然多值，
                   不走 textarea / 单值降级；值仍落回 valuesText 保持同步语义。 -->
              <template v-if="isObjectClassRow(row)">
                <div class="oc-chips">
                  <span v-for="(value, valueIndex) in objectClassValues(row)" :key="`${valueIndex}:${value}`" class="oc-chip">
                    <span class="mono">{{ value }}</span>
                    <button
                      type="button"
                      class="icon-button oc-chip-remove"
                      :title="t('editor.objectClassRemove', { name: value })"
                      :aria-label="t('editor.objectClassRemove', { name: value })"
                      :disabled="!editable || objectClassValues(row).length <= 1"
                      @click="removeObjectClass(row, value)"
                    >
                      <X aria-hidden="true" />
                    </button>
                  </span>
                  <button
                    type="button"
                    class="oc-chip-add"
                    :title="t('editor.objectClassAdd')"
                    :aria-label="t('editor.objectClassAdd')"
                    :disabled="!editable"
                    @click="openObjectClassPicker(row)"
                  >
                    <Plus aria-hidden="true" />{{ t("editor.objectClassAdd") }}
                  </button>
                </div>
              </template>
              <PasswordAttributeEditor
                v-else-if="rowEditorKind(row) === 'password'"
                :model-value="row.valuesText"
                :disabled="!editable"
                @update:model-value="row.valuesText = $event"
                @plain-generated="onPlainGenerated"
              />
              <template v-else-if="rowEditorKind(row) === 'binary'">
                <BinaryValueEditor
                  :attribute-name="row.name"
                  :model-value="rowValues(row)"
                  :disabled="!editable"
                  @update:model-value="row.valuesText = $event.join('\n')"
                />
                <p v-if="decodedIdentifier(row)" class="binary-decoded mono">{{ decodedIdentifier(row) }}</p>
              </template>
              <DatetimeValueEditor
                v-else-if="rowEditorKind(row) === 'datetime' || rowEditorKind(row) === 'filetime'"
                :kind="datetimeKind(row)"
                :model-value="row.valuesText"
                :disabled="!editable"
                @update:model-value="row.valuesText = $event"
              />
              <DnValueEditor
                v-else-if="rowEditorKind(row) === 'dn'"
                :model-value="row.valuesText"
                :disabled="!editable"
                :base-dn="baseDn"
                @update:model-value="row.valuesText = $event"
                @open-reference="emit('openRelatedEntry', $event, row.name)"
              />
              <select
                v-else-if="rowEditorKind(row) === 'boolean'"
                class="boolean-select"
                :value="row.valuesText.trim().toUpperCase()"
                :disabled="!editable"
                :aria-label="row.name || t('editor.values')"
                @change="row.valuesText = ($event.target as HTMLSelectElement).value"
              >
                <option value="TRUE">TRUE</option>
                <option value="FALSE">FALSE</option>
              </select>
              <UacValueEditor
                v-else-if="rowEditorKind(row) === 'uac'"
                :model-value="row.valuesText"
                :disabled="!editable"
                @update:model-value="row.valuesText = $event"
              />
              <template v-else-if="rowEditorKind(row) === 'integer'">
                <input
                  class="mono integer-input"
                  type="text"
                  inputmode="numeric"
                  :value="row.valuesText"
                  :disabled="!editable"
                  :aria-label="row.name || t('editor.values')"
                  :aria-invalid="row.valuesText.trim() !== '' && !isIntegerShape(row.valuesText)"
                  spellcheck="false"
                  @input="row.valuesText = ($event.target as HTMLInputElement).value"
                />
                <small v-if="row.valuesText.trim() !== '' && !isIntegerShape(row.valuesText)" class="form-error">{{ t("ldap.valueEditors.integerInvalid") }}</small>
              </template>
              <!-- OID 单行输入：写法参照 integer 分支；点分数字格式行内校验。 -->
              <template v-else-if="rowEditorKind(row) === 'oid'">
                <input
                  class="mono oid-input"
                  type="text"
                  :value="row.valuesText"
                  :disabled="!editable"
                  :aria-label="row.name || t('editor.values')"
                  :aria-invalid="row.valuesText.trim() !== '' && !isOidShape(row.valuesText)"
                  spellcheck="false"
                  @input="row.valuesText = ($event.target as HTMLInputElement).value"
                />
                <small v-if="row.valuesText.trim() !== '' && !isOidShape(row.valuesText)" class="form-error">{{ t("ldap.valueEditors.oidInvalid") }}</small>
              </template>
              <template v-else>
                <textarea v-model="row.valuesText" rows="2" :placeholder="t('editor.values')" :aria-label="row.name || t('editor.values')" :aria-invalid="fieldMissing(row.name)" :aria-describedby="fieldMissing(row.name) ? requiredErrorId : undefined" :disabled="!editable" spellcheck="false" />
                <small v-if="row.multiline" class="multiline-hint">{{ t("editor.multilineHint") }}</small>
              </template>
              </span>
            </div>
            <span class="attr-actions">
              <button :title="t('editor.copyValue')" :aria-label="t('editor.copyValue')" :disabled="row.valuesText === ''" @click="copyText(row.valuesText)"><Copy aria-hidden="true" /></button>
              <button :title="t('editor.removeAttribute')" :disabled="!editable" @click="removeRow(index)"><Trash2 /></button>
            </span>
          </div>
        </div>
      </template>
      <AssociationPanel
        v-else-if="editorTab === 'assoc'"
        :dn="dnDraft"
        :attributes="entry?.attributes ?? {}"
        :base-dn="baseDn ?? ''"
        :dn-attributes="dnAttributes"
        :active="open && editorTab === 'assoc'"
        @open-entry="onAssociationOpen"
        @open-relation="onAssociationRelation"
        @error="(m: string) => emit('error', m)"
        @notify="(m: string) => emit('notify', m)"
      />
      <textarea v-else v-model="ldifText" class="ldif-editor" :aria-label="t('editor.ldifMode')" :aria-invalid="rdnInvalid || parentInvalid || missingRequired.length > 0 || !!ldifError" :aria-describedby="missingRequired.length > 0 ? requiredErrorId : rdnInvalid ? rdnErrorId : parentInvalid ? parentErrorId : undefined" spellcheck="false" :disabled="!editable" />
      </template>
      <footer>
        <span v-if="dirty && canWrite && !loading && !loadError" class="muted" style="margin-right: auto">{{ t("editor.changed") }}</span>
        <button v-if="editorTab === 'form' && !loading && !loadError" class="toolbar-button" style="margin-right: auto" :disabled="!editable" @click="addRow">
          <Plus aria-hidden="true" />{{ t("editor.addAttribute") }}
        </button>
        <button type="button" @click="emit('close')">{{ isRelationPresentation ? t("close") : t("cancel") }}</button>
        <!-- 关联页签是只读视图：保存等编辑动作一并隐藏，仅保留取消（关闭）。 -->
        <button v-if="canWrite && editorTab !== 'assoc' && !loading && !loadError" type="button" class="primary-button" :disabled="!editable || rdnInvalid || parentInvalid || missingRequired.length > 0" @click="save">
          {{ saving ? "…" : t("save") }}
        </button>
      </footer>
      <!-- 变更预览（仅 edit 态）：内嵌二层面板盖住编辑器本体。不用第二层
           useModalA11y 弹窗，原因：modal.ts 以"当前文档唯一弹窗"为前提做全局
           容器查询，双弹窗会让焦点陷阱错位；内嵌层取消即回到编辑器，天然
           满足"取消不丢编辑"，Esc 由 canRequestClose 的预览否决兜底。 -->
      <div v-if="changesOpen" class="changes-layer" role="dialog" aria-modal="true" :aria-label="t('editor.changesTitle')">
        <h3>{{ t("editor.changesTitle") }}</h3>
        <p class="hint">{{ t("editor.changesHint") }}</p>
        <div class="changes-list">
          <section v-for="group in groupedChanges" :key="group.op" class="changes-group">
            <p class="changes-group-title">
              <span class="change-badge" :class="`change-badge--${group.op}`">{{ group.op }}</span>
            </p>
            <ul>
              <li v-for="change in group.changes" :key="`${group.op}:${change.attribute}`" class="change-item">
                <span class="mono change-attr">{{ change.attribute }}</span>
                <span v-if="changeValuesPreview(change)" class="mono change-values">{{ changeValuesPreview(change) }}</span>
              </li>
            </ul>
          </section>
        </div>
        <footer>
          <button type="button" class="changes-cancel" :disabled="saving" @click="cancelChanges">{{ t("cancel") }}</button>
          <button type="button" class="primary-button changes-confirm" :disabled="saving" @click="confirmChanges">{{ t("editor.confirmChanges") }}</button>
        </footer>
      </div>
    </div>
  </div>
  <!-- objectClass 选择器：自带遮罩的第二层模态，仅由 chips 行「添加」唤起。 -->
  <ObjectClassPickerDialog
    :open="ocPickerOpen"
    :schema="schema"
    :used-classes="pickerUsedClasses"
    @close="ocPickerOpen = false"
    @add="onPickerAdd"
  />
</template>

<style scoped>
/* objectClass chips 行 */
.oc-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.oc-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 4px 2px 10px;
  background: var(--background);
  font-size: 12px;
}
.oc-chip-remove {
  width: 18px;
  height: 18px;
  border-radius: 999px;
}
.oc-chip-remove svg {
  width: 12px;
  height: 12px;
}
/* 刻意不复用 .toolbar-button 类：footer 的"添加属性"是同名选择器约定,
   chips 添加按钮独立成类避免测试/样式互相串扰 */
.oc-chip-add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 11px;
  background: var(--background);
  color: var(--foreground);
  cursor: pointer;
}
.oc-chip-add:hover:not(:disabled) {
  background: var(--accent);
}
.oc-chip-add svg {
  width: 14px;
  height: 14px;
}
/* OID 单行输入（与 textarea 同高基准，mono 由全局类提供） */
.oid-input {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  background: var(--background);
  color: var(--foreground);
}
.oid-input:disabled {
  opacity: 0.6;
}
/* 变更预览二层面板：盖住编辑器模态本体（.modal 已 position:relative） */
.changes-layer {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
  border-radius: 8px;
  padding: 16px;
  background: var(--popover);
}
.changes-layer h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.changes-list {
  min-height: 0;
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.changes-group-title {
  margin: 0;
}
.changes-group ul {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.change-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.change-attr {
  flex: none;
  font-weight: 600;
}
.change-values {
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
.change-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 8px;
  background: var(--muted);
  font-size: 11px;
  font-family: var(--mono-font-family);
  text-transform: uppercase;
}
/* delete 徽章用 destructive 色：删除不可由服务器端确认，视觉上加重 */
.change-badge--delete {
  color: var(--destructive);
  border-color: color-mix(in srgb, var(--destructive) 45%, var(--border));
  background: color-mix(in srgb, var(--destructive) 10%, transparent);
}
</style>
