// @vitest-environment happy-dom
// useSearchSession 游标排空测试（审计 K-2）：自动排空期间按"每 2 页或 250ms"
// 批量提交，避免每页全量重提交触发整表重建；中途失败也要把已拉到的页提交出来。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { watch } from "vue";
import { useSearchSession, type SearchFormModel } from "./useSearchSession";
import { ldapApi } from "./api";

const model: SearchFormModel = {
  baseDn: "dc=demo",
  filter: "(objectClass=*)",
  scope: "sub",
  attributes: "",
  sizeLimit: "",
  pageSize: "500",
  typesOnly: false,
  derefAliases: "never",
  sortBy: "",
  sortOrder: "asc",
};

const entry = (n: number) => ({ dn: `cn=e${n},dc=demo`, attributes: {} });

function createSession(overrides: Partial<Parameters<typeof useSearchSession>[0]> = {}) {
  return useSearchSession({
    getConnectionId: () => "conn-1",
    clearBanner: () => {},
    onSnapshot: () => {},
    onHistory: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSearchSession cursor drain commits", () => {
  it("drains the cursor with batched commits instead of one commit per page", async () => {
    vi.spyOn(ldapApi, "searchStart").mockResolvedValue({ searchId: "s1", entries: [entry(1), entry(2)], hasMore: true });
    let page = 0;
    vi.spyOn(ldapApi, "searchNext").mockImplementation(async () => {
      page += 1;
      return { entries: [entry(page * 2 + 1), entry(page * 2 + 2)], hasMore: page < 4 };
    });
    const session = createSession();
    const commitSizes: number[] = [];
    // flush: "sync" 逐次记录每次提交（避开调度器合帧的时序不确定性）。
    const stop = watch(session.results, (rows) => commitSizes.push(rows.length), { flush: "sync" });
    await session.runSearch(model);
    await flushPromises();
    stop();
    // 清空一次 + 初始页一次提交 + 每 2 个 next 页合并一次 + 收尾最终提交。
    // （旧实现每页提交一次，5 页会是 5 次。）最终数据与顺序不变。
    expect(commitSizes).toEqual([0, 2, 6, 10]);
    expect(session.results.value.map((row) => row.dn)).toEqual(
      Array.from({ length: 10 }, (_, i) => entry(i + 1).dn),
    );
    expect(session.resultCount.value).toBe(10);
    expect(session.resultsComplete.value).toBe(true);
    expect(session.loadingMore.value).toBe(false);
  });

  it("commits already drained pages when a later page fails", async () => {
    vi.spyOn(ldapApi, "searchStart").mockResolvedValue({ searchId: "s1", entries: [entry(1)], hasMore: true });
    let page = 0;
    vi.spyOn(ldapApi, "searchNext").mockImplementation(async () => {
      page += 1;
      if (page === 1) return { entries: [entry(2), entry(3)], hasMore: true };
      throw new Error("cursor lost");
    });
    const session = createSession();
    await session.runSearch(model);
    await flushPromises();
    // 失败页之前已拉到的 next 页不丢失（部分结果保持可见）。
    expect(session.results.value.map((row) => row.dn)).toEqual([entry(1).dn, entry(2).dn, entry(3).dn]);
    expect(session.resultCount.value).toBe(3);
    expect(session.loadMoreErrorDetail.value).toBe("cursor lost");
    expect(session.loadMoreError.value).not.toBe("");
    // 重试入口可用：重新排空剩余游标。
    expect(session.resultsComplete.value).toBe(false);
  });

  it("keeps the final commit when the drain completes on the first next page", async () => {
    vi.spyOn(ldapApi, "searchStart").mockResolvedValue({ searchId: "s1", entries: [entry(1)], hasMore: true });
    vi.spyOn(ldapApi, "searchNext").mockResolvedValue({ entries: [entry(2)], hasMore: false });
    const session = createSession();
    await session.runSearch(model);
    await flushPromises();
    expect(session.results.value.map((row) => row.dn)).toEqual([entry(1).dn, entry(2).dn]);
    expect(session.resultsComplete.value).toBe(true);
  });
});

describe("useSearchSession referral surfacing (referral report)", () => {
  it("keeps the cumulative referral list from the start response", async () => {
    vi.spyOn(ldapApi, "searchStart").mockResolvedValue({
      searchId: "sr1",
      entries: [entry(1)],
      hasMore: false,
      referrals: ["ldap://a.example/dc=demo"],
    });
    const session = createSession();
    await session.runSearch(model);
    await flushPromises();
    expect(session.resultReferrals.value).toEqual(["ldap://a.example/dc=demo"]);
  });

  it("replaces the referral list with the latest cumulative page value", async () => {
    vi.spyOn(ldapApi, "searchStart").mockResolvedValue({
      searchId: "sr2",
      entries: [entry(1)],
      hasMore: true,
      referrals: ["ldap://a.example/dc=demo"],
    });
    vi.spyOn(ldapApi, "searchNext").mockImplementation(async () => ({
      entries: [entry(2)],
      hasMore: false,
      referrals: ["ldap://a.example/dc=demo", "ldap://b.example/dc=demo"],
    }));
    const session = createSession();
    await session.runSearch(model);
    await flushPromises();
    expect(session.resultReferrals.value).toEqual(["ldap://a.example/dc=demo", "ldap://b.example/dc=demo"]);
  });

  it("clears referrals on reset and between searches", async () => {
    vi.spyOn(ldapApi, "searchStart").mockResolvedValue({
      searchId: "sr3",
      entries: [entry(1)],
      hasMore: false,
      referrals: ["ldap://a.example/dc=demo"],
    });
    const session = createSession();
    await session.runSearch(model);
    await flushPromises();
    session.reset();
    expect(session.resultReferrals.value).toEqual([]);
    await session.runSearch(model);
    await flushPromises();
    expect(session.resultReferrals.value).toEqual(["ldap://a.example/dc=demo"]);
  });
});

// RFC 2891 服务器端排序（GAP §5）：请求透传 + 降级一次性提示。
describe("useSearchSession server-side sort", () => {
  it("passes sortBy/sortOrder to the search request only when sorting is requested", async () => {
    const start = vi.spyOn(ldapApi, "searchStart").mockResolvedValue({ searchId: "s1", entries: [], hasMore: false });
    const session = createSession();

    await session.runSearch({ ...model, sortBy: " cn ", sortOrder: "desc" });
    await flushPromises();
    expect(start.mock.lastCall![0]).toMatchObject({ sortBy: "cn", sortOrder: "desc" });

    // 空白属性 = 不请求排序：不发 sortBy/sortOrder 字段（后端不注入控件）。
    start.mockClear();
    await session.runSearch(model);
    await flushPromises();
    const request = start.mock.lastCall![0];
    expect("sortBy" in request).toBe(false);
    expect("sortOrder" in request).toBe(false);
  });

  it("notifies once when the server reports a non-zero SortResult", async () => {
    const notices: string[] = [];
    vi.spyOn(ldapApi, "searchStart").mockResolvedValue({ searchId: "s1", entries: [entry(1)], hasMore: false, sortResult: 18 });
    vi.spyOn(ldapApi, "searchNext").mockResolvedValue({ entries: [], hasMore: false });
    const session = createSession({ onNotice: (message) => notices.push(message) });
    await session.runSearch({ ...model, sortBy: "cn" });
    await flushPromises();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("18");
    // 降级不中断：条目照常展示。
    expect(session.results.value.map((row) => row.dn)).toEqual([entry(1).dn]);
    expect(session.searchError.value).toBe("");
  });

  it("stays silent for a successful sort or a legacy sidecar without the field", async () => {
    const notices: string[] = [];
    vi.spyOn(ldapApi, "searchStart").mockResolvedValue({ searchId: "s1", entries: [entry(1)], hasMore: false, sortResult: 0 });
    vi.spyOn(ldapApi, "searchNext").mockResolvedValue({ entries: [], hasMore: false });
    const session = createSession({ onNotice: (message) => notices.push(message) });
    await session.runSearch({ ...model, sortBy: "cn" });
    await flushPromises();

    // 旧 sidecar：响应缺 sortResult 字段 → 同样不提示。
    vi.spyOn(ldapApi, "searchStart").mockResolvedValue({ searchId: "s2", entries: [entry(2)], hasMore: false });
    await session.runSearch({ ...model, sortBy: "cn" });
    await flushPromises();
    expect(notices).toHaveLength(0);
  });
});
