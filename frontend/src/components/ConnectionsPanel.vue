<script setup lang="ts">
// 连接状态面板：ldap/connections/statuses（多连接 status/lastError/lastUsedAt）
// + 每行 ldap/check 连接体检（network/bind 两段，行间互不阻塞）。
import { ref, watch } from "vue";
import { Activity, Fingerprint, Loader2, Network, RefreshCw, X } from "@lucide/vue";
import { getLdapConnectionId, ldapApi, type LdapConnectionStatus } from "../lib/api";
import { describeLdapCheckResult } from "../lib/ldapCheck";
import { friendlyLdapError } from "../lib/ldapErrors";
import { useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";

const props = defineProps<{
  open: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "error", message: string): void;
}>();

const statuses = ref<LdapConnectionStatus[]>([]);
const loading = ref(false);

// 每行独立的连接检查状态：running=检查中（按钮禁用，行间互不阻塞）；
// message/failed=最近一次结果（再次点击重查会整体覆盖）。
interface CheckRowState {
  running: boolean;
  message?: string;
  /** true → 错误色（form-error），否则 muted。 */
  failed?: boolean;
}

const IDLE_CHECK: CheckRowState = Object.freeze({ running: false });
const checkStates = ref<Record<string, CheckRowState>>({});

// 只读访问：未检查过的行走共享的空闲态（避免在渲染期写入状态）。
function checkStateOf(connectionId: string): CheckRowState {
  return checkStates.value[connectionId] ?? IDLE_CHECK;
}

async function runCheck(connectionId: string) {
  if (checkStateOf(connectionId).running) return;
  checkStates.value[connectionId] = { running: true };
  try {
    // 默认不传 level = network+bind 两段都查；结果归一在 lib/ldapCheck 纯函数。
    const result = await ldapApi.check(connectionId);
    const described = describeLdapCheckResult(result);
    checkStates.value[connectionId] = { running: false, message: described.message, failed: described.failed };
  } catch (cause) {
    // 后端未合入 / 连接未知等业务错误 → 行内展示失败文案，不影响其他行。
    checkStates.value[connectionId] = {
      running: false,
      message: t("connections.checkFail", { error: cause instanceof Error ? cause.message : String(cause) }),
      failed: true,
    };
  }
}

// -- 身份查询（F3 WhoAmI）-----------------------------------------------------
// 每行独立的 whoami 状态：ldapApi.whoami() 不带 connectionId 参数、语义跟随
// 全局当前连接，因此仅当前连接的行可点；进行中禁用，结果行内展示。

interface WhoamiRowState {
  running: boolean;
  message?: string;
  /** true → 错误色（form-error），否则 muted。 */
  failed?: boolean;
}

const IDLE_WHOAMI: WhoamiRowState = Object.freeze({ running: false });
const whoamiStates = ref<Record<string, WhoamiRowState>>({});

// 只读访问：未查过的行走共享的空闲态（避免在渲染期写入状态）。
function whoamiStateOf(connectionId: string): WhoamiRowState {
  return whoamiStates.value[connectionId] ?? IDLE_WHOAMI;
}

function isCurrentConnection(connectionId: string): boolean {
  return connectionId === getLdapConnectionId();
}

async function runWhoami(connectionId: string) {
  if (whoamiStateOf(connectionId).running || !isCurrentConnection(connectionId)) return;
  whoamiStates.value[connectionId] = { running: true };
  try {
    const result = await ldapApi.whoami();
    whoamiStates.value[connectionId] = { running: false, message: t("connections.whoamiOk", { authzId: result?.authzId ?? "" }) };
  } catch (cause) {
    // 错误文案过 friendlyLdapError 映射（与树/检查的提示口径一致）。
    const raw = cause instanceof Error ? cause.message : String(cause);
    whoamiStates.value[connectionId] = { running: false, message: t("connections.whoamiFailed", { error: friendlyLdapError(raw) }), failed: true };
  }
}

async function load() {
  if (props.disabled || loading.value) return;
  loading.value = true;
  try {
    const result = await ldapApi.connectionStatuses();
    statuses.value = Array.isArray(result.statuses) ? result.statuses : [];
  } catch (cause) {
    emit("error", cause instanceof Error ? cause.message : String(cause));
  } finally {
    loading.value = false;
  }
}

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

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
  { immediate: true },
);

// Esc 关闭 + Tab 焦点陷阱（useModalA11y 统一接线）。
useModalA11y(
  () => props.open,
  { close: () => emit("close") },
);
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal small-modal" role="dialog" aria-modal="true" :aria-label="t('connections.title')">
      <header>
        <h2><Network aria-hidden="true" style="width: 14px; height: 14px" /> {{ t("connections.title") }}</h2>
        <span class="actions" style="display: flex; gap: 2px">
          <button class="icon-button" :title="t('refresh')" @click="load"><RefreshCw :class="{ spinning: loading }" /></button>
          <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
        </span>
      </header>
      <ul v-if="statuses.length > 0" class="settings-list">
        <li v-for="status in statuses" :key="status.connectionId">
          <span class="state-dot" :class="stateDotClass(status.status)" :title="stateLabel(status.status)" />
          <div class="settings-list-main">
            <strong class="mono">{{ status.connectionId }}</strong>
            <span v-if="status.lastUsedAt">{{ t("connections.lastUsed") }}: {{ formatTime(status.lastUsedAt) }}</span>
            <span v-if="status.lastError" class="form-error">{{ t("connections.lastError") }}: {{ status.lastError }}</span>
            <!-- 检查态/最近一次检查结果：检查中 muted，失败走 form-error，成功 muted。 -->
            <span v-if="checkStateOf(status.connectionId).running" class="muted">{{ t("connections.checkRunning") }}</span>
            <span
              v-else-if="checkStateOf(status.connectionId).message"
              :class="checkStateOf(status.connectionId).failed ? 'form-error' : 'muted'"
            >{{ checkStateOf(status.connectionId).message }}</span>
            <!-- 身份查询结果（F3）：与检查结果各自独立、互不覆盖。 -->
            <span
              v-if="whoamiStateOf(status.connectionId).message"
              :class="whoamiStateOf(status.connectionId).failed ? 'form-error' : 'muted'"
            >{{ whoamiStateOf(status.connectionId).message }}</span>
          </div>
          <span class="muted">{{ stateLabel(status.status) }}</span>
          <span style="display: flex; gap: 2px">
            <button
              type="button"
              class="icon-button check-button"
              style="flex: 0 0 24px"
              :title="t('connections.check')"
              :aria-label="t('connections.check')"
              :disabled="checkStateOf(status.connectionId).running"
              @click="runCheck(status.connectionId)"
            >
              <RefreshCw v-if="checkStateOf(status.connectionId).running" class="spinning" />
              <Activity v-else />
            </button>
            <!-- 仅当前连接可点（whoami 走全局当前连接语义）；进行中禁用。 -->
            <button
              type="button"
              class="icon-button whoami-button"
              style="flex: 0 0 24px"
              :title="t('connections.whoami')"
              :aria-label="t('connections.whoami')"
              :disabled="whoamiStateOf(status.connectionId).running || !isCurrentConnection(status.connectionId)"
              @click="runWhoami(status.connectionId)"
            >
              <Loader2 v-if="whoamiStateOf(status.connectionId).running" class="spinning" />
              <Fingerprint v-else />
            </button>
          </span>
        </li>
      </ul>
      <p v-else class="empty compact">{{ t("connections.empty") }}</p>
      <footer>
        <button type="button" @click="emit('close')">{{ t("close") }}</button>
      </footer>
    </div>
  </div>
</template>
