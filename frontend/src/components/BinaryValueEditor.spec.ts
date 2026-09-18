// @vitest-environment happy-dom
// BinaryValueEditor workbench UI tests (M6-N3): image preview via data URL,
// hex fallback for unknown payloads, PEM pretty view with hex/pem toggles,
// per-value delete emits, front-end upload (FileReader → base64) with the
// 5 MB hard block, multi-file picks, invalid base64 flagging and disabled
// state. Pure front-end: no api/host bridge is involved, so nothing is
// mocked; i18n placeholder keys resolve to their key strings (missing from
// lib/i18n until the integration lands) and assertions reuse the same keys.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { t } from "../lib/i18n";
import { MAX_BINARY_BYTES, bytesToBase64 } from "../lib/binaryValue";
import BinaryValueEditor from "./BinaryValueEditor.vue";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const UNKNOWN_BYTES = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
const PEM_TEXT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

const jpegBase64 = bytesToBase64(JPEG_BYTES);
const pngBase64 = bytesToBase64(PNG_BYTES);
const unknownBase64 = bytesToBase64(UNKNOWN_BYTES);
const pemBase64 = bytesToBase64(new TextEncoder().encode(PEM_TEXT));

interface EditorProps {
  attributeName?: string;
  modelValue?: string[];
  disabled?: boolean;
}

function mountEditor(props: EditorProps = {}) {
  return mount(BinaryValueEditor, {
    props: { attributeName: "jpegPhoto", modelValue: [], ...props },
  });
}

type EditorWrapper = Awaited<ReturnType<typeof mountEditor>>;

const tracked: EditorWrapper[] = [];

function trackEditor(props: EditorProps = {}): EditorWrapper {
  const wrapper = mountEditor(props);
  tracked.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const wrapper of tracked.splice(0)) wrapper.unmount();
});

const cards = (wrapper: EditorWrapper) => wrapper.findAll(".binary-card");
const hexViews = (wrapper: EditorWrapper) => wrapper.findAll("pre.binary-hex");
const pemViews = (wrapper: EditorWrapper) => wrapper.findAll("pre.binary-pem");
const deleteButton = (wrapper: EditorWrapper, index = 0) => cards(wrapper)[index].find(".binary-delete");
const toggleButton = (wrapper: EditorWrapper, label: string) =>
  wrapper.findAll("button").find((button) => button.text() === label);

async function chooseFiles(wrapper: EditorWrapper, files: File[]) {
  const input = wrapper.find('input[type="file"]').element as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await wrapper.find('input[type="file"]').trigger("change");
  // happy-dom 的 FileReader 用两层嵌套 window.setTimeout 模拟读取，且组件
  // 按文件串行读取：每个文件两级宏任务，外加少量余量，最后 flush 微任务。
  for (let i = 0; i < files.length * 2 + 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await flushPromises();
}

describe("BinaryValueEditor", () => {
  it("renders an inline image preview (data URL) for an image value", () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [jpegBase64] });
    const image = wrapper.find("img.binary-preview");
    expect(image.exists()).toBe(true);
    expect(image.attributes("src")).toBe(`data:image/jpeg;base64,${jpegBase64}`);
    expect(image.attributes("alt")).toBe("jpegPhoto #1");
    expect(hexViews(wrapper)).toHaveLength(0);
  });

  it("renders one card per value in a multi-valued attribute", () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [jpegBase64, pngBase64] });
    expect(cards(wrapper)).toHaveLength(2);
    expect(wrapper.findAll("img.binary-preview")[1].attributes("src")).toBe(`data:image/png;base64,${pngBase64}`);
  });

  it("falls back to the hex view for unknown payloads", () => {
    const wrapper = trackEditor({ attributeName: "cn", modelValue: [unknownBase64] });
    expect(wrapper.find("img.binary-preview").exists()).toBe(false);
    const hex = hexViews(wrapper)[0];
    expect(hex.exists()).toBe(true);
    expect(hex.text()).toContain("00000000");
    expect(hex.text()).toContain("01 02 03 04");
    // 未知非证书值没有可切回的视图：下载 + 删除，无视图切换按钮。
    expect(cards(wrapper)[0].findAll("button")).toHaveLength(2);
  });

  it("shows the decoded UUID instead of hex for objectGUID values", () => {
    const guidBytes = new Uint8Array([0x6c, 0x60, 0x4e, 0x2f, 0x1f, 0x62, 0xb6, 0x4c, 0xb7, 0xe4, 0x3d, 0xfd, 0xf6, 0x60, 0xa0, 0x8f]);
    const wrapper = trackEditor({ attributeName: "objectGUID", modelValue: [bytesToBase64(guidBytes)] });
    const decoded = wrapper.find(".binary-card .binary-decoded");
    expect(decoded.exists()).toBe(true);
    expect(decoded.text()).toBe("2f4e606c-621f-4cb6-b7e4-3dfdf660a08f");
    // 有权威解码文本时不再渲染 hex 乱码，也没有视图切换按钮：仅下载 + 删除。
    expect(hexViews(wrapper)).toHaveLength(0);
    expect(cards(wrapper)[0].findAll("button")).toHaveLength(2);
    expect(wrapper.find(".binary-download").exists()).toBe(true);
    expect(wrapper.find(".binary-delete").exists()).toBe(true);
  });

  it("shows the decoded S-1-… text for objectSid values", () => {
    const sidBytes = new Uint8Array([1, 2, 0, 0, 0, 0, 0, 5, 14, 0, 0, 0, 1, 0, 0, 0]);
    const wrapper = trackEditor({ attributeName: "objectSid", modelValue: [bytesToBase64(sidBytes)] });
    expect(wrapper.find(".binary-card .binary-decoded").text()).toBe("S-1-5-14-1");
    expect(hexViews(wrapper)).toHaveLength(0);
  });

  it("falls back to hex when an objectGUID value does not decode", () => {
    // 长度不是 16 字节：无法构成合法 GUID，回退 hex 视图。
    const wrapper = trackEditor({ attributeName: "objectGUID", modelValue: [unknownBase64] });
    expect(wrapper.find(".binary-card .binary-decoded").exists()).toBe(false);
    expect(hexViews(wrapper)).toHaveLength(1);
  });

  it("pretty-prints a PEM value and toggles it to hex and back", async () => {
    const wrapper = trackEditor({ attributeName: "userCertificate", modelValue: [pemBase64] });
    expect(pemViews(wrapper)[0].text()).toContain("-----BEGIN CERTIFICATE-----");
    await toggleButton(wrapper, t("ldap.binary.hexView"))!.trigger("click");
    expect(hexViews(wrapper)).toHaveLength(1);
    expect(pemViews(wrapper)).toHaveLength(0);
    await toggleButton(wrapper, t("ldap.binary.pemView"))!.trigger("click");
    expect(pemViews(wrapper)).toHaveLength(1);
  });

  it("toggles an image card to hex and back to the preview", async () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [jpegBase64] });
    await toggleButton(wrapper, t("ldap.binary.hexView"))!.trigger("click");
    expect(hexViews(wrapper)).toHaveLength(1);
    expect(wrapper.find("img.binary-preview").exists()).toBe(false);
    await toggleButton(wrapper, t("ldap.binary.previewView"))!.trigger("click");
    expect(wrapper.find("img.binary-preview").exists()).toBe(true);
    expect(hexViews(wrapper)).toHaveLength(0);
  });

  it("offers the PEM wrap view for certificate attributes with unknown payloads", async () => {
    const wrapper = trackEditor({ attributeName: "userSMIMECertificate", modelValue: [unknownBase64] });
    // 未知值默认 hex，但证书语义属性可切到 prettyPem 包装视图。
    await toggleButton(wrapper, t("ldap.binary.pemView"))!.trigger("click");
    const pem = pemViews(wrapper)[0];
    expect(pem.exists()).toBe(true);
    expect(pem.text()).toContain("-----BEGIN CERTIFICATE-----");
    expect(pem.text()).toContain("-----END CERTIFICATE-----");
  });

  it("emits the remaining values when one value is deleted", async () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [jpegBase64, pngBase64] });
    await deleteButton(wrapper, 0).trigger("click");
    // emitted("update:modelValue")[0] 是该次调用的参数列表：[新数组]。
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([[pngBase64]]);
  });

  it("blocks oversized uploads with an error and no emit", async () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [jpegBase64] });
    const oversized = new File([new Uint8Array(MAX_BINARY_BYTES + 1)], "big.jpg", { type: "image/jpeg" });
    await chooseFiles(wrapper, [oversized]);
    expect(wrapper.text()).toContain(t("ldap.binary.tooLarge", { name: "big.jpg", max: MAX_BINARY_BYTES / (1024 * 1024) }));
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("accepts a valid upload and appends it via update:modelValue", async () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [pemBase64] });
    await chooseFiles(wrapper, [new File([JPEG_BYTES], "photo.jpg", { type: "image/jpeg" })]);
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([[pemBase64, jpegBase64]]);
    expect(wrapper.text()).not.toContain(t("ldap.binary.tooLarge", { name: "photo.jpg", max: MAX_BINARY_BYTES / (1024 * 1024) }));
  });

  it("accepts multiple files in one pick, preserving order", async () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [] });
    await chooseFiles(wrapper, [
      new File([JPEG_BYTES], "a.jpg", { type: "image/jpeg" }),
      new File([PNG_BYTES], "b.png", { type: "image/png" }),
    ]);
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([[jpegBase64, pngBase64]]);
  });

  it("flags values that are not valid base64 instead of rendering them", () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: ["not!!base64"] });
    expect(wrapper.text()).toContain(t("ldap.binary.invalidBase64"));
    expect(wrapper.find("img.binary-preview").exists()).toBe(false);
    expect(hexViews(wrapper)).toHaveLength(0);
  });

  it("downloads a value through the host save dialog as raw bytes with a sniffed extension", async () => {
    const saved: Array<{ options: Record<string, unknown>; bytes: Uint8Array }> = [];
    (window as unknown as { dbxPlugin: unknown }).dbxPlugin = {
      saveFile: async (options: Record<string, unknown>, bytes: Uint8Array) => {
        saved.push({ options, bytes });
        return { path: `/tmp/${options.fileName as string}` };
      },
    };

    const wrapper = trackEditor({ attributeName: "jpegPhoto;binary", modelValue: [jpegBase64] });
    await wrapper.find(".binary-download").trigger("click");
    await flushPromises();

    expect(saved).toHaveLength(1);
    expect(saved[0].options).toEqual({ fileName: "jpegPhoto-1.jpg", contentType: "image/jpeg" });
    expect(saved[0].bytes).toEqual(JPEG_BYTES);
    // 下载是只读动作：不改变模型值。
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    delete (window as unknown as { dbxPlugin?: unknown }).dbxPlugin;
  });

  it("falls back to an anonymous blob download when the host bridge has no save dialog", async () => {
    const clicked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download ?? "");
    });

    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [jpegBase64] });
    await wrapper.find(".binary-download").trigger("click");
    await flushPromises();

    expect(clicked).toEqual(["jpegPhoto-1.jpg"]);
    // 下载是只读动作：不改变模型值。
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    vi.mocked(URL.createObjectURL).mockRestore();
    vi.mocked(URL.revokeObjectURL).mockRestore();
    clickSpy.mockRestore();
  });

  it("marks the download button disabled on an invalid card", () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: ["not!!base64"] });
    expect(wrapper.find(".binary-download").attributes("disabled")).toBeDefined();
  });

  it("disables delete/download/toggle/upload when disabled", () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [jpegBase64], disabled: true });
    expect(deleteButton(wrapper).attributes("disabled")).toBeDefined();
    expect(wrapper.find(".binary-download").attributes("disabled")).toBeDefined();
    expect(wrapper.find('input[type="file"]').attributes("disabled")).toBeDefined();
  });

  it("shows the empty hint when there are no values", () => {
    const wrapper = trackEditor({ attributeName: "jpegPhoto", modelValue: [] });
    expect(wrapper.find(".binary-empty").text()).toBe(t("ldap.binary.empty"));
    expect(wrapper.find('input[type="file"]').exists()).toBe(true);
  });
});
