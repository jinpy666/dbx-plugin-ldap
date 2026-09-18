<script setup lang="ts">
// RootDSE 服务器信息弹窗（矩阵 F12，对标 ADS RootDSEPropertyPage / phpLDAPadmin
// Server Info）：打开即并行自取 ldap/rootDse（["*","+"]，操作属性也在内）与
// ldap/connections/statuses（当前连接行），按语义分组渲染——
// 连接与服务器（状态点 / Ping 体检 / TLS 徽标 / 绑定身份 / 建连与最近使用
// / 服务器+协议摘要）/ 命名上下文 / 服务器能力（supported* 合并一节，OID 值
// 命中 lib/oidDescriptions 注册表时附 RFC 标题与描述）/ 服务器标识
// （vendor*/product*）/ 其他属性兜底；空组不渲染。
// Ping（ldap/check，与 ConnectionsPanel 同口径）与 whoami 在主体渲染后台
// 并行，失败只在行内降级；RootDSE 本身失败仍是整弹窗错误（friendly 行内
// 展示、原始串挂 title，同 DnTree treeError/treeErrorRaw 口径）并
// emit("error") 供控制方上横幅。每个值行可复制（writeClipboardText，结果经
// notify 通知），命名上下文值额外带「设为浏览基」（emit 给控制方执行，
// 成功通知也归控制方：rootDse.setBaseDone）。底部导出 root-dse.txt
// （saveTextFile 三级回退，文本形态与 App 旧直导一致：属性名排序后
// "name: v1, v2" 行）。关闭重开重新拉取（不缓存旧数据）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Download, RefreshCw, X } from "@lucide/vue";
import { getLdapConnectionId, ldapApi, type LdapCheckResult, type LdapConnectionStatus } from "../lib/api";
import { friendlyLdapError } from "../lib/ldapErrors";
import { describeLdapCheckResult } from "../lib/ldapCheck";
import { lookupOidInfo, type OidInfo } from "../lib/oidDescriptions";
import { protocolBadge, type ConnectionSummary } from "../lib/connectionIdentity";
import { writeClipboardText } from "../lib/clipboard";
import { saveTextFile, type SaveTextOutcome } from "../lib/fileSave";
import { useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";

const props = defineProps<{
  open: boolean;
  /** 当前连接摘要（工具栏同源）：TLS 徽标 / 证书校验提示等配置层信息；缺省时该行降级。 */
  connection?: ConnectionSummary | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "error", message: string): void;
  (e: "notify", message: string): void;
  (e: "setBase", baseDn: string): void;
}>();

/** ldap/rootDse 的 wire 形状：attribute 名 → 值列表。 */
type RootDseAttributes = Record<string, string[]>;

const loading = ref(false);
const attributes = ref<RootDseAttributes>({});
const loadError = ref("");
// 原始错误串：与友好文案不同才挂 title 悬停（照家族口径，未失真时不重复挂）。
const loadErrorRaw = ref("");

// -- 连接与服务器区块 ----------------------------------------------------------
// 状态行取 ldap/connections/statuses 当前连接（status/connectedAt/lastUsedAt/
// readOnly）；状态表拉取失败只降级状态行，不影响主体分组。

const connectionStatus = ref<LdapConnectionStatus | null>(null);
const statusError = ref("");

interface RowState {
  running: boolean;
  message?: string;
  /** true → 错误色（form-error），否则 muted。 */
  failed?: boolean;
}

// Ping（ldap/check）与绑定身份（whoami）各自独立：running 行内提示，
// 结果/失败互不覆盖；关闭重开会整体复位。
const checkState = ref<RowState>({ running: false });
const whoamiState = ref<RowState>({ running: false });

// 摘要单元格缺值占位（连接从未检查 / 服务器未返回该属性等）。
const EMPTY_CELL = "—";

function stateLabel(state: string): string {
  if (state === "connected") return t("connections.stateConnected");
  if (state === "error") return t("connections.stateError");
  return t("connections.stateIdle");
}

function stateDotClass(state: string): string {
  if (state === "connected") return "connected";
  if (state === "error") return "error";
  return "idle";
}

function formatTime(value?: number | string): string {
  if (value === undefined || value === null || value === "") return "";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" }).format(new Date(parsed));
}

// 摘要行从已加载的 RootDSE 取值（属性名大小写不敏感）。
function firstAttrValue(lowerName: string): string {
  const found = Object.entries(attributes.value).find(([name]) => name.toLowerCase() === lowerName);
  return found?.[1]?.[0] ?? "";
}

const serverSummary = computed(() => {
  const parts = [firstAttrValue("productname"), firstAttrValue("vendorversion")].filter(Boolean);
  return parts.join(" ") || EMPTY_CELL;
});

const protocolSummary = computed(() => {
  const versions = Object.entries(attributes.value).find(([name]) => name.toLowerCase() === "supportedldapversion")?.[1];
  return (versions ?? []).join(", ") || EMPTY_CELL;
});

const connectedAtText = computed(() => formatTime(connectionStatus.value?.connectedAt) || EMPTY_CELL);
const lastUsedText = computed(() => formatTime(connectionStatus.value?.lastUsedAt) || EMPTY_CELL);

// TLS 徽标（配置层口径，工具栏同源）；仅 TLS 模式显式关闭证书校验时附提示。
const tlsBadge = computed(() => (props.connection ? protocolBadge(props.connection) : "") || EMPTY_CELL);
const tlsVerifyOff = computed(() => {
  const external = props.connection?.external_config;
  if (!external || typeof external !== "object") return false;
  const config = external as Record<string, unknown>;
  const mode = String(config["tls_mode"] ?? "").toLowerCase();
  if (mode !== "ldaps" && mode !== "starttls") return false;
  return config["tls_verify"] === false;
});

// -- 语义分组 ----------------------------------------------------------------
// 归组按 attribute 名小写匹配（LDAP 属性名大小写不敏感，sidecar 返回大小写
// 因服务器而异）。组标题走 i18n（rootDse.group*）。

/** namingContexts 归「命名上下文」：值行带「设为浏览基」。 */
const NAMING_CONTEXT_NAMES = new Set(["namingcontexts"]);
/** 服务器能力组：supported* 五个属性合并为「服务器能力」一节，按声明顺序展示。 */
const CAPABILITY_NAMES = [
  "supportedcontrol",
  "supportedextension",
  "supportedfeatures",
  "supportedsaslmechanisms",
  "supportedldapversion",
];
/** 服务器标识组：vendorName / vendorVersion / productName 属性。 */
const IDENTITY_NAMES = ["vendorname", "vendorversion", "productname"];

interface RootDseAttributeRow {
  name: string;
  values: string[];
  isNamingContext: boolean;
}

interface RootDseGroup {
  key: string;
  title: string;
  rows: RootDseAttributeRow[];
}

const GROUP_TITLES: Record<string, () => string> = {
  naming: () => t("rootDse.groupNaming"),
  capability: () => t("rootDse.groupCapability"),
  identity: () => t("rootDse.groupIdentity"),
  other: () => t("rootDse.groupOther"),
};

const groups = computed<RootDseGroup[]>(() => {
  // 小写名索引：归组匹配与原样展示名（保留服务器返回的大小写）解耦。
  const byLower = new Map<string, { name: string; values: string[] }>();
  for (const [name, values] of Object.entries(attributes.value)) {
    const list = values ?? [];
    if (list.length === 0) continue;
    byLower.set(name.toLowerCase(), { name, values: list });
  }

  const pickRows = (lowerNames: string[]): RootDseAttributeRow[] => {
    const rows: RootDseAttributeRow[] = [];
    for (const lower of lowerNames) {
      const found = byLower.get(lower);
      if (!found) continue;
      rows.push({ name: found.name, values: found.values, isNamingContext: NAMING_CONTEXT_NAMES.has(lower) });
    }
    return rows;
  };

  // 其他属性兜底：不属于已知组的属性，按服务器返回顺序（其余组按声明顺序）。
  const known = new Set<string>([...NAMING_CONTEXT_NAMES, ...CAPABILITY_NAMES, ...IDENTITY_NAMES]);
  const otherRows: RootDseAttributeRow[] = [];
  for (const [name, values] of Object.entries(attributes.value)) {
    const list = values ?? [];
    if (list.length === 0 || known.has(name.toLowerCase())) continue;
    otherRows.push({ name, values: list, isNamingContext: false });
  }

  const result: RootDseGroup[] = [];
  const namingRows = pickRows([...NAMING_CONTEXT_NAMES]);
  if (namingRows.length > 0) result.push({ key: "naming", title: GROUP_TITLES.naming(), rows: namingRows });
  const capabilityRows = pickRows(CAPABILITY_NAMES);
  if (capabilityRows.length > 0) result.push({ key: "capability", title: GROUP_TITLES.capability(), rows: capabilityRows });
  const identityRows = pickRows(IDENTITY_NAMES);
  if (identityRows.length > 0) result.push({ key: "identity", title: GROUP_TITLES.identity(), rows: identityRows });
  if (otherRows.length > 0) result.push({ key: "other", title: GROUP_TITLES.other(), rows: otherRows });
  return result;
});

/** 组头计数：该组属性值的总个数（上下文/控制 OID 数等，比属性数更直观）。 */
function valueCount(group: RootDseGroup): number {
  return group.rows.reduce((total, row) => total + row.values.length, 0);
}

/** 值条目：OID 形态的值（supportedControl/Extension/Features 等）命中注册表
 * 时附带 RFC 标题与描述，其余只显原值。 */
interface RootDseValueItem {
  value: string;
  oid?: OidInfo;
}

function rowItems(row: RootDseAttributeRow): RootDseValueItem[] {
  return row.values.map((value) => ({ value, oid: lookupOidInfo(value) }));
}

// -- 数据加载 ----------------------------------------------------------------

// 打开序号：关闭在途的旧请求晚于新开请求返回时，不得覆盖新一轮数据。
let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  loading.value = true;
  loadError.value = "";
  loadErrorRaw.value = "";
  connectionStatus.value = null;
  statusError.value = "";
  checkState.value = { running: false };
  whoamiState.value = { running: false };
  // RootDSE 是主体（失败 = 整弹窗错误）；连接状态表并行取，失败只降级状态行。
  const [dseSettled, statusSettled] = await Promise.allSettled([ldapApi.rootDse(), ldapApi.connectionStatuses()]);
  if (seq !== loadSeq) return;
  loading.value = false;
  if (statusSettled.status === "fulfilled") {
    const mine = (statusSettled.value.statuses || []).find((row) => row.connectionId === getLdapConnectionId());
    connectionStatus.value = mine ?? null;
  } else {
    const raw = statusSettled.reason instanceof Error ? statusSettled.reason.message : String(statusSettled.reason);
    statusError.value = friendlyLdapError(raw);
  }
  if (dseSettled.status === "rejected") {
    attributes.value = {};
    const raw = dseSettled.reason instanceof Error ? dseSettled.reason.message : String(dseSettled.reason);
    loadError.value = friendlyLdapError(raw);
    loadErrorRaw.value = loadError.value === raw ? "" : raw;
    // 友好文案冒泡给控制方（横幅口径同 PasswordAttributeEditor）。
    emit("error", loadError.value);
    return;
  }
  attributes.value = dseSettled.value.attributes || {};
  // 连接体检与身份查询后台并行（各自 running 态），不阻塞主体渲染。
  void runCheck(seq);
  void runWhoami(seq);
}

// 连接体检（ldap/check，与 ConnectionsPanel 同口径）：网络延迟 + bind 校验。
async function runCheck(seq: number) {
  if (!getLdapConnectionId()) return;
  checkState.value = { running: true };
  try {
    const result: LdapCheckResult = await ldapApi.check(getLdapConnectionId());
    if (seq !== loadSeq) return;
    checkState.value = { running: false, ...describeLdapCheckResult(result) };
  } catch (cause) {
    if (seq !== loadSeq) return;
    const raw = cause instanceof Error ? cause.message : String(cause);
    checkState.value = { running: false, message: t("connections.checkFail", { error: friendlyLdapError(raw) }), failed: true };
  }
}

// 身份查询（RFC 4532 WhoAmI）：返回服务器认可的授权身份。
async function runWhoami(seq: number) {
  if (!getLdapConnectionId()) return;
  whoamiState.value = { running: true };
  try {
    const result = await ldapApi.whoami();
    if (seq !== loadSeq) return;
    whoamiState.value = { running: false, message: t("connections.whoamiOk", { authzId: result?.authzId ?? "" }) };
  } catch (cause) {
    if (seq !== loadSeq) return;
    const raw = cause instanceof Error ? cause.message : String(cause);
    whoamiState.value = { running: false, message: t("connections.whoamiFailed", { error: friendlyLdapError(raw) }), failed: true };
  }
}

// 打开即拉取，关闭重开重新拉取（旧数据不跨次复用）。
watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
  { immediate: true },
);

// -- 值行动作 ----------------------------------------------------------------

// 复制是只读动作：宿主桥缺失或写入失败如实反馈（不假装"已复制"）。
async function copyValue(value: string) {
  emit("notify", (await writeClipboardText(value)) ? t("copied") : t("copyFailed"));
}

// 值行右键菜单（对标 ADS）：行内复制按钮已移除，contextmenu 打开单项菜单。
const valueMenu = ref<{ x: number; y: number; value: string } | null>(null);
const valueMenuEl = ref<HTMLElement>();

function openValueMenu(value: string, event: MouseEvent) {
  valueMenu.value = {
    x: Math.max(4, Math.min(event.clientX, window.innerWidth - 180)),
    y: Math.max(4, Math.min(event.clientY, window.innerHeight - 80)),
    value,
  };
  void nextTick(() => valueMenuEl.value?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true }));
}

function closeValueMenu() {
  valueMenu.value = null;
}

async function copyFromValueMenu() {
  const value = valueMenu.value?.value;
  closeValueMenu();
  if (value !== undefined) await copyValue(value);
}

function onValueMenuKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeValueMenu();
}

// 外点关闭：延后一拍注册防 contextmenu 同帧触发（EntryEditor 同款模式）。
function onDocumentClick() {
  closeValueMenu();
}

onMounted(() => {
  window.setTimeout(() => document.addEventListener("click", onDocumentClick), 0);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
});

// 导出 root-dse.txt：属性名排序后 "name: v1, v2" 行（与 App 旧直导同一文本
// 形态）；saved 反馈照 notifyExportSaved 语义——旧版匿名下载兜底时提示
// "进了浏览器默认下载目录"，其余（宿主/浏览器对话框）报最终文件名。
async function exportRootDse() {
  const lines = Object.keys(attributes.value)
    .sort()
    .map((name) => `${name}: ${(attributes.value[name] ?? []).join(", ")}`);
  try {
    const outcome: SaveTextOutcome = await saveTextFile({ name: "root-dse.txt", contentType: "text/plain", text: lines.join("\n") });
    if (outcome.status === "cancelled") return;
    emit("notify", outcome.via === "legacy" ? t("result.exportDownloaded", { name: outcome.name }) : t("result.exportDone", { name: outcome.name }));
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause);
    emit("error", friendlyLdapError(raw));
  }
}

// Esc 关闭 + Tab 焦点陷阱（useModalA11y 统一接线；数据加载为只读在途，
// 关闭无害，不做 allowClose 否决）。
useModalA11y(
  () => props.open,
  { close: () => emit("close") },
);
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal panel-modal" role="dialog" aria-modal="true" :aria-label="t('rootDse.title')">
      <header>
        <h2>{{ t("rootDse.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X aria-hidden="true" /></button>
      </header>
      <!-- 加载中：现有 .empty 占位 + .spinning 旋转图标（家族同款）。 -->
      <div v-if="loading" class="empty" role="status"><RefreshCw class="spinning" aria-hidden="true" /></div>
      <template v-else>
        <!-- 加载失败：友好文案行内展示，原始串挂 title 供排查（DnTree 同款）。 -->
        <p v-if="loadError" class="form-error" role="alert" :title="loadErrorRaw || loadError">{{ loadError }}</p>
        <!-- 分组属性浏览：语义组顺序固定，空组不渲染。 -->
        <div v-else class="rootdse-body">
          <!-- 连接与服务器：状态 / Ping / TLS / 绑定身份 / 时间线 / 服务器+协议摘要。 -->
          <section>
            <h3>{{ t("rootDse.serverSection") }}</h3>
            <dl class="kv-grid rootdse-conn">
              <dt>{{ t("rootDse.status") }}</dt>
              <dd>
                <template v-if="statusError">
                  <span class="form-error" :title="statusError">{{ statusError }}</span>
                </template>
                <template v-else-if="connectionStatus">
                  <span class="state-dot" :class="stateDotClass(connectionStatus.status)" :title="stateLabel(connectionStatus.status)" />
                  <span>{{ stateLabel(connectionStatus.status) }}</span>
                  <span v-if="connectionStatus.readOnly" class="badge">{{ t("readOnly") }}</span>
                </template>
                <span v-else class="muted">{{ EMPTY_CELL }}</span>
              </dd>
              <dt>{{ t("rootDse.ping") }}</dt>
              <dd>
                <span v-if="checkState.running" class="muted">{{ t("connections.checkRunning") }}</span>
                <span v-else-if="checkState.message" :class="checkState.failed ? 'form-error' : 'muted'">{{ checkState.message }}</span>
                <span v-else class="muted">{{ EMPTY_CELL }}</span>
              </dd>
              <dt>{{ t("rootDse.tls") }}</dt>
              <dd>
                <span class="mono">{{ tlsBadge }}</span>
                <span v-if="tlsVerifyOff" class="muted">({{ t("rootDse.tlsVerifyOff") }})</span>
              </dd>
              <dt>{{ t("rootDse.boundAs") }}</dt>
              <dd>
                <span v-if="whoamiState.running" class="muted">…</span>
                <span v-else-if="whoamiState.message" :class="whoamiState.failed ? 'form-error' : 'muted'">{{ whoamiState.message }}</span>
                <span v-else class="muted">{{ EMPTY_CELL }}</span>
              </dd>
              <dt>{{ t("rootDse.connectedAt") }}</dt>
              <dd><span class="mono">{{ connectedAtText }}</span></dd>
              <dt>{{ t("connections.lastUsed") }}</dt>
              <dd><span class="mono">{{ lastUsedText }}</span></dd>
              <dt>{{ t("rootDse.server") }}</dt>
              <dd><span class="mono">{{ serverSummary }}</span></dd>
              <dt>{{ t("rootDse.protocolVersion") }}</dt>
              <dd><span class="mono">{{ protocolSummary }}</span></dd>
            </dl>
          </section>
          <section v-for="group in groups" :key="group.key">
            <h3>{{ group.title }} <span class="muted">({{ valueCount(group) }})</span></h3>
            <dl class="kv-grid">
              <template v-for="row in group.rows" :key="row.name">
                <dt class="mono">{{ row.name }}</dt>
                <dd>
                  <div
                    v-for="(item, index) in rowItems(row)"
                    :key="`${row.name}:${index}`"
                    class="rootdse-value-item"
                  >
                    <!-- 右键复制（对标 ADS）：行内复制按钮已移除，contextmenu
                         打开复制值菜单；命名上下文行的「设为浏览基」保留。 -->
                    <div class="rootdse-value-row" :title="item.value" @contextmenu.prevent="openValueMenu(item.value, $event)">
                      <span class="rootdse-value">{{ item.value }}</span>
                      <!-- 仅命名上下文值行：一键把该上下文设为浏览基（控制方执行）。 -->
                      <button v-if="row.isNamingContext" type="button" class="toolbar-button" @click="emit('setBase', item.value)">
                        {{ t("rootDse.setBase") }}
                      </button>
                    </div>
                    <!-- OID 命中注册表：附 RFC 标题与描述（phpLDAPadmin 同款）。 -->
                    <div v-if="item.oid" class="rootdse-oid-info">
                      <span class="rootdse-oid-title">{{ item.oid.title }}</span>
                      <span class="rootdse-oid-desc">{{ item.oid.description }}</span>
                    </div>
                  </div>
                </dd>
              </template>
            </dl>
          </section>
        </div>
      </template>
      <footer>
        <button type="button" class="toolbar-button" :disabled="loading || groups.length === 0" @click="exportRootDse">
          <Download aria-hidden="true" /><span>{{ t("rootDse.export") }}</span>
        </button>
        <button type="button" @click="emit('close')">{{ t("close") }}</button>
      </footer>
      <!-- 值行右键菜单：固定定位留在弹窗内，Esc/外点关闭（EntryEditor 同款）。 -->
      <div
        v-if="valueMenu"
        ref="valueMenuEl"
        class="context-menu"
        role="menu"
        tabindex="-1"
        :style="{ left: `${valueMenu.x}px`, top: `${valueMenu.y}px`, width: '160px' }"
        @click.stop
        @contextmenu.prevent
        @keydown="onValueMenuKeydown"
      >
        <button type="button" role="menuitem" :title="t('result.copyValue')" @click="copyFromValueMenu">
          <span class="context-menu-item-label">{{ t("result.copyValue") }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 属性滚动区：panel-modal 固定高度内让分组列表自行滚动（同 SchemaPanel 布局）。 */
.rootdse-body {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
}
/* 多组 dl 并存：值列起点必须跨组对齐，首列用固定宽而非全局 .kv-grid 的
   max-content（后者按组各自撑开，每组值列错位）。200px 覆盖 RootDSE 已知
   最长属性名（domainControllerFunctionality ≈190px@12px mono），更长由
   全局 dt 的 anywhere 断行兜底，不会再压到值列。 */
.kv-grid {
  grid-template-columns: 200px minmax(0, 1fr);
}
.rootdse-body section h3 {
  margin: 0;
  font-size: 12px;
}
/* 值行：全文由行 title 悬停查看，溢出省略；复制/设基按钮贴右不换行。 */
.rootdse-value-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
}
.rootdse-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 同一属性的多值之间留一点呼吸感。 */
.rootdse-value-item + .rootdse-value-item {
  margin-top: 4px;
}
/* OID 说明块：左侧细线引导，标题正常字号、描述缩小弱化。 */
.rootdse-oid-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0 6px;
  padding-left: 8px;
  border-left: 2px solid var(--border);
  min-width: 0;
}
.rootdse-oid-title {
  font-size: 12px;
}
.rootdse-oid-desc {
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
/* 连接与服务器区：dd 内多段（状态点 + 文案 + 徽标）横向排布，可换行。 */
.rootdse-conn dd {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-height: 22px;
}
</style>
