<script setup lang="ts">
// 删除条目确认框（破坏性操作红样式，文案走七语）。
// M6 N1：打开时 best-effort 拉取子条目数（ldap/entry/childrenCount），
// 有子条目时提供「递归删除」勾选；旧 sidecar / 无桥环境拿不到计数时
// 静默降级为单条删除语义（与既有行为一致）。
import { computed, ref, watch } from "vue";
import { TriangleAlert, X } from "@lucide/vue";
import { splitFirstDnRdn } from "../lib/dn";
import { ldapApi } from "../lib/api";
import { decideBackdropClose, useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";

const props = defineProps<{
  open: boolean;
  dn?: string;
  submitting?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "confirm", options: { recursive: boolean }): void;
}>();

const label = computed(() => {
  if (!props.dn) return "";
  return splitFirstDnRdn(props.dn).rdn || props.dn;
});

// 子条目计数：仅用于展示与递归勾选，拿不到（方法未注册/无桥）即隐藏勾选，
// 不阻塞确认框打开。计数在途时暂禁确认（审查 D-L9）：childCount 尚为
// undefined 时确认会按单条删除语义提交，大目录上「有子条目」的条目必然
// notAllowedOnNonLeaf 失败——递归选项还没加载出来。
const childCount = ref<number>();
const childCountPending = ref(false);
const recursive = ref(false);
let childCountSeq = 0;
watch(
  () => [props.open, props.dn] as const,
  ([open]) => {
    recursive.value = false;
    childCount.value = undefined;
    childCountPending.value = open === true && props.dn !== undefined;
    const seq = ++childCountSeq;
    if (!open || !props.dn) return;
    ldapApi
      .childrenCount(props.dn)
      .then((result) => {
        // 打开态下 dn 变更时，旧 DN 的晚到响应不再污染新 DN 的计数展示
        // （最坏情形会把「有子条目」显示成「无」→ 递归勾选被隐藏）。
        if (seq !== childCountSeq) return;
        childCount.value = result.count;
        childCountPending.value = false;
      })
      .catch(() => {
        if (seq !== childCountSeq) return;
        childCount.value = undefined;
        // 拿不到计数（旧 sidecar/无桥）：保持既有静默降级，确认恢复可用。
        childCountPending.value = false;
      });
  },
  { immediate: true },
);

function onConfirm() {
  if (childCountPending.value) return;
  emit("confirm", { recursive: recursive.value && (childCount.value ?? 0) > 0 });
}

// Esc 关闭 + Tab 焦点陷阱；删除请求在途时否决关闭（防结果不明）。
// 初始聚焦"取消"而非标题栏 ✕（UI 扫描 P2-11）：破坏性确认框的键盘路径
// 不应先经过关闭图标；遮罩点击与 Esc 共用同一条 allowClose 守卫。
useModalA11y(
  () => props.open,
  { close: () => emit("close"), allowClose: () => !props.submitting, initialFocus: "footer button" },
);

function onBackdropClick() {
  if (decideBackdropClose(!props.submitting).kind !== "close") return;
  emit("close");
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="onBackdropClick">
    <div class="modal small-modal" role="dialog" aria-modal="true" :aria-label="t('deleteDialog.title')">
      <header>
        <h2>{{ t("deleteDialog.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <div class="destructive-copy">
        <div class="destructive-icon"><TriangleAlert aria-hidden="true" /></div>
        <div>
          <strong class="mono">{{ label }}</strong>
          <p>{{ t("deleteDialog.message") }}</p>
          <p class="entry-dn">{{ dn }}</p>
          <p v-if="childCount !== undefined && childCount > 0" class="hint">
            {{ t("tree.childCount", { count: childCount }) }}
          </p>
          <label v-if="childCount !== undefined && childCount > 0" class="recursive-row">
            <input v-model="recursive" type="checkbox" :disabled="submitting" />
            <span>{{ t("deleteDialog.recursive") }}</span>
          </label>
        </div>
      </div>
      <footer>
        <button type="button" @click="emit('close')">{{ t("cancel") }}</button>
        <button
          type="button"
          class="danger-button"
          :disabled="submitting || childCountPending"
          :title="childCountPending ? t('deleteDialog.countingChildren') : undefined"
          @click="onConfirm"
        >
          {{ submitting ? "…" : t("delete") }}
        </button>
      </footer>
    </div>
  </div>
</template>
