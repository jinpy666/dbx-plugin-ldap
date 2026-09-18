<script setup lang="ts">
// 条目编辑器：查看/编辑/新增三形态。
// 表单模式 = 属性行（属性名 + 多行值）；LDIF 模式 = RFC 2849 文本双向同步
// （serializeEntriesToLdif / parseLdif）；关联模式 = 只读关联视图
// （AssociationPanel，仅查看已有条目时开放，不触碰编辑状态）。新增走
// ldap/entry/add，修改走 ldap/entry/modify（按行 diff 生成 add/replace/delete
// changes）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { Copy, Pencil, Plus, Trash2, X } from "@lucide/vue";
import DnPickerDialog from "./DnPickerDialog.vue";
import { ldapApi, type LdapEntry } from "../lib/api";
import { parseLdif, serializeEntriesToLdif } from "../lib/ldif";
import { attrRowsToAttributes, diffChanges, type AttrRowDraftSource, type LdapModifyChange } from "../lib/ldapDiff";
import { joinRdnAndParent, isLikelyDn, isLikelyRdn, parseRdnAttributes, splitFirstDnRdn } from "../lib/dn";
import { missingRequiredAttributes, validateValueKind } from "../lib/entryValidation";
import type { LdapSchema } from "../lib/newEntryTemplates";
import { useModalA11y, decideBackdropClose } from "../lib/modal";
import { bytesToBase64, looksBinaryAttribute } from "../lib/binaryValue";
import { attributeValueKind, isBinaryKind } from "../lib/valueKinds";
import { builtinAttributeInfo, builtinAttributeNames } from "../lib/builtinSchema";
import { writeClipboardText } from "../lib/clipboard";
import { t } from "../lib/i18n";
import ValueEditorDialog, { type ValueDialogKind } from "./ValueEditorDialog.vue";
import AssociationPanel from "./AssociationPanel.vue";
import ObjectClassPickerDialog from "./ObjectClassPickerDialog.vue";

export interface AttrRowDraft extends AttrRowDraftSource {
  /** 源值自身含换行：编辑后按行重切分为多值（歧义提示用）。 */
  multiline?: boolean;
  /** 行内「数据类型」手动覆盖，仅限 schema/内置表查无定义的属性；改属性名即复位。 */
  kindOverride?: SelectableValueKind;
}

// 行内类型下拉可选的值类型：RowEditorKind 去掉 text 兜底与 AD 专用 uac
//（uac 是 AD userAccountControl 的专用合成编辑器，对自定义属性无意义）。
type SelectableValueKind = "integer" | "boolean" | "datetime" | "filetime" | "dn" | "binary" | "password" | "oid";
const SELECTABLE_KINDS: ReadonlyArray<SelectableValueKind> = ["integer", "boolean", "datetime", "filetime", "dn", "binary", "password", "oid"];

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
  /** F9 多开页签：打开条目 DN 工作集（原始大小写）；缺省或 ≤1 条时不渲染页签条。 */
  openTabs?: string[];
  /** F9 多开页签：当前激活 DN（与 openTabs 配对，由控制方维护）。 */
  activeTabDn?: string;
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
  /** F9 多开页签：切页签（仅 !dirty 时发出；dirty 时否决并 emit notify）。 */
  (e: "switchTab", dn: string): void;
  /** F9 多开页签：关闭某页签（含 active 页签；是否连带关弹窗由控制方决定）。 */
  (e: "closeTab", dn: string): void;
  /** F9 多开页签：脏态翻转上报（与 footer「有未保存的修改」同一条判定）。 */
  (e: "dirtyChange", dirty: boolean): void;
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
// 保存前值类型轻校验警告（不阻断）：save 时对被修改属性的值跑
// validateValueKind，命中才显示；重新打开会话时清空上一轮残留。
const valueKindWarnings = ref<Array<{ attribute: string; message: string }>>([]);
// 变更预览（仅 edit 态）：save 先 diff 出 changes 并挂起，确认后才真正发
// modify；取消则只关预览层、编辑原样保留。
const changesOpen = ref(false);
const pendingChanges = ref<LdapModifyChange[]>([]);
// objectClass 选择器（chips 行「添加」）：记录目标行，选中类写回该行。
const ocPickerOpen = ref(false);
const activeOcRow = ref<AttrRowDraft | null>(null);
// 值行右键菜单状态（见 openRowMenu）：记录打开菜单的行/目标与 fixed 坐标。
// 声明须在 initFor 之前——initFor 由 immediate watch 在 setup 期同步调用。
type CopyMenuAction = "raw" | "base64" | "hex" | "name" | "nameValueLdif";
type RowMenuState = { x: number; y: number; kind: "row" | "dn"; row?: AttrRowDraft };
const rowMenu = ref<RowMenuState | null>(null);
// 值编辑器弹窗（ADS 交互）的目标行：声明须在 initFor 之前——initFor 由
// immediate watch 在 setup 期同步调用。
const valueEditorRow = ref<AttrRowDraft | null>(null);
const attrEditor = ref<HTMLElement>();
const rdnInputEl = ref<HTMLInputElement>();
const requiredErrorId = useId();
const rdnErrorId = useId();
const parentErrorId = useId();
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
// 复制预填态的 RDN 是「属性=」（值待填）：与真正的格式无效区分开，提示
// 「补 RDN 值」而不是误导性的「请使用 属性=值 形式」。判定从宽：无顶层逗号、
// 每个 + 分量都是 属性名=空 即视为待填值。
const rdnValueEmpty = computed(() => {
  if (!isAdd.value) return false;
  const rdn = activeDnParts.value.rdn.trim();
  if (rdn === "" || rdn.includes(",")) return false;
  return rdn.split("+").every((component) => /^[^=]+=\s*$/.test(component.trim()));
});
// RDN 字段 → RDN 属性行单向同步（复制预填闭环，对齐向导的单一数据源语义）：
// 复制后 RDN 属性行留空，用户只填 RDN 字段时属性行仍是空串，保存会把空值
// 发给服务器（AD 拒收）。只覆盖空行、或仍等于上一拍 RDN 值段的行——用户
// 手改过的属性行不被静默清掉。LDIF 页签下 rows 由 LDIF 驱动，不做同步。
watch(rdnDraft, (next, previous) => {
  if (!isAdd.value || editorTab.value === "ldif" || !isLikelyRdn(next)) return;
  let components: Array<{ attribute: string; value: string }>;
  try {
    components = parseRdnAttributes(next);
  } catch {
    return; // BER（# 前缀）等不受支持的值段：不同步，交给保存守卫
  }
  const previousValues = new Map<string, string>();
  try {
    for (const { attribute, value } of parseRdnAttributes(previous ?? "")) previousValues.set(attribute.toLowerCase(), value);
  } catch {
    // 上一拍不合法（如预填的「属性=」）视为无可比对值
  }
  for (const { attribute, value } of components) {
    if (!value.trim()) continue;
    const row = rows.value.find((candidate) => candidate.name.split(";")[0].trim().toLowerCase() === attribute.toLowerCase());
    if (!row) continue;
    if (row.valuesText === "" || row.valuesText === (previousValues.get(attribute.toLowerCase()) ?? "")) row.valuesText = value;
  }
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

// rows → LDIF 文本：仅由 switchToLdif 主动调用（K-3 移除了表单页签的自动同步），
// 保证进入 LDIF 页签时文本反映最新 rows。
function syncLdifFromRows() {
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
  valueKindWarnings.value = [];
  // 重新打开时清掉上一轮的预览/选择器/复制菜单状态（否则层会残留到新条目会话）。
  changesOpen.value = false;
  pendingChanges.value = [];
  ocPickerOpen.value = false;
  activeOcRow.value = null;
  rowMenu.value = null;
  valueEditorRow.value = null;
  if (mode_ === "add") {
    dnDraft.value = parentDn || "";
    // 复制条目预填：RDN 属性名保留（值待填），属性行由预填铺开
    //（多值行天然支持，属性 datalist/MUST 标记照常生效）。
    rdnDraft.value = props.addPrefill?.rdn ?? "";
    rows.value = props.addPrefill
      ? entryToRows({ dn: "", attributes: props.addPrefill.attributes })
      : [{ name: "objectClass", valuesText: "top" }];
    // LDIF 文本不在此预热（K-3）：add 态进 LDIF 页签必经 switchToLdif，
    // 到时再按 rows 序列化一次即可。
    ldifText.value = "";
    // 打开即聚焦 RDN：新建会话的第一处必填输入（复制态它是唯一阻断保存
    // 的空缺），省一次手动定位；LDIF 页签/只读态输入框禁用，不抢焦点。
    void nextTick(() => {
      if (mode.value === "add" && editorTab.value === "form" && editable.value) rdnInputEl.value?.focus();
    });
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

// -- 打开条目页签（F9，最小形态）---------------------------------------------
// 工作集状态（打开列表/激活项）由控制方持有，经 openTabs/activeTabDn 透传；
// 本组件只做事件上报与脏态否决，不做每页签行状态缓存（架构裁决：不做行级
// 重构）。tabDirty 与 footer「有未保存的修改」提示（模板 v-if）同一条判定，
// 保证视觉与守卫一致。声明刻意放在 initFor 的 immediate watch 之后：watcher
// 建立时 rows 已按当前条目填充，初始基线正确，挂载期不会发出虚假翻转。
const tabDirty = computed(() => props.canWrite && dirty.value && !props.loading && !props.loadError);
// 页签条渲染条件：≥2 个打开条目且非 add 态（正在创建的新条目不属于工作集）。
const showEntryTabs = computed(() => !isAdd.value && (props.openTabs?.length ?? 0) > 1);
const tabPickerOpen = ref(false);
// F9：页签条「＋」从目录选择新条目开新页签（复用 DnPickerDialog 嵌套打开，
// 堆叠语义由 modal.ts 栈保证）；脏态时打开选择器等同切走，先否决。
function openTabPicker() {
  if (tabDirty.value) {
    emit("notify", t("editor.changed"));
    return;
  }
  tabPickerOpen.value = true;
}
function onTabPick(dn: string) {
  tabPickerOpen.value = false;
  emit("switchTab", dn);
}
// 脏态翻转即上报（watch 非 immediate：仅在 false↔true 边沿发出）。
watch(tabDirty, (value) => emit("dirtyChange", value));

function switchEntryTab(dn: string) {
  // 点击当前激活页签是空操作：不重发 switchTab、也不弹脏态提示（无谓打扰）。
  if (dn === props.activeTabDn) return;
  // 脏态否决：有未保存的修改时禁止切走，只提示（与 footer 文案同键）。
  if (tabDirty.value) {
    emit("notify", t("editor.changed"));
    return;
  }
  emit("switchTab", dn);
}

// roving tabindex（WAI-ARIA tabs 惯例）：激活页签是页签条唯一的 Tab 进入点
// （tabindex=0），其余页签 tabindex=-1、只经方向键聚焦。activeTabDn 未命中
// 列表时兜底首个页签，避免控制方数据不齐时整条页签条脱离 Tab 序。
const focusableTabIndex = computed(() => {
  const index = (props.openTabs ?? []).indexOf(props.activeTabDn ?? "");
  return index < 0 ? 0 : index;
});

// 页签条键盘导航（WAI-ARIA tabs，manual activation）：←/→/↑/↓ 在页签间循环
// 移动焦点，Home/End 跳首尾；只移动焦点、不切换——切换仍走点击/Enter/Space，
// 脏态否决只在那条路径上，键盘移动焦点不触碰 switchEntryTab。焦点不在
// role=tab 上（如 ✕/＋ 按钮）时不劫持方向键，把惯例范围限制在页签本体内。
function onTablistKeydown(event: KeyboardEvent) {
  const current = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="tab"]') : null;
  if (!current) return;
  const list = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const tabEls = Array.from(list?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
  const index = tabEls.indexOf(current);
  if (index < 0) return;
  let next: number;
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      next = (index + 1) % tabEls.length;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = index <= 0 ? tabEls.length - 1 : index - 1;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = tabEls.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  tabEls[next]?.focus();
}

// rows→LDIF 不做自动同步（K-3）：表单页签下 ldifText 没有任何读取者，逐键
// 全量序列化纯属浪费；进入 LDIF 页签的唯一入口 switchToLdif 会先同步一次。
function switchToLdif() {
  if (editorTab.value !== "ldif") syncLdifFromRows();
  editorTab.value = "ldif";
  // An LDIF is expected to represent the complete entry, including binary
  // values.  Request those fields only when the user explicitly enters it.
  emit("loadDeferred");
}

// 离开 LDIF 页签的共用守卫：先把 LDIF 文本解析回 rows，成功才允许切走。
// 切到关联页同样必须过这里——LDIF 里的编辑若不落回 rows，切回表单时会被
// rows→LDIF 重同步覆盖（用户编辑静默丢失）。解析回 rows 后不存在自动的
// rows→LDIF 重写（K-3 已移除），LDIF 文本原样保留到下次进入该页签。
function leaveLdif(): boolean {
  if (editorTab.value !== "ldif") return true;
  return syncRowsFromLdif();
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
  // 名字启发式（photo/certificate/userPKCS12）先于注册表：这些属性名即使
  // schema 缺失也要进二进制编辑器（binaryValue 的职责，注册表不重复维护）。
  if (looksBinaryAttribute(key)) return "binary";
  const info = schemaAttributeInfo(key);
  // 分流完全走 valueKinds 注册表（J-12）：password 名绑定/后缀规则也由
  // 注册表给出（对齐 ADS PasswordValueEditor 的属性名绑定），不再前置特判。
  const kind = attributeValueKind(key, info, props.schema?.serverInfo?.dialect);
  if (isBinaryKind(kind)) return "binary";
  // oid（supportedControl 等 OID 语法）此前未映射、落回 text：这里接上，
  // 表单页签给出带格式的单行输入与行内校验。
  if (kind === "datetime" || kind === "filetime" || kind === "dn" || kind === "boolean" || kind === "integer" || kind === "uac" || kind === "oid" || kind === "password") return kind;
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

// 单值降级与布尔非常规值回退是编辑器形态约束，对手动覆盖的类型同样生效。
function degradeRowKind(kind: RowEditorKind, row: AttrRowDraft): RowEditorKind {
  if (SINGLE_VALUE_KINDS.includes(kind) && rowValues(row).length > 1) return "text";
  if (kind === "boolean" && row.valuesText.trim() !== "" && !/^(true|false)$/iu.test(row.valuesText.trim())) return "text";
  return kind;
}

function rowEditorKind(row: AttrRowDraft): RowEditorKind {
  // 行内「数据类型」手动覆盖优先于 schema 推导：用户显式选择就按它分流。
  if (row.kindOverride) return degradeRowKind(row.kindOverride, row);
  return degradeRowKind(editorKind(row.name), row);
}

// ADS 交互：特殊类型值（时间/DN/二进制/密码/UAC）走弹窗编辑器；文本/整数/
// 布尔/OID 保持内联。多值行降级 textarea 的规则不变（弹窗编辑器是单值语义，
// binary 除外——它自持数组语义，弹窗壳按 \n 切分/合并）。
const DIALOG_VALUE_KINDS: ReadonlyArray<ValueDialogKind> = ["datetime", "filetime", "dn", "binary", "password", "uac"];

function isDialogValueKind(kind: RowEditorKind): kind is ValueDialogKind {
  return (DIALOG_VALUE_KINDS as ReadonlyArray<string>).includes(kind);
}

// 打开中的值编辑弹窗：目标行 ref 声明在 rowMenu 旁（initFor 之前），
// kind 由 rowEditorKind 现算。
const valueEditorKind = computed<ValueDialogKind>(() =>
  valueEditorRow.value ? (rowEditorKind(valueEditorRow.value) as ValueDialogKind) : "datetime",
);

function openValueEditor(row: AttrRowDraft) {
  if (!editable.value) return;
  valueEditorRow.value = row;
}

// OK 才写回行值；Cancel 只关弹窗（草稿留在弹窗内随开随弃）。
function onValueEditorConfirm(value: string) {
  const row = valueEditorRow.value;
  valueEditorRow.value = null;
  if (row) row.valuesText = value;
}

function onValueEditorCancel() {
  valueEditorRow.value = null;
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

function kindFormatLabel(kind: RowEditorKind): string {
  switch (kind) {
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

function valueFormatLabel(row: AttrRowDraft): string {
  if (isObjectClassRow(row)) return t("ldap.valueEditors.formatObjectClass");
  return kindFormatLabel(row.kindOverride ?? editorKind(row.name));
}

// 值类型显示名：复用 valueFormatLabel 的 formatXxx 映射（保存前警告文案用）。
function kindDisplayLabel(name: string): string {
  return valueFormatLabel({ name, valuesText: "" });
}

// 属性是否已有权威类型定义（RFC 4512）：服务器 schema attributeInfo 或内置
// 兜底表查得到定义即视为已知——语法是权威，编辑器严格按语法推导，不提供
// 手动覆盖。仅检查「有无定义」，与语法是否映射到专用编辑器无关。
function attributeTypeDefined(key: string): boolean {
  const info = props.schema?.attributeInfo;
  if (info) {
    if (info[key]) return true;
    if (Object.keys(info).some((name) => name.toLowerCase() === key)) return true;
  }
  return builtinAttributeInfo(key) !== undefined;
}

// 行内「数据类型」下拉的显隐：仅可编辑、非 objectClass 的行；且属性在
// schema/内置表里查无定义（客户端无从得知语法）时才开放手动选择——
// 已定义属性的语法是权威（RFC 4512），表单不允许改，要改先改服务器 schema。
function showKindSelect(row: AttrRowDraft): boolean {
  if (isObjectClassRow(row) || row.name.trim() === "" || !editable.value) return false;
  const key = row.name.split(";")[0].trim().toLowerCase();
  if (attributeTypeDefined(key)) return false;
  return row.kindOverride !== undefined || editorKind(row.name) === "text";
}

function onKindChange(row: AttrRowDraft, value: string) {
  if (value === "auto") delete row.kindOverride;
  else row.kindOverride = value as SelectableValueKind;
}

// 类型覆盖归属具体属性：改名即复位为自动，避免把旧类型套到新属性上。
function onNameInput(row: AttrRowDraft) {
  delete row.kindOverride;
}

// -- 保存前值类型轻校验（警告、不阻断）：对提交值逐个跑 validateValueKind。
// kind 分流与行编辑器一致（schemaAttributeInfo → valueKinds）；objectClass
// 由专用 chips 编辑且值恒为类名，跳过。同一属性多值命中同一警告时只提示一次。
function kindWarningsFor(attributes: Record<string, string[]>): Array<{ attribute: string; message: string }> {
  const warnings: Array<{ attribute: string; message: string }> = [];
  const seen = new Set<string>();
  // 手动覆盖的类型与行编辑器一致：保存前校验同样按覆盖类型跑。
  const overrides = new Map<string, SelectableValueKind>();
  for (const row of rows.value) {
    if (row.kindOverride) overrides.set(row.name.split(";")[0].trim().toLowerCase(), row.kindOverride);
  }
  for (const [name, values] of Object.entries(attributes)) {
    const base = name.split(";")[0].trim();
    const key = base.toLowerCase();
    if (!key || key === "objectclass") continue;
    const kind = overrides.get(key) ?? attributeValueKind(key, schemaAttributeInfo(key), props.schema?.serverInfo?.dialect);
    for (const value of values) {
      if (value.trim() === "") continue;
      if (validateValueKind(kind, value) === null || seen.has(`${key}:${kind}`)) continue;
      seen.add(`${key}:${kind}`);
      warnings.push({ attribute: base, message: t("editor.valueKindWarning", { kind: kindDisplayLabel(base) }) });
    }
  }
  return warnings;
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

// 值复制三选（F8→UX-V7）的编码辅助：Base64 / hex 均按 UTF-8 字节编码（TextEncoder）。
// Base64 复用 binaryValue 的分块编码 helper（大值不爆栈），hex 输出大写。
// 值统一按字符串原样处理：二进制属性在表单里存的就是 base64 文本，不做解码分支。
function utf8BytesOf(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function copyValueAsBase64(row: AttrRowDraft) {
  await copyText(bytesToBase64(utf8BytesOf(row.valuesText)));
}

async function copyValueAsHex(row: AttrRowDraft) {
  const bytes = utf8BytesOf(row.valuesText);
  let hex = "";
  for (let index = 0; index < bytes.length; index += 1) hex += (bytes[index] as number).toString(16).padStart(2, "0").toUpperCase();
  await copyText(hex);
}

// -- 值行右键「复制」菜单（UX-V7→右键化）：行内复制按钮全部移除，改为在
// 属性行/DN 行上 contextmenu 打开统一菜单（对标 ADS 的右键复制）。形态照抄
// WorkbenchToolbar 的下拉约定（复用全局 .context-menu 类 + fixed 定位打开时
// 算一次坐标）：外点/Escape 关闭，Escape 停止冒泡避免误触弹窗关闭守卫，
// 菜单项用原生 button 保证 Tab/Enter 可达；坐标按鼠标落点并夹在视口内。

const rowMenuEl = ref<HTMLElement>();
let rowMenuTrigger: HTMLElement | null = null;

function openRowMenu(state: Omit<RowMenuState, "x" | "y">, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  rowMenuTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  // 菜单约 200px 宽、5 项高：右键落点向左/上夹紧防溢出视口。
  rowMenu.value = {
    x: Math.max(4, Math.min(event.clientX, window.innerWidth - 210)),
    y: Math.max(4, Math.min(event.clientY, window.innerHeight - 190)),
    ...state,
  };
  void nextTick(() => rowMenuEl.value?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus({ preventScroll: true }));
}

function closeRowMenu(restoreFocus = false) {
  if (!rowMenu.value) return;
  rowMenu.value = null;
  if (restoreFocus) rowMenuTrigger?.focus({ preventScroll: true });
}

// 菜单项执行即关闭：先关菜单再复制，焦点归还触发元素。
async function runRowMenuAction(action: CopyMenuAction | "dn") {
  const menu = rowMenu.value;
  closeRowMenu(true);
  if (!menu) return;
  if (action === "dn") {
    await copyText(dnDraft.value);
    return;
  }
  const row = menu.row;
  if (!row) return;
  // LDIF 属性行：属性名 + 折行值（续行按 LDIF 规则以空格开头）。
  if (action === "raw") await copyText(row.valuesText);
  else if (action === "base64") await copyValueAsBase64(row);
  else if (action === "hex") await copyValueAsHex(row);
  else if (action === "name") await copyText(row.name);
  else await copyText(`${row.name}: ${row.valuesText.replace(/\n/g, "\n ")}`);
}

// 菜单内键盘：Escape 关闭并归还焦点；↑/↓ 在菜单项间循环移动焦点。
function onRowMenuKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeRowMenu(true);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  event.stopPropagation();
  const items = Array.from(rowMenuEl.value?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])") ?? []);
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "ArrowUp" ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
  items[next]?.focus({ preventScroll: true });
}

// 文档级兜底（WorkbenchToolbar 同款注册/清理模式，延后一拍防注册即触发）：
// 点击外部关闭；焦点散落菜单外时的 Escape 也只关菜单、不冒泡到弹窗守卫。
function onDocumentClick() {
  closeRowMenu();
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !rowMenu.value) return;
  event.preventDefault();
  event.stopPropagation();
  closeRowMenu(true);
}

onMounted(() => {
  window.setTimeout(() => {
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onDocumentKeydown);
  }, 0);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onDocumentKeydown);
});

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
      const attributes = rowsToAttributes();
      // 保存前轻校验：值类型不符只提示，不 return、不禁用（服务器才是权威）。
      valueKindWarnings.value = kindWarningsFor(attributes);
      await ldapApi.entryAdd(dn, attributes);
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
  // 保存前轻校验针对被修改的属性（delete 的 values 为空，天然跳过）。
  valueKindWarnings.value = kindWarningsFor(Object.fromEntries(changes.map((change) => [change.attribute, change.values])));
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
  // 二层 UI 在场时先明确处置（确认/取消、加类完成），Esc/遮罩不动编辑器；
  // 复制下拉在场同理——Esc 的第一拍只关菜单（兜底见 onDocumentKeydown）。
  if (changesOpen.value || ocPickerOpen.value || valueEditorRow.value) return false;
  if (rowMenu.value) return false;
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
      <!-- 打开条目页签条（F9）：≥2 个打开条目时出现在标题与 DN 行之间。DOM
           安全性：页签本体是 span[role=tab]（键盘可达性由 roving tabindex +
           方向键移动焦点 + Enter/Space 切换提供，tablist 级 @keydown 见
           onTablistKeydown），✕ 是其兄弟 button——HTML 不允许 button 嵌 button。 -->
      <div v-if="showEntryTabs" class="entry-tabs" role="tablist" @keydown="onTablistKeydown">
        <div v-for="(dn, index) in openTabs" :key="dn" class="entry-tab-shell" :class="{ 'is-active': dn === activeTabDn }">
          <span
            class="entry-tab"
            role="tab"
            :tabindex="index === focusableTabIndex ? 0 : -1"
            :aria-selected="dn === activeTabDn"
            :title="dn"
            @click="switchEntryTab(dn)"
            @keydown.enter.prevent="switchEntryTab(dn)"
            @keydown.space.prevent="switchEntryTab(dn)"
          >
            <span class="entry-tab-name">{{ splitFirstDnRdn(dn).rdn || dn }}</span>
            <span v-if="dn === activeTabDn && tabDirty" class="entry-tab-dirty" aria-hidden="true" />
          </span>
          <!-- ✕ 只上报 closeTab（click.stop）：active 页签的 ✕ 也只上报，
               是否连带关闭整个弹窗由控制方决定。 -->
          <button type="button" class="entry-tab-close" :title="t('close')" :aria-label="t('close')" @click.stop="emit('closeTab', dn)"><X aria-hidden="true" /></button>
        </div>
        <button type="button" class="entry-tab-add" :title="t('dnPicker.title')" :aria-label="t('dnPicker.title')" @click="openTabPicker"><Plus aria-hidden="true" /></button>
      </div>
      <p v-if="loadingMore || loadingDeferred" class="hint" role="status">{{ t("editor.loading") }}</p>
      <div v-if="isAdd" class="attr-row add-dn-row">
        <label class="field">
          <span class="muted">{{ t("editor.rdn") }}</span>
          <input ref="rdnInputEl" v-model="rdnField" type="text" name="attr-name" class="mono" :disabled="!editable || editorTab === 'ldif'" :aria-invalid="rdnInvalid" :aria-describedby="rdnInvalid ? rdnErrorId : undefined" spellcheck="false" />
          <span v-if="rdnInvalid" :id="rdnErrorId" class="form-error" role="alert">{{ rdnValueEmpty ? t("editor.rdnValueEmpty") : t("editor.rdnInvalid") }}</span>
        </label>
        <label class="field">
          <span class="muted">{{ t("editor.parentDn") }}</span>
          <input :value="activeDnParts.parentDn" type="text" class="mono" :disabled="true" :aria-invalid="parentInvalid" :aria-describedby="parentInvalid ? parentErrorId : undefined" spellcheck="false" />
          <span v-if="parentInvalid" :id="parentErrorId" class="form-error" role="alert">{{ t("editor.dnInvalid") }}</span>
        </label>
      </div>
      <!-- relation 展示下外层标签已标识条目（走查反馈：不再重复整行长
           DN），DN 行仅在普通弹窗态渲染；右键复制 DN 也只保留在弹窗态。 -->
      <div v-else-if="!isRelationPresentation" class="entry-dn-row" @contextmenu.prevent="openRowMenu({ kind: 'dn' }, $event)">
        <p class="entry-dn" :title="dnDraft">{{ dnDraft }}</p>
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
      <!-- 值类型轻校验警告：只提示不阻断（role=status 非 alert），保存照常进行。 -->
      <div v-if="valueKindWarnings.length > 0 && editorTab !== 'assoc'" class="form-error value-kind-warnings" role="status">
        <span v-for="warning in valueKindWarnings" :key="warning.attribute"><span class="mono">{{ warning.attribute }}</span>: {{ warning.message }}</span>
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
          <!-- 右键复制（对标 ADS）：行内复制按钮已移除，contextmenu 打开
               统一菜单（原值/Base64/hex/属性名/LDIF 属性行）； LDIF 文本区
               仍走页签上的整段复制按钮。 -->
          <div v-for="(row, index) in rows" :key="index" class="attr-row" @contextmenu.prevent="openRowMenu({ kind: 'row', row }, $event)">
            <div class="attr-name-field">
              <input v-model="row.name" type="text" name="attr-name" :list="attributeListId" :placeholder="t('editor.attribute')" :aria-label="t('editor.attribute')" :title="row.name" :disabled="!editable" spellcheck="false" @input="onNameInput(row)" />
              <div class="attr-meta">
                <!-- 行内「数据类型」：schema 推不出的属性可手动指定值编辑器；
                     有专用编辑器的行保持静态类型标签不变。 -->
                <select
                  v-if="showKindSelect(row)"
                  class="kind-select"
                  :value="row.kindOverride ?? 'auto'"
                  :aria-label="t('editor.valueKindLabel')"
                  :title="t('editor.valueKindLabel')"
                  :disabled="!editable"
                  @change="onKindChange(row, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="auto">{{ t("editor.valueKindAuto") }}</option>
                  <option v-for="kind in SELECTABLE_KINDS" :key="kind" :value="kind">{{ kindFormatLabel(kind) }}</option>
                </select>
                <span v-else class="attr-format-label">{{ valueFormatLabel(row) }}</span>
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
              <!-- ADS 交互：特殊类型值（时间/DN/二进制/密码/UAC）只读展示，
                   点「编辑」/双击打开弹窗编辑器。dn 透传（F3）：view/edit 态
                   弹窗拿到当前条目 DN 供 RFC 3062 扩展操作定位目标，add 态
                   条目尚未创建，不传。 -->
              <template v-else-if="isDialogValueKind(rowEditorKind(row))">
                <div class="value-display-row" @dblclick="openValueEditor(row)">
                  <span class="value-display mono" :title="row.valuesText">{{ row.valuesText }}</span>
                  <button
                    type="button"
                    class="icon-button value-edit-button"
                    :title="t('editor.valueEditorEdit')"
                    :aria-label="t('editor.valueEditorEdit')"
                    :disabled="!editable"
                    @click="openValueEditor(row)"
                  >
                    <Pencil aria-hidden="true" />
                  </button>
                </div>
              </template>
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
      <!-- 右键复制统一菜单：kind=dn 只有复制 DN；kind=row 为原值/Base64/hex/
           属性名/LDIF 属性行。禁用态在菜单项上判定（空值行只可复制属性名）。 -->
      <div
        v-if="rowMenu"
        ref="rowMenuEl"
        class="context-menu"
        role="menu"
        tabindex="-1"
        :style="{ left: `${rowMenu.x}px`, top: `${rowMenu.y}px`, width: '200px' }"
        @click.stop
        @contextmenu.prevent
        @keydown="onRowMenuKeydown"
      >
        <template v-if="rowMenu.kind === 'dn'">
          <button type="button" role="menuitem" :title="t('copyDn')" @click="runRowMenuAction('dn')">
            <Copy class="context-menu-item-icon" aria-hidden="true" />
            <span class="context-menu-item-label">{{ t("copyDn") }}</span>
          </button>
        </template>
        <template v-else-if="rowMenu.row">
          <button type="button" role="menuitem" :title="t('ldap.valueEditors.copyRaw')" :disabled="rowMenu.row.valuesText === ''" @click="runRowMenuAction('raw')">
            <Copy class="context-menu-item-icon" aria-hidden="true" />
            <span class="context-menu-item-label">{{ t("ldap.valueEditors.copyRaw") }}</span>
          </button>
          <button type="button" role="menuitem" :title="t('ldap.valueEditors.copyBase64')" :disabled="rowMenu.row.valuesText === ''" @click="runRowMenuAction('base64')">
            <Copy class="context-menu-item-icon" aria-hidden="true" />
            <span class="context-menu-item-label">{{ t("ldap.valueEditors.copyBase64") }}</span>
          </button>
          <button type="button" role="menuitem" :title="t('ldap.valueEditors.copyHex')" :disabled="rowMenu.row.valuesText === ''" @click="runRowMenuAction('hex')">
            <Copy class="context-menu-item-icon" aria-hidden="true" />
            <span class="context-menu-item-label">{{ t("ldap.valueEditors.copyHex") }}</span>
          </button>
          <hr />
          <button type="button" role="menuitem" :title="t('ldap.valueEditors.copyName')" :disabled="rowMenu.row.name === ''" @click="runRowMenuAction('name')">
            <Copy class="context-menu-item-icon" aria-hidden="true" />
            <span class="context-menu-item-label">{{ t("ldap.valueEditors.copyName") }}</span>
          </button>
          <button type="button" role="menuitem" :title="t('ldap.valueEditors.copyNameValueLdif')" :disabled="rowMenu.row.valuesText === '' || rowMenu.row.name === ''" @click="runRowMenuAction('nameValueLdif')">
            <Copy class="context-menu-item-icon" aria-hidden="true" />
            <span class="context-menu-item-label">{{ t("ldap.valueEditors.copyNameValueLdif") }}</span>
          </button>
        </template>
      </div>
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
  <!-- 值编辑器弹窗（ADS 交互）：特殊类型值的第二层模态编辑壳，OK 写回 / Cancel 丢弃。 -->
  <ValueEditorDialog
    :open="valueEditorRow !== null"
    :kind="valueEditorKind"
    :attribute-name="valueEditorRow?.name ?? ''"
    :model-value="valueEditorRow?.valuesText ?? ''"
    :disabled="!editable"
    :base-dn="baseDn"
    :dn="isAdd ? undefined : dnDraft"
    @confirm="onValueEditorConfirm"
    @close="onValueEditorCancel"
    @open-reference="(dn: string) => emit('openRelatedEntry', dn, valueEditorRow?.name)"
    @notify="(m: string) => emit('notify', m)"
    @error="(m: string) => emit('error', m)"
    @plain-generated="onPlainGenerated"
  />
    <DnPickerDialog :open="tabPickerOpen" :base-dn="baseDn ?? ''" @close="tabPickerOpen = false" @select="onTabPick" />
</template>

<style scoped>
/* add 态 DN 行（RDN / 父 DN）：.field 纵向布局让标签在上、输入在下——否则
   标签与输入按行内流排布，两字段基线错位（走查截图回归）。RDN 列放宽给
   「属性=值」与校验提示，父 DN 只读展示占余宽。 */
.add-dn-row {
  grid-template-columns: minmax(220px, 340px) minmax(0, 1fr);
}
.add-dn-row .field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
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
/* 值类型轻校验警告（不阻断）：琥珀色调与 .command-warn 同一约定，区别于
   .form-error 的阻断红；多属性命中时纵向排列。 */
.value-kind-warnings {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: color-mix(in srgb, var(--muted-foreground) 70%, #d97706);
}
/* 行内「数据类型」下拉：替代 text 行的静态类型标签，胶囊外形对齐
   .attr-format-label（全局样式），宽度收紧不挤压属名列。 */
.kind-select {
  max-width: 130px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 4px;
  background: var(--background);
  color: var(--muted-foreground);
  font-family: var(--mono-font-family);
  font-size: 9px;
  line-height: 14px;
}
.kind-select:disabled {
  opacity: 0.6;
}
/* 特殊类型值（ADS 交互）：只读展示 + 编辑按钮；展示框与 textarea 同高基准，
   多值按行显示，双击值区同样唤起弹窗。 */
.value-display-row {
  display: flex;
  width: 100%;
  align-items: stretch;
  gap: 6px;
}
.value-display {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  background: var(--background);
  color: var(--foreground);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.value-edit-button {
  flex: none;
  align-self: center;
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
/* 打开条目页签条（F9）：形态对齐全局 .entry-relation-tabs（App.vue 关联双栏），
   但样式就地 scoped 落在本组件，不新增全局选择器；页签本体与 ✕ 按钮为兄弟
   节点，规避 button 嵌 button。 */
.entry-tabs {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 3px;
  background: color-mix(in srgb, var(--muted) 55%, transparent);
  scrollbar-width: thin;
}
.entry-tab-shell {
  display: inline-flex;
  width: fit-content;
  max-width: 220px;
  height: 26px;
  min-width: 0;
  flex: 0 0 auto;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--muted-foreground);
}
.entry-tab-shell:hover {
  background: color-mix(in srgb, var(--accent) 60%, transparent);
  color: var(--foreground);
}
.entry-tab-shell.is-active {
  border-color: var(--border);
  background: var(--background);
  color: var(--foreground);
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}
.entry-tab {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  padding: 0 6px 0 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.entry-tab-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 脏态圆点：仅 active 页签在脏时显示（与 footer「有未保存的修改」同源判定） */
.entry-tab-dirty {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--primary);
}
.entry-tab:focus-visible,
.entry-tab-close:focus-visible {
  z-index: 1;
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
.entry-tab-close {
  display: grid;
  width: 20px;
  height: 100%;
  flex: 0 0 20px;
  place-items: center;
  border: 0;
  border-radius: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.entry-tab-add {
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--muted-foreground);
  border-radius: 6px;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex: none;
}
.entry-tab-add:hover {
  color: var(--foreground);
}
.entry-tab-close:hover {
  background: color-mix(in srgb, var(--destructive) 14%, transparent);
  color: var(--destructive);
}
.entry-tab-close svg {
  width: 11px;
  height: 11px;
}
</style>
