// entryDiff 纯函数单测：属性名大小写不敏感合并、equal/different/onlyLeft/
// onlyRight 四态、多值排序后比较、并集排序输出、差异计数。
import { describe, expect, it } from "vitest";
import { countEntryDiff, diffLdapEntries, truncateDiffValue } from "./entryDiff";
import type { LdapEntry } from "./api";

const entry = (dn: string, attributes: Record<string, string[]>): LdapEntry => ({ dn, attributes });

describe("diffLdapEntries", () => {
  it("marks attributes present on both sides with equal values as equal", () => {
    const rows = diffLdapEntries(entry("a", { cn: ["alice"], objectClass: ["top", "person"] }), entry("b", { cn: ["alice"], objectClass: ["top", "person"] }));
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["cn", "equal"],
      ["objectClass", "equal"],
    ]);
  });

  it("merges attribute names case-insensitively and keeps the left-side spelling", () => {
    const rows = diffLdapEntries(entry("a", { CN: ["alice"] }), entry("b", { cn: ["alice"] }));
    expect(rows).toEqual([{ name: "CN", status: "equal", leftValues: ["alice"], rightValues: ["alice"] }]);
  });

  it("reports different when the sorted value multisets disagree", () => {
    const rows = diffLdapEntries(entry("a", { memberUid: ["u2", "u1"] }), entry("b", { memberUid: ["u1", "u3"] }));
    // 顺序无关：排序后 [u1,u2] vs [u1,u3] 才判不同；展示也按排序输出。
    expect(rows).toEqual([{ name: "memberUid", status: "different", leftValues: ["u1", "u2"], rightValues: ["u1", "u3"] }]);
  });

  it("reports onlyLeft and onlyRight for one-sided attributes", () => {
    const rows = diffLdapEntries(entry("a", { ou: ["people"] }), entry("b", { cn: ["groups"], ou: ["groups"] }));
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["cn", "onlyRight"],
      ["ou", "different"],
    ]);
    expect(rows[1]?.leftValues).toEqual(["people"]);
    expect(rows[1]?.rightValues).toEqual(["groups"]);
  });

  it("sorts the union of attribute names for stable output", () => {
    const rows = diffLdapEntries(entry("a", { sn: ["a"], cn: ["a"] }), entry("b", { uid: ["b"] }));
    expect(rows.map((row) => row.name)).toEqual(["cn", "sn", "uid"]);
    expect(rows.map((row) => row.status)).toEqual(["onlyLeft", "onlyLeft", "onlyRight"]);
  });

  it("handles empty attribute maps on either side", () => {
    expect(diffLdapEntries(entry("a", {}), entry("b", { cn: ["x"] }))).toEqual([
      { name: "cn", status: "onlyRight", leftValues: [], rightValues: ["x"] },
    ]);
    expect(diffLdapEntries(entry("a", {}), entry("b", {}))).toEqual([]);
  });
});

describe("countEntryDiff", () => {
  it("counts total attributes and non-equal rows", () => {
    const rows = diffLdapEntries(
      entry("a", { cn: ["x"], ou: ["y"], sn: ["z"] }),
      entry("b", { cn: ["x"], ou: ["other"], uid: ["u"] }),
    );
    expect(countEntryDiff(rows)).toEqual({ total: 4, differences: 3 });
  });
});

// 展示层截断（评审 M-4）：jpegPhoto/证书类大值全量进 DOM 会拖垮差异表，
// 截断只发生在展示侧——diffLdapEntries 仍按全值比较，语义不受影响。
describe("truncateDiffValue", () => {
  it("passes values at or under the cap through unchanged", () => {
    expect(truncateDiffValue("abc", 4)).toEqual({ text: "abc", truncated: false, totalChars: 3 });
    // 恰好在上限的值不截断。
    expect(truncateDiffValue("abcd", 4)).toEqual({ text: "abcd", truncated: false, totalChars: 4 });
  });

  it("truncates oversized values to the cap with an ellipsis and the total length", () => {
    const shown = truncateDiffValue("abcdef", 4);
    expect(shown).toEqual({ text: "abcd…", truncated: true, totalChars: 6 });
  });

  it("defaults to the shared 4096-char cap", () => {
    const shown = truncateDiffValue("x".repeat(5000));
    expect(shown.truncated).toBe(true);
    expect(shown.text).toBe(`${"x".repeat(4096)}…`);
    expect(shown.totalChars).toBe(5000);
  });
});
