<script setup lang="ts">
// 新建条目向导（M6 N4）：① 模板选择（4 内置 + 空白）→ ② objectClass 可增删
// （增删时 must/may 动态重算 = objectClass 补加引导）→ ③ 父 DN + RDN →
// ④ must 必填表单 + 常用 may 折叠区。属性聚合走 lib/newEntryTemplates
// （schemaCache 驱动，schema 不可用回退内置表）；提交只 emit submit
// {dn, attributes} 由父层调 ldap/entry/add，组件内不直接依赖 api。
import { computed, ref, watch } from "vue";
import { Plus, X } from "@lucide/vue";
import { isLikelyRdn, splitFirstDnRdn } from "../lib/dn";
import { decideBackdropClose, useModalA11y } from "../lib/modal";
import { t } from "../lib/i18n";
import {
  buildDn,
  listTemplates,
  mayAttributesFor,
  mustAttributesFor,
  resolveTemplate,
  sortTemplatesForDialect,
  type LdapSchema,
  type NewEntryPayload,
  type TemplateId,
} from "../lib/newEntryTemplates";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 树上下文缺省父 DN（步骤 ③ 可改）。 */
    parentDn?: string;
    /** schemaCache 的聚合结果切片；缺省/为空时向导回退模板内置 must/may 表。 */
    schema?: LdapSchema;
    /** 连接可写门禁：false 时提交禁用并提示（与 ImportEntryDialog 同语义）。 */
    canWrite?: boolean;
  }>(),
  {
    canWrite: true,
  },
);

const emit = defineEmits<{
  (e: "submit", payload: NewEntryPayload): void;
  (e: "cancel"): void;
}>();

const templates = listTemplates();

// 阶段5 方言适配：按连接 serverInfo.dialect 把最匹配的模板排最前。
const orderedTemplates = computed(() => sortTemplatesForDialect(templates, props.schema?.serverInfo?.dialect));

const TEMPLATE_I18N: Record<TemplateId, { title: string; desc: string }> = {
  user: { title: "ldap.wizard.templateUser", desc: "ldap.wizard.templateUserDesc" },
  group: { title: "ldap.wizard.templateGroup", desc: "ldap.wizard.templateGroupDesc" },
  ou: { title: "ldap.wizard.templateOu", desc: "ldap.wizard.templateOuDesc" },
  simpleObject: { title: "ldap.wizard.templateSimpleObject", desc: "ldap.wizard.templateSimpleObjectDesc" },
  blank: { title: "ldap.wizard.templateBlank", desc: "ldap.wizard.templateBlankDesc" },
  adUser: { title: "ldap.wizard.templateAdUser", desc: "ldap.wizard.templateAdUserDesc" },
  posixUser: { title: "ldap.wizard.templatePosixUser", desc: "ldap.wizard.templatePosixUserDesc" },
  posixGroup: { title: "ldap.wizard.templatePosixGroup", desc: "ldap.wizard.templatePosixGroupDesc" },
  ipaUser: { title: "ldap.wizard.templateIpaUser", desc: "ldap.wizard.templateIpaUserDesc" },
};

const step = ref(1);
const templateId = ref<TemplateId | "">("");
const objectClasses = ref<string[]>([]);
const newClassInput = ref("");
const parentDnDraft = ref("");
const rdnAttrDraft = ref("");
const rdnValueDraft = ref("");
const attrValues = ref<Record<string, string>>({});
const showOptional = ref(false);

// 打开即重置为第 ① 步并带入树上下文父 DN（父 DN 变化跟随，照 EntryEditor
// 的 [open, parentDn] watch 语义）。
watch(
  () => [props.open, props.parentDn] as const,
  ([open]) => {
    if (!open) return;
    step.value = 1;
    templateId.value = "";
    objectClasses.value = [];
    newClassInput.value = "";
    parentDnDraft.value = props.parentDn || "";
    rdnAttrDraft.value = "";
    rdnValueDraft.value = "";
    attrValues.value = {};
    showOptional.value = false;
  },
  { immediate: true },
);

// -- 步骤 ① 模板选择 -----------------------------------------------------------

function chooseTemplate(id: TemplateId) {
  templateId.value = id;
  const template = resolveTemplate(id);
  objectClasses.value = template ? [...template.objectClasses] : [];
  rdnAttrDraft.value = template?.rdnAttr ?? "";
  rdnValueDraft.value = "";
  attrValues.value = {};
  newClassInput.value = "";
  step.value = 2;
}

// -- 步骤 ② objectClass 增删（补加引导） ----------------------------------------

const schemaLive = computed(() => {
  const map = props.schema?.objectClassAttributes;
  return Boolean(map && Object.keys(map).length > 0);
});

const classOptions = computed(() => {
  const map = props.schema?.objectClassAttributes;
  if (!map) return [];
  const current = new Set(objectClasses.value.map((name) => name.trim().toLowerCase()));
  return Object.keys(map)
    .filter((name) => !current.has(name.trim().toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
});

// must/may 随 objectClass 增删即时重算（computed），schema 缺失时在
// newEntryTemplates 内部回退内置表。
const mustAttrs = computed(() => mustAttributesFor(objectClasses.value, props.schema));
const mayAttrs = computed(() => mayAttributesFor(objectClasses.value, props.schema));

function addClass() {
  const name = newClassInput.value.trim();
  if (!name) return;
  if (!objectClasses.value.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
    objectClasses.value.push(name);
  }
  newClassInput.value = "";
}

function removeClass(name: string) {
  const index = objectClasses.value.indexOf(name);
  if (index >= 0) objectClasses.value.splice(index, 1);
}

// -- 步骤 ③ DN -----------------------------------------------------------------

const currentTemplate = computed(() => (templateId.value ? resolveTemplate(templateId.value) : null));

const rdnAttrOptions = computed(() => {
  const options = new Set<string>();
  const suggested = currentTemplate.value?.rdnAttr;
  if (suggested) options.add(suggested);
  for (const attr of mustAttrs.value) options.add(attr);
  return [...options];
});

const dnPreview = computed(() => buildDn(rdnAttrDraft.value, rdnValueDraft.value, parentDnDraft.value));
// RDN 客户端预检（对齐 EntryEditor 的 editor.rdnInvalid）：属性名含顶层逗号等
// 异常时提前拦截；值侧已由 buildDn 转义，正常输入不会触发。
const rdnInvalid = computed(() => dnPreview.value !== "" && !isLikelyRdn(splitFirstDnRdn(dnPreview.value).rdn));

// RDN 与 must 表单同名属性单向同步：RDN 值变化即写入对应 must 字段。
const rdnMustKey = computed(() => {
  const key = rdnAttrDraft.value.trim().toLowerCase();
  return key ? (mustAttrs.value.find((attr) => attr.trim().toLowerCase() === key) ?? "") : "";
});

watch([rdnValueDraft, rdnMustKey], ([value, key]) => {
  if (key) attrValues.value[key] = value;
});

// -- 步骤 ④ 属性表单 -----------------------------------------------------------

const isRdnAttr = (attr: string): boolean => attr === rdnMustKey.value;

const missingMust = computed(() =>
  mustAttrs.value.filter((attr) => (isRdnAttr(attr) ? rdnValueDraft.value : attrValues.value[attr] ?? "").trim() === ""),
);

const canSubmit = computed(
  () =>
    props.canWrite &&
    objectClasses.value.length > 0 &&
    dnPreview.value !== "" &&
    !rdnInvalid.value &&
    missingMust.value.length === 0,
);

function submit() {
  if (!canSubmit.value) return;
  const attributes: Record<string, string[]> = { objectClass: [...objectClasses.value] };
  for (const attr of mustAttrs.value) {
    const value = (isRdnAttr(attr) ? rdnValueDraft.value : attrValues.value[attr] ?? "").trim();
    if (value) attributes[attr] = [value];
  }
  for (const attr of mayAttrs.value) {
    const value = (attrValues.value[attr] ?? "").trim();
    if (value) attributes[attr] = [value];
  }
  emit("submit", { dn: dnPreview.value, attributes });
}

// -- 弹窗行为 -------------------------------------------------------------------

// Esc/遮罩走 cancel（向导无「未保存修改」守卫需求：模板重选即重置）。
useModalA11y(
  () => props.open,
  { close: () => emit("cancel") },
);

function onBackdropClick() {
  if (decideBackdropClose(true).kind !== "close") return;
  emit("cancel");
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="onBackdropClick">
    <div class="modal editor-modal new-entry-wizard" role="dialog" aria-modal="true" :aria-label="t('ldap.wizard.title')">
      <header>
        <h2>{{ t("ldap.wizard.title") }}</h2>
        <button class="icon-button" :title="t('close')" @click="emit('cancel')"><X /></button>
      </header>

      <div class="wizard-steps">
        <span :data-step="1" :class="{ 'is-active': step === 1 }">{{ t("ldap.wizard.stepTemplate") }}</span>
        <span :data-step="2" :class="{ 'is-active': step === 2 }">{{ t("ldap.wizard.stepObjectClass") }}</span>
        <span :data-step="3" :class="{ 'is-active': step === 3 }">{{ t("ldap.wizard.stepDn") }}</span>
        <span :data-step="4" :class="{ 'is-active': step === 4 }">{{ t("ldap.wizard.stepAttributes") }}</span>
      </div>

      <!-- ① 模板选择（方言匹配的排最前，卡片带方言标注） -->
      <div v-if="step === 1" class="wizard-step template-grid">
        <button
          v-for="template in orderedTemplates"
          :key="template.id"
          type="button"
          class="template-card"
          :data-template="template.id"
          :data-dialect="template.dialect ?? 'universal'"
          @click="chooseTemplate(template.id)"
        >
          <strong>{{ t(TEMPLATE_I18N[template.id].title) }}</strong>
          <small>{{ t(TEMPLATE_I18N[template.id].desc) }}</small>
        </button>
      </div>

      <!-- ② objectClass 增删 -->
      <div v-else-if="step === 2" class="wizard-step">
        <p v-if="!schemaLive" class="hint">{{ t("ldap.wizard.schemaUnavailable") }}</p>
        <div class="class-chips">
          <span v-for="name in objectClasses" :key="name" class="class-chip">
            <span class="mono">{{ name }}</span>
            <button
              type="button"
              class="icon-button chip-remove"
              :title="t('ldap.wizard.removeClass')"
              :aria-label="`${t('ldap.wizard.removeClass')}: ${name}`"
              @click="removeClass(name)"
            >
              <X />
            </button>
          </span>
          <span v-if="objectClasses.length === 0" class="muted">{{ t("ldap.wizard.noObjectClass") }}</span>
        </div>
        <div class="class-adder">
          <input
            v-model="newClassInput"
            type="text"
            name="objectclass"
            class="mono"
            :placeholder="t('ldap.wizard.objectClassPlaceholder')"
            :list="classOptions.length > 0 ? 'new-entry-class-options' : undefined"
            spellcheck="false"
            @keydown.enter.prevent="addClass"
          />
          <datalist v-if="classOptions.length > 0" id="new-entry-class-options">
            <option v-for="name in classOptions" :key="name" :value="name" />
          </datalist>
          <button type="button" class="toolbar-button" @click="addClass"><Plus aria-hidden="true" />{{ t("ldap.wizard.addClass") }}</button>
        </div>
        <p v-if="mustAttrs.length > 0" class="hint class-hint">
          {{ t("ldap.wizard.classHint") }} <strong class="mono">{{ mustAttrs.join(", ") }}</strong>
        </p>
        <p v-else class="hint">{{ t("ldap.wizard.noMust") }}</p>
      </div>

      <!-- ③ 父 DN + RDN -->
      <div v-else-if="step === 3" class="wizard-step">
        <label class="field">
          <span class="muted">{{ t("editor.parentDn") }}</span>
          <input v-model="parentDnDraft" type="text" class="mono" spellcheck="false" />
        </label>
        <div class="attr-row">
          <label class="field">
            <span class="muted">{{ t("ldap.wizard.rdnAttribute") }}</span>
            <input
              v-model="rdnAttrDraft"
              type="text"
              name="attr-name"
              class="mono"
              :placeholder="currentTemplate?.rdnAttr || 'cn'"
              :list="rdnAttrOptions.length > 0 ? 'new-entry-rdn-options' : undefined"
              spellcheck="false"
            />
            <datalist v-if="rdnAttrOptions.length > 0" id="new-entry-rdn-options">
              <option v-for="attr in rdnAttrOptions" :key="attr" :value="attr" />
            </datalist>
          </label>
          <label class="field">
            <span class="muted">{{ t("ldap.wizard.rdnValue") }}</span>
            <input v-model="rdnValueDraft" type="text" name="attr-value" class="mono" spellcheck="false" />
          </label>
        </div>
        <p v-if="rdnInvalid" class="form-error">{{ t("editor.rdnInvalid") }}</p>
        <p v-if="dnPreview" class="entry-dn">{{ dnPreview }}</p>
      </div>

      <!-- ④ must 必填 + may 折叠 -->
      <div v-else class="wizard-step wizard-attrs">
        <h3>{{ t("ldap.wizard.requiredAttributes") }}</h3>
        <p v-if="mustAttrs.length === 0" class="muted">{{ t("ldap.wizard.noMust") }}</p>
        <label v-for="attr in mustAttrs" :key="attr" class="field must-field" :data-attr="attr">
          <span class="muted mono">{{ attr }}</span>
          <input
            v-if="isRdnAttr(attr)"
            :value="rdnValueDraft"
            type="text"
            class="mono"
            disabled
            spellcheck="false"
          />
          <input
            v-else
            v-model="attrValues[attr]"
            type="text"
            class="mono"
            :placeholder="t('ldap.wizard.valuePlaceholder')"
            spellcheck="false"
          />
          <small v-if="isRdnAttr(attr)" class="hint">{{ t("ldap.wizard.rdnSynced") }}</small>
        </label>
        <p v-if="missingMust.length > 0" class="form-error">
          {{ t("ldap.wizard.mustMissing") }} <strong class="mono">{{ missingMust.join(", ") }}</strong>
        </p>
        <p v-if="objectClasses.length === 0" class="form-error">{{ t("ldap.wizard.objectClassRequired") }}</p>

        <button type="button" class="toolbar-button optional-toggle" @click="showOptional = !showOptional">
          {{ showOptional ? t("ldap.wizard.hideOptional") : t("ldap.wizard.showOptional") }} ({{ mayAttrs.length }})
        </button>
        <div v-if="showOptional" class="optional-grid">
          <label v-for="attr in mayAttrs" :key="attr" class="field may-field" :data-attr="attr">
            <span class="muted mono">{{ attr }}</span>
            <input
              v-model="attrValues[attr]"
              type="text"
              class="mono"
              :placeholder="t('ldap.wizard.valuePlaceholder')"
              spellcheck="false"
            />
          </label>
          <p v-if="mayAttrs.length === 0" class="muted">{{ t("ldap.wizard.noMay") }}</p>
        </div>
      </div>

      <footer>
        <span v-if="!canWrite" class="muted" style="margin-right: auto">{{ t("editor.readonlyHint") }}</span>
        <button type="button" @click="emit('cancel')">{{ t("cancel") }}</button>
        <button v-if="step > 1" type="button" @click="step -= 1">{{ t("ldap.wizard.prev") }}</button>
        <button v-if="step < 4" type="button" class="primary-button" @click="step += 1">{{ t("ldap.wizard.next") }}</button>
        <button v-else type="button" class="primary-button" :disabled="!canSubmit" @click="submit">
          {{ t("ldap.wizard.submit") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* 组件此前没有任何样式（类名样式从未落过样式表）：步骤条/模板卡/字段布局
   全部裸文本流（走查截图实锤）。本块按既有设计令牌补齐向导专属布局；
   .field 是向导内的通用字段（标签在上、输入在下），不外溢到其他组件。 */

/* 步骤条：data-step 作编号圆点，激活步高亮 */
.wizard-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 0;
  padding: 0 0 10px;
  border-bottom: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 11px;
}
.wizard-steps span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.wizard-steps span::before {
  content: attr(data-step);
  display: inline-grid;
  width: 16px;
  height: 16px;
  place-items: center;
  flex: 0 0 16px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: inherit;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}
.wizard-steps span.is-active {
  color: var(--foreground);
  font-weight: 600;
}
.wizard-steps span.is-active::before {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 16%, transparent);
  color: var(--primary);
}

.wizard-step {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
}
.wizard-step p {
  margin: 0;
}

/* 通用字段：标签在上、输入在下；输入框补齐基础形态 */
.wizard-step .field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.wizard-step .field > span {
  color: var(--muted-foreground);
  font-size: 10px;
}
.wizard-step input {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  background: var(--background);
  color: var(--foreground);
  font-size: 12px;
}
.wizard-step input:disabled {
  opacity: .6;
}

/* ① 模板卡网格：卡片式可选模板，方言卡带角标 */
.template-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(215px, 1fr));
  gap: 8px;
}
.template-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--background);
  color: var(--foreground);
  text-align: left;
  cursor: pointer;
}
.template-card:hover {
  border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
  background: color-mix(in srgb, var(--primary) 7%, transparent);
}
.template-card strong {
  font-size: 12px;
  font-weight: 600;
}
.template-card small {
  color: var(--muted-foreground);
  font-size: 10px;
  line-height: 1.5;
}
.template-card:not([data-dialect="universal"])::after {
  content: attr(data-dialect);
  position: absolute;
  top: 8px;
  right: 8px;
  border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--border));
  border-radius: 999px;
  padding: 0 6px;
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  color: var(--primary);
  font-size: 9px;
  line-height: 14px;
  text-transform: uppercase;
}

/* ② objectClass chips + 添加行（形态对齐编辑器 .oc-chip） */
.class-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.class-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 4px 2px 10px;
  background: var(--background);
  font-size: 12px;
}
.chip-remove {
  width: 18px;
  height: 18px;
  border-radius: 999px;
}
.chip-remove svg {
  width: 12px;
  height: 12px;
}
.class-adder {
  display: flex;
  align-items: center;
  gap: 6px;
}
.class-adder input {
  flex: 0 1 240px;
}

/* ③ RDN 行：覆写编辑器 .attr-row 的两列网格语义——此处是两个独立字段并排 */
.wizard-step .attr-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.wizard-step .attr-row .field {
  flex: 1 1 0;
}

/* ④ 必填/可选属性 */
.wizard-attrs h3 {
  margin: 0;
  font-size: 12px;
}
.must-field {
  max-width: 480px;
}
.optional-toggle {
  align-self: flex-start;
}
.optional-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}
</style>
