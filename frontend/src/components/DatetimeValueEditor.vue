<script setup lang="ts">
// DatetimeValueEditor：时间值编辑器（ValueEditorDialog 内嵌使用）。
// - kind=datetime：RFC 4517 GeneralizedTime（createTimestamp/whenCreated 等）；
// - kind=filetime：AD FILETIME（pwdLastSet/accountExpires 等，1601 纪元 100ns）。
// 控件形态：原始值 + 原生日历选日期（type=date）+ 时/分/秒数字输入 + 时区
// 选择器（仅 datetime）。不用 datetime-local：WebKit 弹窗只有日历、时分秒
// 段无法编辑。墙上时钟语义：控件显示原值自身字段（所见即存储，不做时区
// 换算），写回 = 墙上时钟 + 时区后缀（filetime 为绝对 tick，无时区语义）。
// 哨兵值（0 / INT64_MAX）下控件保持为空，存储始终写回原始格式。
// 单值编辑：多值行由 dialog 降级回 textarea，不进本组件。
import { computed } from "vue";
import {
  formatGeneralizedTimeWall,
  isGeneralizedTimeShape,
  localTimeZoneSuffix,
  parseGeneralizedTimeWall,
} from "../lib/generalizedTime";
import {
  filetimeSentinelLabel,
  filetimeToDate,
  isFiletimeShape,
  dateToFiletime,
} from "../lib/filetime";
import { t } from "../lib/i18n";

const props = defineProps<{
  modelValue: string;
  kind: "datetime" | "filetime";
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const isFiletime = computed(() => props.kind === "filetime");

// 哨兵值仅用于控件判空（0 / INT64_MAX 不是真实时间点，不渲染成日期）。
const sentinelLabel = computed(() =>
  isFiletime.value ? filetimeSentinelLabel(props.modelValue, { notSet: t("ldap.valueEditors.notSet"), never: t("ldap.valueEditors.never") }) : null,
);

const invalid = computed(() => {
  if (props.modelValue.trim() === "") return false;
  return isFiletime.value ? !isFiletimeShape(props.modelValue) : !isGeneralizedTimeShape(props.modelValue);
});

interface WallFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// 墙上时钟字段：datetime 取原值自身字段；filetime 取 tick 的本地墙上呈现。
const fields = computed<WallFields | null>(() => {
  if (isFiletime.value) {
    if (sentinelLabel.value) return null;
    const date = filetimeToDate(props.modelValue);
    if (!date) return null;
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }
  const wall = parseGeneralizedTimeWall(props.modelValue);
  if (!wall) return null;
  return { year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: wall.second };
});

const pad2 = (n: number) => String(n).padStart(2, "0");

const dateValue = computed(() => (fields.value ? `${fields.value.year}-${pad2(fields.value.month)}-${pad2(fields.value.day)}` : ""));

const fieldValue = (name: "hour" | "minute" | "second") => (fields.value ? String(fields.value[name]) : "");

// 时区后缀：默认跟随原值（无合法值时按协议回落 UTC）。
const zone = computed(() => (isFiletime.value ? "" : parseGeneralizedTimeWall(props.modelValue)?.zone ?? "Z"));

function zoneLabel(zone: string): string {
  if (zone === "") return t("ldap.valueEditors.zoneNoSuffix");
  if (zone === "Z") return "UTC";
  return `UTC${zone[0]}${zone.slice(1, 3)}:${zone.slice(3, 5)}`;
}

// 时区选项：原值后缀优先（含无后缀容错项），再补 UTC 与本地时区，去重。
const zoneOptions = computed<Array<{ value: string; label: string }>>(() => {
  const options: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      options.push({ value, label: zoneLabel(value) });
    }
  };
  if (!isFiletime.value && fields.value) push(parseGeneralizedTimeWall(props.modelValue)?.zone ?? "Z");
  push("Z");
  push(localTimeZoneSuffix());
  return options;
});

// 写回 = 墙上时钟 + 当前时区后缀；filetime 走本地 Date → 1601 纪元 tick。
function emitFields(next: WallFields) {
  emit(
    "update:modelValue",
    isFiletime.value
      ? dateToFiletime(new Date(next.year, next.month - 1, next.day, next.hour, next.minute, next.second))
      : formatGeneralizedTimeWall({ ...next, zone: zone.value }),
  );
}

const DATE_VALUE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function onDateInput(event: Event) {
  const match = DATE_VALUE_RE.exec((event.target as HTMLInputElement).value);
  if (!match) return; // 清空日期不清空原始值（显式删除走原始值框）
  const base = fields.value ?? { hour: 0, minute: 0, second: 0 };
  // base 在前：仅取其时分秒，日期字段必须以选择器的新值为准。
  emitFields({ ...base, year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
}

function onTimeInput(name: "hour" | "minute" | "second", max: number, event: Event) {
  const text = (event.target as HTMLInputElement).value;
  const value = Number(text);
  // 越界/非整数/清空一律不落地（原始值保持不变，显式修改走原始值框）。
  if (text.trim() === "" || !Number.isInteger(value) || value < 0 || value > max) return;
  const base = fields.value;
  if (!base) return; // 日期未定时时分秒无处落地（先选日期）
  emitFields({ ...base, [name]: value });
}

function onZoneInput(event: Event) {
  const wall = parseGeneralizedTimeWall(props.modelValue);
  if (!wall) return; // 原始值非法/为空时无从改写后缀（选择器已禁用）
  const next = (event.target as HTMLSelectElement).value;
  emit("update:modelValue", formatGeneralizedTimeWall({ ...wall, zone: next }));
}
</script>

<template>
  <div class="datetime-editor" :class="{ 'is-invalid': invalid }">
    <div class="datetime-controls">
      <div class="datetime-control">
        <span class="datetime-control-label">{{ t("ldap.valueEditors.rawValue") }}</span>
        <input
          class="mono datetime-raw"
          type="text"
          :value="modelValue"
          :disabled="disabled"
          :aria-label="t('ldap.valueEditors.rawValue')"
          :placeholder="isFiletime ? '132223104000000000' : '20260102030405Z'"
          spellcheck="false"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="datetime-control">
        <span class="datetime-control-label">{{ t("ldap.valueEditors.pickDate") }}</span>
        <input
          class="datetime-date"
          type="date"
          :value="dateValue"
          :disabled="disabled"
          :aria-label="t('ldap.valueEditors.pickDate')"
          @input="onDateInput"
        />
      </div>
      <div class="datetime-control">
        <span class="datetime-control-label">{{ t("ldap.valueEditors.pickTime") }}</span>
        <div class="datetime-time-fields">
          <input class="datetime-hour" type="number" min="0" max="23" :value="fieldValue('hour')" :disabled="disabled" :aria-label="t('ldap.valueEditors.hour')" @input="onTimeInput('hour', 23, $event)" />
          <span class="datetime-time-sep" aria-hidden="true">:</span>
          <input class="datetime-minute" type="number" min="0" max="59" :value="fieldValue('minute')" :disabled="disabled" :aria-label="t('ldap.valueEditors.minute')" @input="onTimeInput('minute', 59, $event)" />
          <span class="datetime-time-sep" aria-hidden="true">:</span>
          <input class="datetime-second" type="number" min="0" max="59" :value="fieldValue('second')" :disabled="disabled" :aria-label="t('ldap.valueEditors.second')" @input="onTimeInput('second', 59, $event)" />
        </div>
      </div>
      <!-- 时区选择器（仅 datetime）：默认跟随原值后缀；切换即以新后缀重写
           墙上时钟。FILETIME 是绝对 tick，无时区语义。 -->
      <div v-if="!isFiletime" class="datetime-control">
        <span class="datetime-control-label">{{ t("ldap.valueEditors.zone") }}</span>
        <select
          class="datetime-zone"
          :value="zone"
          :disabled="disabled || !fields"
          :aria-label="t('ldap.valueEditors.zone')"
          @change="onZoneInput"
        >
          <option v-for="option in zoneOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
    </div>
    <p v-if="invalid" class="form-error">{{ isFiletime ? t("ldap.valueEditors.integerInvalid") : t("ldap.valueEditors.notDatetime") }}</p>
  </div>
</template>

<style scoped>
.datetime-editor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.datetime-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: flex-end;
}
.datetime-control {
  display: flex;
  min-width: 0;
  flex: 1 1 150px;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
}
.datetime-control-label {
  color: var(--muted-foreground);
  font-size: 9px;
}
.datetime-raw {
  min-width: 140px;
}
.is-invalid .datetime-raw {
  border-color: var(--danger, #c0392b);
}
.datetime-time-fields {
  display: flex;
  align-items: center;
  gap: 2px;
}
.datetime-time-fields input {
  min-width: 0;
  width: 52px;
  text-align: center;
}
.datetime-time-sep {
  color: var(--muted-foreground);
}
</style>
