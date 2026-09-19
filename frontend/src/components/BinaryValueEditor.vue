<script setup lang="ts">
// BinaryValueEditor (M6-N3): multi-value editor card stack for binary
// attributes (jpegPhoto, *Certificate, …). Each base64 value gets one card:
// image preview (data URL) / pretty-printed PEM / hex view, a hex toggle and
// a per-value delete (emits update:modelValue; the dialog owns persistence via
// the existing entry/modify channel). objectGUID/objectSid render the decoded
// UUID / S-1-… text instead of a hex dump (ADS getDisplayValue behaviour).
// Upload is front-end only:
// <input type="file"> → FileReader → base64, hard-capped at MAX_BINARY_BYTES
// so stdio-jsonl messages stay small. No new protocol methods.
import { computed, ref } from "vue";
import { Copy, Download, Trash2, Upload } from "@lucide/vue";
import { objectGuidDisplay, objectSidDisplay } from "../lib/adValues";
import { writeClipboardText } from "../lib/clipboard";
import {
  MAX_BINARY_BYTES,
  base64ToBytes,
  bytesToBase64,
  looksBinaryAttribute,
  prettyPem,
  sniffBinaryKind,
  toHexView,
  type BinaryKind,
} from "../lib/binaryValue";
import { saveBinaryFile } from "../lib/fileSave";
import { t } from "../lib/i18n";

const props = defineProps<{
  attributeName: string;
  modelValue: string[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string[]): void;
  (e: "notify", message: string): void;
}>();

// 复制解码值（GUID/SID 的人类可读形式）：与条目编辑器复制同一条链路，
// 失败如实通知，不假装"已复制"。
async function copyDecoded(card: BinaryCard): Promise<void> {
  if (!card.decoded) return;
  emit("notify", (await writeClipboardText(card.decoded)) ? t("copied") : t("copyFailed"));
}

// 字节数展示：<1KB 按字节计，往上 KB/MB 一位小数；单位字面量通用。
function sizeLabel(card: BinaryCard): string {
  const bytes = card.sizeBytes ?? 0;
  if (bytes < 1024) return t("ldap.binary.sizeBytes", { count: bytes });
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface BinaryCard {
  value: string;
  kind: BinaryKind;
  previewUrl?: string;
  pemText?: string;
  hexText: string;
  /** AD 二进制标识（objectGUID/objectSid）的人类可读解码（UUID / S-1-…）。 */
  decoded?: string;
  /** 解码后的原始字节数（invalid 值无法计算，缺省）。 */
  sizeBytes?: number;
  invalid: boolean;
}

type CardMode = "decoded" | "preview" | "pem" | "hex";

const IMAGE_MIME: Partial<Record<BinaryKind, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

// 下载扩展名按嗅探结果选择，未知二进制落 .bin；PEM 值直接以文本保存。
const DOWNLOAD_EXT: Partial<Record<BinaryKind, string>> = {
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
  pem: "pem",
};

// PEM 美化只对"证书语义"开放：属性名启发式命中证书/PKCS#12，或值本身解码后
// 就是 PEM 文本（sniff = pem）。纯图片/未知二进制不套 BEGIN/END。
const isCertificateAttribute = computed(() => looksBinaryAttribute(props.attributeName) && /certificate|pkcs12/i.test(props.attributeName));

// AD 二进制标识按裸属性名判定（剥 ";binary" 等传输后缀）：这类值有权威的
// 人类可读形式，卡片直接展示解码文本，不再渲染 hex（hex 对用户只是乱码）。
function decodedIdentifierFor(attributeName: string, value: string): string {
  const bare = attributeName.split(";")[0]?.trim().toLowerCase();
  if (bare === "objectguid") return objectGuidDisplay(value);
  if (bare === "objectsid") return objectSidDisplay(value);
  return "";
}

function buildCard(value: string): BinaryCard {
  try {
    const bytes = base64ToBytes(value);
    const kind = sniffBinaryKind(bytes);
    const mime = IMAGE_MIME[kind];
    let pemText: string | undefined;
    if (kind === "pem" || (kind === "unknown" && isCertificateAttribute.value)) {
      try {
        pemText = kind === "pem" ? prettyPem(new TextDecoder().decode(bytes)) : prettyPem(value);
      } catch {
        pemText = undefined;
      }
    }
    const decoded = decodedIdentifierFor(props.attributeName, value);
    return {
      value,
      kind,
      previewUrl: mime ? `data:${mime};base64,${value}` : undefined,
      pemText,
      hexText: toHexView(bytes),
      decoded: decoded || undefined,
      sizeBytes: bytes.length,
      invalid: false,
    };
  } catch {
    return { value, kind: "unknown", hexText: "", invalid: true };
  }
}

const cards = computed<BinaryCard[]>(() => props.modelValue.map(buildCard));

// 视图切换状态按"值内容"记录：删除某个值后其余卡片的视图不被错位重置。
const hexToggled = ref(new Set<string>());
const pemToggled = ref(new Set<string>());

function cardMode(card: BinaryCard): CardMode {
  if (card.invalid) return "hex";
  if (card.decoded) return "decoded";
  if (hexToggled.value.has(card.value)) return "hex";
  if (card.kind === "pem") return "pem";
  if (card.kind === "unknown") return pemToggled.value.has(card.value) ? "pem" : "hex";
  return "preview";
}

function hasAlternateView(card: BinaryCard): boolean {
  if (card.invalid || card.decoded) return false;
  if (cardMode(card) !== "hex") return true;
  // hex 视图下还有得切回去的：图片预览、PEM 文本，或证书语义下的 PEM 包装。
  return card.previewUrl !== undefined || card.kind === "pem" || (card.kind === "unknown" && isCertificateAttribute.value && card.pemText !== undefined);
}

function toggleView(card: BinaryCard): void {
  if (props.disabled || card.invalid || !hasAlternateView(card)) return;
  if (cardMode(card) === "hex") {
    hexToggled.value.delete(card.value);
    if (card.kind === "unknown") pemToggled.value.add(card.value);
    return;
  }
  hexToggled.value.add(card.value);
  pemToggled.value.delete(card.value);
}

function toggleLabel(card: BinaryCard): string {
  if (cardMode(card) !== "hex") return t("ldap.binary.hexView");
  // 从 hex 切回的目标视图：图片 → 预览，其余（pem/证书语义）→ PEM。
  return card.previewUrl !== undefined ? t("ldap.binary.previewView") : t("ldap.binary.pemView");
}

function removeValue(index: number): void {
  if (props.disabled) return;
  emit(
    "update:modelValue",
    props.modelValue.filter((_, i) => i !== index),
  );
}

// base64 → 原始字节 → fileSave 三级回退（宿主另存为 → 浏览器选择器 →
// 匿名下载）：与上传互为镜像，服务端值/上传值都能存回本地文件；命名
// <属性名>-<序号>.<嗅探扩展名>。用户取消对话框时静默收场。
async function downloadValue(card: BinaryCard, index: number): Promise<void> {
  if (props.disabled || card.invalid) return;
  const baseName = props.attributeName.split(";")[0]?.trim() || "value";
  const mime = IMAGE_MIME[card.kind] ?? (card.kind === "pem" ? "text/plain" : "application/octet-stream");
  await saveBinaryFile({
    name: `${baseName}-${index + 1}.${DOWNLOAD_EXT[card.kind] ?? "bin"}`,
    contentType: mime,
    bytes: base64ToBytes(card.value),
  });
}

const uploadError = ref("");

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(bytesToBase64(new Uint8Array(reader.result as ArrayBuffer)));
    reader.onerror = () => reject(reader.error ?? new Error(`cannot read ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

async function onFilesChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  await acceptFiles(files);
}

async function acceptFiles(files: File[]): Promise<void> {
  if (props.disabled || files.length === 0) return;
  const accepted: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    // 前端硬拦截：超过 5 MB 的值会让 stdio-jsonl 消息过大，直接拒绝。
    if (file.size > MAX_BINARY_BYTES) {
      errors.push(t("ldap.binary.tooLarge", { name: file.name, max: MAX_BINARY_BYTES / (1024 * 1024) }));
      continue;
    }
    try {
      accepted.push(await readFileAsBase64(file));
    } catch {
      errors.push(t("ldap.binary.readFailed", { name: file.name }));
    }
  }
  uploadError.value = errors.join("\n");
  if (accepted.length > 0) emit("update:modelValue", [...props.modelValue, ...accepted]);
}

// 拖拽上传：dragover 高亮投放位，drop 与点击选择走同一接受管道。
const dragOver = ref(false);

function onDragOver(event: DragEvent): void {
  if (props.disabled) return;
  event.preventDefault();
  dragOver.value = true;
}

function onDragLeave(): void {
  dragOver.value = false;
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  if (props.disabled) return;
  event.preventDefault();
  void acceptFiles(Array.from(event.dataTransfer?.files ?? []));
}
</script>

<template>
  <div class="binary-editor">
    <div v-for="(card, index) in cards" :key="index" class="binary-card" :class="{ 'binary-card-invalid': card.invalid }">
      <p v-if="card.invalid" class="binary-error">{{ t("ldap.binary.invalidBase64") }}</p>
      <p v-else-if="cardMode(card) === 'decoded'" class="binary-decoded mono">{{ card.decoded }}</p>
      <img
        v-else-if="cardMode(card) === 'preview'"
        class="binary-preview"
        :src="card.previewUrl"
        :alt="`${attributeName} #${index + 1}`"
      />
      <pre v-else-if="cardMode(card) === 'pem' && card.pemText !== undefined" class="binary-pem mono">{{ card.pemText }}</pre>
      <pre v-else class="binary-hex mono">{{ card.hexText }}</pre>
      <div class="binary-actions">
        <span v-if="card.sizeBytes !== undefined" class="binary-size mono">{{ sizeLabel(card) }}</span>
        <button v-if="card.decoded" type="button" class="toolbar-button binary-copy" :disabled="disabled" @click="copyDecoded(card)">
          <Copy aria-hidden="true" /><span>{{ t("ldap.binary.copyDecoded") }}</span>
        </button>
        <button v-if="hasAlternateView(card)" type="button" class="toolbar-button" :disabled="disabled" @click="toggleView(card)">
          {{ toggleLabel(card) }}
        </button>
        <button type="button" class="toolbar-button binary-download" :disabled="disabled || card.invalid" @click="downloadValue(card, index)">
          <Download aria-hidden="true" /><span>{{ t("ldap.binary.download") }}</span>
        </button>
        <button type="button" class="toolbar-button binary-delete" :disabled="disabled" @click="removeValue(index)">
          <Trash2 aria-hidden="true" /><span>{{ t("ldap.binary.deleteValue") }}</span>
        </button>
      </div>
    </div>
    <p v-if="cards.length === 0" class="hint binary-empty">{{ t("ldap.binary.empty") }}</p>
    <p v-if="uploadError" class="binary-error">{{ uploadError }}</p>
    <!-- 全宽虚线投放位：点击选文件 / 直接拖入，hidden input 由 label 包裹触发。 -->
    <label
      class="binary-upload"
      :class="{ 'binary-upload-dragover': dragOver }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <Upload aria-hidden="true" />
      <span>{{ t("ldap.binary.upload") }}</span>
      <input class="binary-file-input" type="file" multiple :disabled="disabled" style="display: none" @change="onFilesChosen" />
    </label>
  </div>
</template>

<style scoped>
/* 二进制编辑器卡片（此前无样式、且 .binary-actions 用 <footer> 会命中全局
   .modal footer 的灰底/负 margin/右对齐——错位根因，已改 div）。 */
.binary-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
}
.binary-card {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  background: var(--background);
}
.binary-card-invalid {
  border-color: color-mix(in srgb, var(--destructive) 45%, var(--border));
}
.binary-error {
  margin: 0;
  color: var(--destructive);
  font-size: 12px;
}
.binary-decoded {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.binary-preview {
  display: block;
  max-width: 100%;
  max-height: 220px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.binary-hex,
.binary-pem {
  max-height: 180px;
  margin: 0;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
}
.binary-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.binary-size {
  margin-right: auto;
  color: var(--muted-foreground);
  font-size: 11px;
}
/* 全宽虚线投放位：点击选文件 / 拖入文件，悬停与拖拽高亮。 */
.binary-upload {
  display: flex;
  width: 100%;
  min-height: 56px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-sizing: border-box;
  border: 1px dashed var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.binary-upload:hover,
.binary-upload-dragover {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
  color: var(--foreground);
}
.binary-upload svg {
  width: 16px;
  height: 16px;
}
</style>
