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
});
