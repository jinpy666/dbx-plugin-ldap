<script setup lang="ts">
// UacValueEditor（阶段5）：Active Directory userAccountControl 位掩码编辑器。
// 对齐 ADS 缺失的 AD 深度适配（其仅显示原始值）：已知位以复选框呈现（AD
// 惯用英文标志名，不做翻译），未知位以残余值显示；任意勾选即时合成十进制
// 原始串回写。PASSWD_CANT_CHANGE（0x40）实际由 ACL 控制、直接写 uac 不生效
// ——显示但勾选时提示。单值编辑：多值行由 dialog 降级回 textarea。
import { computed } from "vue";
import { t } from "../lib/i18n";

interface UacFlag {
  name: string;
  bit: number;
  /** 写入无效/不推荐直接改的位。 */
  writeHint?: boolean;
}

// Microsoft ADSI/AD 用户账号属性文档的标准标志集
const UAC_FLAGS: UacFlag[] = [
  { name: "ACCOUNTDISABLE", bit: 0x0002 },
  { name: "LOCKOUT", bit: 0x0010 },
  { name: "PASSWD_NOTREQD", bit: 0x0020 },
  { name: "PASSWD_CANT_CHANGE", bit: 0x0040, writeHint: true },
  { name: "ENCRYPTED_TEXT_PWD_ALLOWED", bit: 0x0080 },
  { name: "TEMP_DUPLICATE_ACCOUNT", bit: 0x0100 },
  { name: "NORMAL_ACCOUNT", bit: 0x0200 },
  { name: "INTERDOMAIN_TRUST_ACCOUNT", bit: 0x0800 },
  { name: "WORKSTATION_TRUST_ACCOUNT", bit: 0x1000 },
  { name: "SERVER_TRUST_ACCOUNT", bit: 0x2000 },
  { name: "DONT_EXPIRE_PASSWORD", bit: 0x10000 },
  { name: "MNS_LOGON_ACCOUNT", bit: 0x20000 },
  { name: "SMARTCARD_REQUIRED", bit: 0x40000 },
  { name: "TRUSTED_FOR_DELEGATION", bit: 0x80000 },
  { name: "NOT_DELEGATED", bit: 0x100000 },
  { name: "USE_DES_KEY_ONLY", bit: 0x200000 },
  { name: "DONT_REQ_PREAUTH", bit: 0x400000 },
  { name: "PASSWORD_EXPIRED", bit: 0x800000 },
  { name: "TRUSTED_TO_AUTH_FOR_DELEGATION", bit: 0x1000000 },
  { name: "PARTIAL_SECRETS_ACCOUNT", bit: 0x4000000 },
];

const props = defineProps<{
  modelValue: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const rawValue = computed<number | null>(() => {
  const text = String(props.modelValue ?? "").trim();
  if (!/^\d+$/u.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
});

const checkedBits = computed<Set<number>>(() => {
  const set = new Set<number>();
  const value = rawValue.value;
  if (value == null) return set;
  for (const flag of UAC_FLAGS) {
    if ((value & flag.bit) === flag.bit) set.add(flag.bit);
  }
  return set;
});

// 已知位之外无法归类的残余位（保真显示，避免"合法数字被改写"）
const unknownRemainder = computed<number>(() => {
  const value = rawValue.value;
  if (value == null) return 0;
  let remainder = value;
  for (const flag of UAC_FLAGS) {
    if ((remainder & flag.bit) === flag.bit) remainder -= flag.bit;
  }
  return remainder;
});

const writeHintVisible = computed(() => checkedBits.value.has(0x0040));

// 原始值非法（非整数）时禁用勾选：避免从无效值静默重置为 512 起步合成。
const flagsDisabled = computed(() => Boolean(props.disabled) || (rawValue.value == null && props.modelValue.trim() !== ""));

function toggle(flag: UacFlag, checked: boolean) {
  if (flagsDisabled.value) return;
  const base = rawValue.value ?? 0x200; // 空值从 NORMAL_ACCOUNT 起步
  const next = checked ? base | flag.bit : base & ~flag.bit;
  emit("update:modelValue", String(next));
}
</script>

<template>
  <div class="uac-editor">
    <div class="uac-flags">
      <label v-for="flag in UAC_FLAGS" :key="flag.name" class="uac-flag" :title="`0x${flag.bit.toString(16)}`">
        <input
          type="checkbox"
          :checked="checkedBits.has(flag.bit)"
          :disabled="flagsDisabled"
          @change="toggle(flag, ($event.target as HTMLInputElement).checked)"
        />
        <span class="mono">{{ flag.name }}</span>
      </label>
    </div>
    <p class="uac-raw mono">{{ modelValue }}<template v-if="unknownRemainder !== 0"> (+0x{{ unknownRemainder.toString(16) }})</template></p>
    <p v-if="rawValue == null && modelValue.trim() !== ''" class="form-error">{{ t("ldap.valueEditors.uacInvalid") }}</p>
    <p v-if="writeHintVisible" class="hint">{{ t("ldap.valueEditors.uacPasswdCantChangeHint") }}</p>
  </div>
</template>

<style scoped>
.uac-editor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.uac-flags {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 2px 10px;
}
.uac-flag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
}
.uac-raw {
  margin: 0;
  font-size: 11px;
  color: var(--muted-foreground);
}
</style>
