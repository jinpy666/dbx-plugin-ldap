<script setup lang="ts">
// DnPickerDialog：DN 值的「从目录树选择」弹窗（层级选择）。
// 自包含实现：以传入 baseDn 为根，懒展开加载直接子条目（ldap/search
// scope=one），点击行即回填选中 DN；不依赖 DnTree 的工作台状态（右键菜单/
// 虚拟滚动等重能力），保持选择器轻量。单次读取上限与 DnTree 的
// TREE_FETCH_PAGE 对齐（500）；命中截断时显示徽标（真实 sidecar 与 mock 均
// 返回截断条目 + truncated 标志，不再有 Size Limit Exceeded 硬错误）。
// 渲染走扁平化可见行列表（lib/dnTree 的 flattenDnTree 同思路），避免递归组件。
import { computed, ref, watch } from "vue";
import { ChevronDown, ChevronRight, X } from "@lucide/vue";
import { ldapApi, type LdapEntry } from "../lib/api";
import { useModalA11y } from "../lib/modal";
import { splitFirstDnRdn } from "../lib/dn";
import { TREE_FETCH_PAGE } from "../lib/dnTree";
import { t } from "../lib/i18n";

interface PickerNode {
  dn: string;
  label: string;
  loaded: boolean;
  loading: boolean;
  truncated: boolean;
  expanded: boolean;
  children: PickerNode[];
}

interface PickerRow {
  node: PickerNode;
  depth: number;
}

const props = defineProps<{
  open: boolean;
  /** 浏览根（通常为连接 Base DN 或当前值的父 DN）。 */
  baseDn: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "select", dn: string): void;
}>();

const root = ref<PickerNode | null>(null);
const loadError = ref("");

function toNode(entry: LdapEntry): PickerNode {
  const dn = entry.dn;
  return { dn, label: splitFirstDnRdn(dn).rdn || dn, loaded: false, loading: false, truncated: false, expanded: false, children: [] };
}

async function loadChildren(node: PickerNode) {
  if (node.loaded || node.loading) return;
  node.loading = true;
  loadError.value = "";
  try {
    // 解引用按设计沿用缺省 never：本弹层是 DN 查找辅助（选中结果写回 DN
    // 值），别名跟随对"找节点"无收益，且与树解引用状态相隔三层组件不值得
    // 耦合；GAP §1 行按此口径闭环。
    const result = await ldapApi.search({ baseDn: node.dn, scope: "one", filter: "(objectClass=*)", attributes: ["dn"], sizeLimit: TREE_FETCH_PAGE });
    node.children = result.entries.map(toNode);
    // 后端 truncated 标志优先；无标志时以数量兜底，仅确超上限（>上限，恰好
    // 等于不算截断）才置位，避免恰满一页时误报「未展示完」。
    node.truncated = result.truncated || result.count > TREE_FETCH_PAGE;
    node.loaded = true;
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    node.loading = false;
  }
}

async function toggle(node: PickerNode) {
  if (!node.loaded && !node.loading) await loadChildren(node);
  node.expanded = !node.expanded;
}

function select(node: PickerNode) {
  emit("select", node.dn);
}

// 深度优先展开 → 可见行（按当前展开态）
function flatten(node: PickerNode | null): PickerRow[] {
  const rows: PickerRow[] = [];
  const walk = (current: PickerNode, depth: number) => {
    rows.push({ node: current, depth });
    if (current.expanded) for (const child of current.children) walk(child, depth + 1);
  };
  if (node) walk(node, 0);
  return rows;
}

const rows = computed<PickerRow[]>(() => flatten(root.value));

watch(
  () => [props.open, props.baseDn] as const,
  ([open, baseDn]) => {
    if (!open) return;
    loadError.value = "";
    if (!baseDn) {
      root.value = null;
      return;
    }
    root.value = { dn: baseDn, label: baseDn, loaded: false, loading: false, truncated: false, expanded: true, children: [] };
    void loadChildren(root.value);
  },
  { immediate: true },
);

useModalA11y(
  () => props.open,
  { close: () => emit("close") },
);

const rowIndent = (depth: number) => ({ paddingLeft: `${depth * 16 + 8}px` });
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal dn-picker-modal" role="dialog" aria-modal="true" :aria-label="t('ldap.dnPicker.title')">
      <header>
        <h2>{{ t("ldap.dnPicker.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('close')"><X /></button>
      </header>
      <div v-if="!root" class="empty">{{ t("tree.missingBaseDn") }}</div>
      <template v-else>
        <p v-if="loadError" class="form-error" role="alert">{{ loadError }}</p>
        <ul class="dn-picker-tree" role="tree">
          <li v-for="row of rows" :key="row.node.dn" class="dn-picker-row" :style="rowIndent(row.depth)" role="treeitem" :aria-expanded="row.node.expanded || undefined" @click="select(row.node)">
            <button
              class="icon-button dn-picker-toggle"
              :aria-label="row.node.expanded ? t('tree.collapse') : t('tree.expand')"
              @click.stop="toggle(row.node)"
            >
              <span v-if="row.node.loading" class="dn-picker-spinner">…</span>
              <ChevronDown v-else-if="row.node.expanded" />
              <ChevronRight v-else />
            </button>
            <button class="dn-picker-name mono" :title="row.node.dn" :aria-label="`${t('ldap.dnPicker.select')}: ${row.node.dn}`" @click.stop="select(row.node)">
              {{ row.node.label }}
            </button>
            <span v-if="row.node.truncated" class="badge">{{ t("ldap.dnPicker.truncated", { limit: TREE_FETCH_PAGE }) }}</span>
          </li>
        </ul>
        <p v-if="rows.length === 1 && root.loaded && root.children.length === 0 && !loadError" class="empty">{{ t("ldap.dnPicker.empty") }}</p>
        <footer>
          <button type="button" @click="emit('close')">{{ t("cancel") }}</button>
        </footer>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dn-picker-modal {
  min-height: 320px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}
.dn-picker-tree {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  flex: 1;
}
.dn-picker-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  cursor: pointer;
}
.dn-picker-toggle {
  flex: none;
}
.dn-picker-name {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
}
.dn-picker-name:hover {
  text-decoration: underline;
}
</style>
