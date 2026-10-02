<script setup lang="ts">
// 批量移动确认框：结果表多选后把所选条目整体移到目标父 DN 下（保留 RDN），
// 对标 ADS 批量操作。移动执行在 App 侧（onBatchMoveConfirm），本组件只负责
// 目标 DN 的输入校验与确认/关闭交互（与 DeleteEntryDialog/ModifyDnDialog 同款骨架）。
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { dnWithinBase, isLikelyDn, splitFirstDnRdn } from "../lib/dn";
import { decideBackdropClose, useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";

const props = defineProps<{
  open: boolean;
  dns: string[];
  submitting?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "confirm", targetParentDn: string): void;
}>();

// 目标父 DN 草稿：每次打开重置——上一次的目标不该悄悄套用到新一批所选条目。
const targetDraft = ref("");
watch(
  () => props.open,
  (open) => {
    if (open) targetDraft.value = "";
  },
  { immediate: true },
);

// 空或非法 DN 都视为无效：行内 aria-invalid + 文案 + 禁用确认，
// 不等服务器报 invalid DN（与 ModifyDnDialog 的 RDN 预检同一动机，此处空值也算错）。
const targetInvalid = computed(() => !isLikelyDn(targetDraft.value.trim()));

// 廉价预检（客户端可判的必败形态）：目标是任一所选条目自身、位于其子树内
// （dnWithinBase 转义感知），或与某条目的当前父 DN 相同（原地移动）。
// 命中即行内提示并禁用确认，不等 N 条请求逐条失败。
const doomedTarget = computed(() => {
  const target = targetDraft.value.trim();
  if (!target || targetInvalid.value) return false;
  const targetLower = target.toLowerCase();
  for (const dn of props.dns) {
    if (dnWithinBase(target, dn) && targetLower !== dn.toLowerCase()) return true;
    if (splitFirstDnRdn(dn).parentDn.toLowerCase() === targetLower) return true;
  }
  return false;
});
const canConfirm = computed(() => !props.submitting && !targetInvalid.value && !doomedTarget.value);

// 确认文案实时取当前输入值：用户能在点确认前看清"移到哪里"。
const confirmCopy = computed(() => t("batchMove.confirm", { count: props.dns.length, dn: targetDraft.value.trim() }));

// 待移动清单：只展示前 20 条（RDN 文本，完整 DN 挂 title 悬停），溢出渲染
// 纯文本 "+N"——数字缩写无翻译需求，不占用 i18n key。
const VISIBLE_LIMIT = 20;
const visibleItems = computed(() =>
  props.dns.slice(0, VISIBLE_LIMIT).map((dn) => ({ dn, label: splitFirstDnRdn(dn).rdn || dn })),
);
const overflowCount = computed(() => Math.max(0, props.dns.length - VISIBLE_LIMIT));

function confirm() {
  const target = targetDraft.value.trim();
  if (props.submitting || !isLikelyDn(target) || doomedTarget.value) return;
  emit("confirm", target);
}

// Esc 关闭 + Tab 焦点陷阱；移动请求在途时否决关闭（防结果不明，同 DeleteEntryDialog）。
// 初始聚焦目标输入框：这是唯一需要用户填写的字段。
useModalA11y(
  () => props.open,
  { close: () => emit("close"), allowClose: () => !props.submitting, initialFocus: ".target-input" },
);

function onBackdropClick() {
  if (decideBackdropClose(!props.submitting).kind !== "close") return;
  emit("close");
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="onBackdropClick">
    <div class="modal small-modal batch-move-modal" role="dialog" aria-modal="true" :aria-label="t('batchMove.title')">
      <header>
        <h2>{{ t("batchMove.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <p class="confirm-copy">{{ confirmCopy }}</p>
      <p v-if="doomedTarget" class="form-error" role="alert">{{ t("batchMove.doomedTarget") }}</p>
      <label class="settings-field">
        <span>{{ t("batchMove.target") }}</span>
        <input
          v-model="targetDraft"
          type="text"
          class="mono target-input"
          spellcheck="false"
          :aria-invalid="targetInvalid"
          :aria-label="t('batchMove.target')"
          @keydown.enter.prevent="confirm"
        />
      </label>
      <p v-if="targetInvalid" class="form-error">{{ t("batchMove.targetInvalid") }}</p>
      <ul class="move-list">
        <li v-for="item in visibleItems" :key="item.dn" :title="item.dn">{{ item.label }}</li>
        <!-- 溢出提示：非文案性数字缩写，不走 i18n（见上方注释）。 -->
        <li v-if="overflowCount > 0" class="move-overflow">… +{{ overflowCount }}</li>
      </ul>
      <footer>
        <button type="button" @click="emit('close')">{{ t("cancel") }}</button>
        <button type="button" class="primary-button" :disabled="!canConfirm" @click="confirm">
          {{ submitting ? "…" : t("confirm") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* .modal 既有布局未覆盖条目清单，这里补 scoped：行 ellipsis + 完整 DN 走 title。 */
.batch-move-modal .confirm-copy {
  margin: 0;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.batch-move-modal .move-list {
  margin: 0;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--background);
  font-size: 11px;
  color: var(--muted-foreground);
  list-style: none;
}
.batch-move-modal .move-list li {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono-font-family);
}
.batch-move-modal .move-overflow {
  color: var(--foreground);
}
</style>
