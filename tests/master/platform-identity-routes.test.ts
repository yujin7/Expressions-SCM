import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/server/modules/master/common";

const mocks = vi.hoisted(() => ({ fresh: vi.fn(), claim: vi.fn(), bulk: vi.fn(), fill: vi.fn() }));
vi.mock("@/server/modules/outsource/common", async original => ({
  ...await original<typeof import("@/server/modules/outsource/common")>(), guardFreshWrite: mocks.fresh,
}));
vi.mock("@/server/modules/master/platform-sku-claim", () => ({ claimPlatformSku: mocks.claim, claimPlatformSkusBulk: mocks.bulk }));
vi.mock("@/server/modules/master/sku-barcode-fill", () => ({ fillSkuBarcodesBulk: mocks.fill }));
import { POST as claim } from "@/app/api/master/sku/platform-claim/route";
import { POST as bulk } from "@/app/api/master/sku/platform-claim/bulk/route";
import { POST as fill } from "@/app/api/master/sku/barcode-fill/bulk/route";

describe.each([
  ["platform-claim", claim, mocks.claim],
  ["platform-claim/bulk", bulk, mocks.bulk],
  ["barcode-fill/bulk", fill, mocks.fill],
] as const)("identity POST %s", (path, post, service) => {
  const request = () => new NextRequest(`http://localhost/api/master/sku/${path}`, {
    method: "POST", body: JSON.stringify({ items: [{ skuId: 42 }] }),
    headers: { "content-type": "application/json" },
  });
  beforeEach(() => { vi.clearAllMocks(); service.mockResolvedValue({ accepted: 1 }); });
  it("rejects expired/revoked identity before invoking the write service", async () => {
    mocks.fresh.mockRejectedValue(new ApiError(401, "会话已失效"));
    expect((await post(request())).status).toBe(401);
    expect(service).not.toHaveBeenCalled();
  });
  it.each([
    { roles: ["ops"] }, { roles: ["finance"] }, { roles: ["unknown"] },
    { roles: ["pmc"], channelScope: [1] }, { roles: ["warehouse"], channelScope: [] },
    { roles: ["purchasing"], deptScope: ["purchasing"] },
  ])("rejects role/scope boundary %j", async policy => {
    mocks.fresh.mockResolvedValue({ id: 1, ...policy });
    expect((await post(request())).status).toBe(403);
    expect(service).not.toHaveBeenCalled();
  });
  it.each(["admin", "pmc", "purchasing", "warehouse"])("permits unscoped %s with fresh actor", async role => {
    const actor = { id: 42, name: "QA", roles: [role] };
    mocks.fresh.mockResolvedValue(actor);
    const response = await post(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(mocks.fresh).toHaveBeenCalledOnce();
    expect(service).toHaveBeenCalledExactlyOnceWith(actor, { items: [{ skuId: 42 }] });
  });
  it("keeps admin override consistent with shared scope resolution", async () => {
    mocks.fresh.mockResolvedValue({ id: 42, roles: ["admin"], channelScope: [], deptScope: [] });
    expect((await post(request())).status).toBe(200);
    expect(service).toHaveBeenCalledOnce();
  });
});
