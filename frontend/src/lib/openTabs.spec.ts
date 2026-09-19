// F9 多开页签的工作集顺序（App.vue watch 的纯函数抽取）：激活已有页签不得
// 重排（点击跳动的根因），新开追加尾部，超限从最旧一端淘汰；大小写不敏感
// 去重且保留原有书写。
import { describe, expect, it } from "vitest";
import { appendOpenTab } from "./openTabs";

describe("appendOpenTab", () => {
  it("appends a new tab at the end keeping the existing order", () => {
    expect(appendOpenTab(["ou=A", "uid=b"], "dc=x", 6)).toEqual(["ou=A", "uid=b", "dc=x"]);
  });

  it("keeps the order untouched when activating an existing tab", () => {
    expect(appendOpenTab(["ou=A", "uid=b", "dc=x"], "uid=b", 6)).toEqual(["ou=A", "uid=b", "dc=x"]);
  });

  it("dedupes case-insensitively without reordering, keeping the original spelling", () => {
    expect(appendOpenTab(["cn=Groups", "uid=Jane"], "CN=GROUPS", 6)).toEqual(["cn=Groups", "uid=Jane"]);
  });

  it("evicts the oldest tab from the front once the cap is exceeded", () => {
    expect(appendOpenTab(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });

  it("starts a fresh list from an empty one", () => {
    expect(appendOpenTab([], "ou=First", 6)).toEqual(["ou=First"]);
  });
});
