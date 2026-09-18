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
import { Download, Trash2, Upload } from "@lucide/vue";
import { objectGuidDisplay, objectSidDisplay } from "../lib/adValues";
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
}>();

interface BinaryCard {
  value: string;
  kind: BinaryKind;
  previewUrl?: string;
  pemText?: string;
  hexText: string;
  /** AD 二进制标识（objectGUID/objectSid）的人类可读解码（UUID / S-1-…）。 */
  decoded?: string;
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
      <footer class="binary-actions">
        <button v-if="hasAlternateView(card)" type="button" class="toolbar-button" :disabled="disabled" @click="toggleView(card)">
          {{ toggleLabel(card) }}
        </button>
        <button type="button" class="toolbar-button binary-download" :disabled="disabled || card.invalid" @click="downloadValue(card, index)">
          <Download aria-hidden="true" /><span>{{ t("ldap.binary.download") }}</span>
        </button>
        <button type="button" class="toolbar-button binary-delete" :disabled="disabled" @click="removeValue(index)">
          <Trash2 aria-hidden="true" /><span>{{ t("ldap.binary.deleteValue") }}</span>
        </button>
      </footer>
    </div>
    <p v-if="cards.length === 0" class="hint binary-empty">{{ t("ldap.binary.empty") }}</p>
    <p v-if="uploadError" class="binary-error">{{ uploadError }}</p>
    <label class="toolbar-button binary-upload">
      <Upload aria-hidden="true" />
      <span>{{ t("ldap.binary.upload") }}</span>
      <!-- label 包裹 + 隐藏 input：点击按钮区即可打开选择器，测试可直接注入 files -->
      <input class="binary-file-input" type="file" multiple :disabled="disabled" style="display: none" @change="onFilesChosen" />
    </label>
  </div>
</template>
