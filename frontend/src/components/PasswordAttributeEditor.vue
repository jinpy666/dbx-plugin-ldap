<script setup lang="ts">
// 密码属性编辑器（M6 N2）：`userPassword` 专用行组件。scheme 下拉（缺省
// {SSHA}，随机盐）+ 新密码输入（type=password，可切换明文回显）+ 随机生成
// （无歧义字符集）+ 提交时前端哈希（RFC 2307 形态，见 lib/passwordHash）。
// 已有值只展示 scheme 识别结果（哈希不可逆，不回显明文）；随机生成的明文
// 通过 `plainGenerated` 一次性交给父层提示（组件自身不留存、不落日志）。
// 纯前端哈希，值仍走 entry/modify，sidecar 零改动。
// F3：可写且已接线条目 DN 时提供「RFC 3062 扩展操作」模式（默认关闭）——
// 提交改走 ldapApi.entryPasswdModify（服务端选哈希，支持 identity/旧密码）。
import { computed, ref } from "vue";
import { Eye, EyeOff, RefreshCw } from "@lucide/vue";
import {
    PASSWORD_SCHEMES,
    generateRandomPassword,
    hashPassword,
    parsePasswordHash,
    type PasswordScheme,
} from "../lib/passwordHash";
import { ldapApi } from "../lib/api";
import { friendlyLdapError } from "../lib/ldapErrors";
import { t } from "../lib/i18n";

const props = defineProps<{
  /** 当前存储值（可空；哈希或明文均可能）。 */
  modelValue: string;
  disabled?: boolean;
  /** RFC 3062 扩展操作目标条目 DN（F3）：非空且可写时才显示模式切换。 */
  dn?: string;
}>();

const emit = defineEmits<{
  /** 哈希后的最终存储值（RFC 2307 字符串）。 */
  (e: "update:modelValue", value: string): void;
  /** 仅随机生成路径发出：一次性明文，父层负责展示，不得持久化。 */
  (e: "plainGenerated", plain: string): void;
  /** 扩展操作成功通知（父层转发到工作台 notify 通道）。 */
  (e: "notify", message: string): void;
  /** 失败冒泡：扩展操作（经 friendlyLdapError 映射）或本地哈希失败（i18n 文案）。 */
  (e: "error", message: string): void;
}>();

// 占位 key（lib/i18n.ts 由主控合并，见任务收口说明）：t() 对缺失 key 直通
// 返回 key 本身，测试因此不依赖具体语言文案。

const scheme = ref<PasswordScheme>("{SSHA}");
const newPlain = ref("");
const showPlain = ref(false);
const applying = ref(false);
// 最近一次新密码是否来自随机生成：只有该路径才把明文交给父层提示。
const wasGenerated = ref(false);
// 确认新密码（防呆，ADS 同款）：留空跳过校验，非空则必须一致才能应用。
const confirmPlain = ref("");
const confirmMismatch = computed(() => confirmPlain.value !== "" && confirmPlain.value !== newPlain.value);
// 随机生成长度可选（无歧义字符集）。
const generateLength = ref(16);

// 强度粗评（不阻断）：长度 + 字符类别（小写/大写/数字/符号）。
const strength = computed<{ level: "weak" | "fair" | "strong"; label: string } | null>(() => {
  const plain = newPlain.value;
  if (!plain) return null;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(plain)).length;
  if (plain.length >= 12 && classes >= 3) return { level: "strong", label: t("ldap.passwordEditor.strengthStrong") };
  if (plain.length >= 8 && classes >= 2) return { level: "fair", label: t("ldap.passwordEditor.strengthFair") };
  return { level: "weak", label: t("ldap.passwordEditor.strengthWeak") };
});

// RFC 3062 扩展操作（F3）：默认关闭（沿用本地哈希 + entry/modify 路径）；
// identity / 旧密码为可选字段，留空不随请求发送。
const useExtended = ref(false);
const identityDraft = ref("");
const oldPlain = ref("");

// 扩展是写路径：仅可写（未禁用）且已接线条目 DN 时显示切换（只读态、
// 新增态等无 DN 场景一律隐藏）。开启后才出现两个可选字段。
const extendedAvailable = computed(() => Boolean(props.dn) && !props.disabled);
const extendedActive = computed(() => extendedAvailable.value && useExtended.value);

const inputType = computed(() => (showPlain.value ? "text" : "password"));
const canApply = computed(() => !props.disabled && !applying.value && newPlain.value !== "" && !confirmMismatch.value);

// 已有值识别：空值不提示；不认识的 scheme 前缀（{MD5}/{CRYPT}…）明确告警
// 而非静默当作明文。data-scheme 供测试与父层嗅探，不含任何值内容。
const existing = computed(() => parsePasswordHash(props.modelValue));
const existingNote = computed(() => {
  if (!props.modelValue.trim()) return "";
  if (!existing.value) return t("ldap.passwordEditor.existingUnknown");
  return existing.value.scheme === "{CLEARTEXT}" ? t("ldap.passwordEditor.cleartextWarning") : "";
});

// 随机生成：按所选长度填入输入框并切换明文回显，让管理员确认一次性明文后再提交。
const generate = () => {
  if (props.disabled) return;
  newPlain.value = generateRandomPassword(generateLength.value);
  showPlain.value = true;
  wasGenerated.value = true;
};

const toggleShow = () => {
  showPlain.value = !showPlain.value;
};

// 提交：扩展模式走 RFC 3062 passwdModify；默认模式本地哈希后回写存储值。
// 输入即清空，明文不留在组件状态里。
const apply = async () => {
  if (!canApply.value) return;
  if (extendedActive.value) {
    await applyExtended();
    return;
  }
  await applyHashed();
};

// 默认路径：本地哈希（RFC 2307 形态）后回写存储值，仍由父层走 entry/modify。
// 成功即清空输入，明文不留在组件状态里；失败保留输入（error 冒泡）便于重试。
async function applyHashed() {
  const plain = newPlain.value;
  applying.value = true;
  try {
    const hashed = await hashPassword(plain, scheme.value);
    emit("update:modelValue", hashed);
    if (wasGenerated.value) emit("plainGenerated", plain);
    newPlain.value = "";
    confirmPlain.value = "";
    showPlain.value = false;
    wasGenerated.value = false;
  } catch {
    // 非安全上下文已由 lib/sha 兜底,正常不会失败;一旦命中异常宿主环境,
    // 以 error 冒泡本地化文案,不再把原始异常裸抛成未处理 rejection。
    emit("error", t("ldap.passwordEditor.hashFailed"));
  } finally {
    applying.value = false;
  }
}

// RFC 3062 提交：identity/oldPassword 留空则不出现在参数里（api 层对空值
// 同样省略，这里在调用侧收紧参数形状，保证「缺省不传」可被测试与审计直接
// 观察）。成功 → notify(extendedDone) 并按「已应用」流程清空输入；密码由
// 服务端写入，表单存储值不动（不发 update:modelValue，避免伪造本地哈希）。
// 失败 → error 冒泡（结果码经 friendlyLdapError 映射），输入保留便于重试。
// 扩展路径不发一次性明文通知：密码已直接交付服务器，无待写入的表单值。
async function applyExtended() {
  const dn = props.dn;
  if (!dn) return;
  applying.value = true;
  try {
    const options: { identity?: string; oldPassword?: string; newPassword: string } = { newPassword: newPlain.value };
    if (identityDraft.value.trim() !== "") options.identity = identityDraft.value.trim();
    if (oldPlain.value !== "") options.oldPassword = oldPlain.value;
    const result = await ldapApi.entryPasswdModify(dn, options);
    if (!result?.success) {
      emit("error", t("ldap.passwordEditor.extendedFailed"));
      return;
    }
    emit("notify", t("ldap.passwordEditor.extendedDone"));
    identityDraft.value = "";
    oldPlain.value = "";
    newPlain.value = "";
    confirmPlain.value = "";
    showPlain.value = false;
    wasGenerated.value = false;
  } catch (cause) {
    emit("error", friendlyLdapError(cause instanceof Error ? cause.message : String(cause)));
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <div class="password-editor" :data-scheme="existing?.scheme ?? ''">
    <!-- 哈希方案仅作用于本地哈希路径：扩展操作（RFC 3062）的哈希由服务器
         决定，隐藏下拉以免误导（重新切回默认模式即恢复）。 -->
    <label v-if="!extendedActive" class="field">
      <span class="muted">{{ t("ldap.passwordEditor.scheme") }}</span>
      <select v-model="scheme" :disabled="disabled">
        <option v-for="option in PASSWORD_SCHEMES" :key="option" :value="option">{{ option }}</option>
      </select>
    </label>
    <label class="field">
      <span class="muted">{{ t("ldap.passwordEditor.fieldLabel") }}</span>
      <span class="password-input-row">
        <input
          v-model="newPlain"
          :type="inputType"
          autocomplete="new-password"
          spellcheck="false"
          :disabled="disabled"
          @keyup.enter="apply"
        />
        <button
          type="button"
          class="icon-button"
          :title="showPlain ? t('ldap.passwordEditor.hide') : t('ldap.passwordEditor.show')"
          :aria-label="showPlain ? t('ldap.passwordEditor.hide') : t('ldap.passwordEditor.show')"
          :disabled="disabled || !newPlain"
          @click="toggleShow"
        >
          <EyeOff v-if="showPlain" aria-hidden="true" /><Eye v-else aria-hidden="true" />
        </button>
      </span>
      <span v-if="strength" class="password-strength" :class="`password-strength--${strength.level}`">{{ strength.label }}</span>
    </label>
    <label class="field">
      <span class="muted">{{ t("ldap.passwordEditor.confirmLabel") }}</span>
      <input
        v-model="confirmPlain"
        type="password"
        class="password-confirm-input"
        autocomplete="new-password"
        spellcheck="false"
        :disabled="disabled"
        @keyup.enter="apply"
      />
      <span v-if="confirmMismatch" class="form-error password-confirm-error" role="alert">{{ t("ldap.passwordEditor.confirmMismatch") }}</span>
    </label>
    <!-- RFC 3062 扩展操作切换（F3）：写路径，仅可写且已接线 DN 时出现；
         默认关闭，开启后追加目标身份 / 旧密码两个可选字段。 -->
    <label v-if="extendedAvailable" class="field password-extended-toggle">
      <input v-model="useExtended" type="checkbox" />
      <span class="muted">{{ t("ldap.passwordEditor.useExtended") }}</span>
    </label>
    <div v-if="extendedActive" class="password-extended-fields">
      <label class="field">
        <span class="muted">{{ t("ldap.passwordEditor.identity") }}</span>
        <!-- 占位直接展示当前条目 DN：留空即默认以 DN 为目标身份（后端行为）。 -->
        <input v-model="identityDraft" type="text" :placeholder="dn" spellcheck="false" :disabled="disabled" />
      </label>
      <label class="field">
        <span class="muted">{{ t("ldap.passwordEditor.oldPassword") }}</span>
        <input v-model="oldPlain" type="password" autocomplete="current-password" spellcheck="false" :disabled="disabled" />
      </label>
    </div>
    <span class="password-actions">
      <label class="password-length-field">
        <span class="muted">{{ t("ldap.passwordEditor.generateLength") }}</span>
        <select v-model="generateLength" class="password-length" :disabled="disabled">
          <option :value="12">12</option>
          <option :value="16">16</option>
          <option :value="20">20</option>
        </select>
      </label>
      <button type="button" :disabled="disabled" @click="generate">
        <RefreshCw aria-hidden="true" />{{ t("ldap.passwordEditor.generate") }}
      </button>
      <button type="button" class="primary-button" :disabled="!canApply" @click="apply">
        {{ applying ? "…" : (extendedActive ? t("ldap.passwordEditor.applyExtended") : t("ldap.passwordEditor.apply")) }}
      </button>
    </span>
    <p v-if="modelValue && existing && !existingNote" class="hint">
      {{ t("ldap.passwordEditor.existing") }}<span class="mono">{{ existing.scheme }}</span>
    </p>
    <p v-if="existingNote" class="form-error">{{ existingNote }}</p>
  </div>
</template>

<style scoped>
/* 对话框级布局（值编辑器弹窗内）：字段全宽、纵向节奏统一——此前按内联行
   设计，进弹窗后挤成一小列且输入框宽窄不一。 */
.password-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}
.password-editor .field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.password-editor input[type="text"],
.password-editor input[type="password"],
.password-editor select {
  width: 100%;
  box-sizing: border-box;
}
/* 复选框（RFC 3062 切换）不吃全宽规则：否则拉满整行、把说明文字挤开。 */
.password-editor input[type="checkbox"] {
  width: auto;
  margin: 0;
}
/* 明文切换按钮收进输入框右侧，替代悬空在外的独立图标。 */
.password-input-row {
  position: relative;
  display: block;
}
.password-input-row input {
  padding-right: 32px;
}
.password-input-row .icon-button {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
}
/* 强度粗评（不阻断）：弱=琥珀（与值类型警告同约定），强=主题色。 */
.password-strength {
  font-size: 11px;
}
.password-strength--weak {
  color: #d97706;
}
.password-strength--fair {
  color: var(--muted-foreground);
}
.password-strength--strong {
  color: var(--primary);
}
/* RFC 3062 扩展操作切换行（F3）：横向 checkbox + 说明文字，区别于
   .field 默认的纵向「标签在上、控件在下」。 */
.password-extended-toggle {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
/* 扩展字段组：保持与上方字段的纵向节奏一致。 */
.password-extended-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 操作行：生成长度选择 + 随机生成 + 主按钮（按模式显示文案）。
   随机生成与其他次要按钮同款边框样式，避免裸文字观感。 */
.password-actions {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.password-length-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.password-length {
  width: auto;
  min-width: 72px;
}
.password-actions button:not(.primary-button) {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 11px;
  background: var(--background);
  color: var(--foreground);
  cursor: pointer;
}
.password-actions button:not(.primary-button):hover:not(:disabled) {
  background: var(--accent);
}
</style>
