import { describe, expect, it } from "vitest";
import { chunkEntryAttributes, isDeferredEntryAttribute, mergeEntryAttributes, partitionEntryAttributes } from "./stagedEntry";

describe("staged entry helpers", () => {
  it("keeps association and binary attributes out of regular batches", () => {
    expect(partitionEntryAttributes(["cn", "l", "member", "jpegPhoto", "userCertificate;binary", "telephoneNumber"])).toEqual({
      regular: ["l", "telephoneNumber"],
      deferred: ["member", "jpegPhoto", "userCertificate;binary"],
    });
    expect(isDeferredEntryAttribute("managedBy")).toBe(true);
  });

  it("uses bounded batches and merges case-insensitively", () => {
    expect(chunkEntryAttributes(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(mergeEntryAttributes(
      { dn: "cn=a", attributes: { CN: ["old"], uid: ["a"] } },
      { dn: "cn=a", attributes: { cn: ["new"], mail: ["a@example.test"] } },
    )).toEqual({ dn: "cn=a", attributes: { uid: ["a"], cn: ["new"], mail: ["a@example.test"] } });
  });

  it("deep-copies value arrays even when merging into an empty base", () => {
    // 审查修复钉死：无基线的早退分支同样逐键拷贝，合并结果与源条目不得
    // 共享数组引用（原地改会串数据）。
    const source = { dn: "cn=a", attributes: { cn: ["a"], objectClass: ["top", "person"] } };
    const merged = mergeEntryAttributes(undefined, source);
    merged.attributes.objectClass.push("user");
    expect(source.attributes.objectClass).toEqual(["top", "person"]);
  });

  it("tolerates non-array attribute values from the wire instead of throwing", () => {
    // sidecar 运行时 JSON 的值类型不受 TS 契约保护：非数组容错为空数组。
    const merged = mergeEntryAttributes(undefined, {
      dn: "cn=a",
      attributes: { weird: null as unknown as string[] },
    });
    expect(merged.attributes.weird).toEqual([]);
  });
});
