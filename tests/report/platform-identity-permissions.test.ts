import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/server/modules/master/common";

const mocks = vi.hoisted(() => ({ user: vi.fn(), load: vi.fn() }));
vi.mock("@/db", () => ({ getDbAsync: vi.fn(async () => ({})) }));
vi.mock("@/server/modules/master/common", async (original) => ({
  ...await original<typeof import("@/server/modules/master/common")>(), guardRead: mocks.user,
}));
vi.mock("@/server/modules/outsource/common", async (original) => ({
  ...await original<typeof import("@/server/modules/outsource/common")>(), guardFreshWrite: mocks.user,
}));
vi.mock("@/server/modules/report/platform-sku-identity-gap", () => ({ loadPlatformSkuIdentityGap: mocks.load }));
import { GET } from "@/app/api/report/platform-sku-identity-gap/route";

const fixture = {
  state: "ready", gate: "观察口径", window: { from: "2026-06-01", to: "2026-08-31" },
  totals: { platformSkus: 7, mappedSkus: 2, paidAmount: "98123.45", mappedPaidAmount: "20123.45", unmappedPaidAmount: "78000.00",
    mappedAmountPct: 20.5, effectiveAmountPct: 30.5, coverableAmountPct: 80.1,
    byStatus: { not_in_crosswalk: { skus: 5, paidAmount: "78000.00" } } },
  top: [{ platformSkuId: "external-1", paidAmount: "98123.45", paidQty: 12, candidates: [{ skuId: 42, score: 95 }] }],
  exactHits: [{ skuId: 42, paidAmount: "98123.45" }], exactHitAmountPct: 70,
  bundleSummary: { platformSkus: 2, paidAmount: "980.00", amountPct: 1.1 },
  byShop: [{ shopName: "QA shop", paidAmount: "98123.45", mappedAmountPct: 20.5 }],
};

describe("identity read boundary preserves work, not unauthorized amounts", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.load.mockResolvedValue(fixture); });
  it.each(["ops", "warehouse", "quality", "unknown"])("%s sees identity facts without money at any depth", async (role) => {
    mocks.user.mockResolvedValue({ roles: [role], channelScope: null, deptScope: null });
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/paidAmount|mappedPaidAmount|unmappedPaidAmount|AmountPct|amountPct|98123/);
    expect(body.top[0].paidQty).toBe(12);
    expect(body.top[0].candidates[0]).toEqual({ skuId: 42, score: 95 });
    expect(body.permissions).toEqual({ canSeeAmounts: false, canClaim: role === "warehouse" });
    expect(fixture.top[0].paidAmount).toBe("98123.45");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each(["purchasing", "pmc", "finance", "admin"])("%s retains authorized amounts and independent claim permission", async (role) => {
    mocks.user.mockResolvedValue({ roles: [role], channelScope: null, deptScope: null });
    const body = await (await GET()).json();
    expect(body.totals).toEqual(fixture.totals);
    expect(body.permissions).toEqual({ canSeeAmounts: true, canClaim: role !== "finance" });
  });
  it("expired or revoked sessions never compute the shared model", async () => {
    mocks.user.mockRejectedValue(new ApiError(401, "会话已失效"));
    expect((await GET()).status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each([{ channelScope: [1], deptScope: null }, { channelScope: [], deptScope: null }, { channelScope: null, deptScope: ["pmc"] }])("scoped readers cannot retrieve global identity totals: %j", async scope => {
    mocks.user.mockResolvedValue({ roles: ["pmc"], ...scope });
    expect((await GET()).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("admin remains unrestricted under the shared scope policy", async () => {
    mocks.user.mockResolvedValue({ roles: ["admin"], channelScope: [1], deptScope: ["pmc"] });
    expect((await GET()).status).toBe(200);
  });
});
