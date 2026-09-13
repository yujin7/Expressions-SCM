import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/inventory/expiry-check/route";
import { ApiError } from "@/server/modules/master/common";
const h = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: h.auth }));
vi.mock("@/server/modules/replenish/expiry", () => ({ expiryCheck: h.read }));
beforeEach(() => { h.auth.mockReset().mockResolvedValue({ id: 1, roles: ["warehouse"] }); h.read.mockReset().mockResolvedValue({ items: [] }); });
const req = (q: string) => new NextRequest(`http://localhost/api/inventory/expiry-check?${q}`);
it.each(["", "skuIds=", "skuIds=1,bad", "skuIds=0", "skuIds=1,", "skuIds=1e2", "skuIds=2147483648", "skuIds=1&warehouseId=", "skuIds=1&warehouseId=0", "skuIds=1&warehouseId=no", "skuIds=1&warehouseId=1.5", "skuIds=1&warehouseId=2147483648", "skuIds=1&warehouseId=1&warehouseId=2", "skuIds=1&skuIds=2", "skuIds=1&today=2000-01-01"])("invalid scope returns 400 rather than all warehouses: %s", async query => {
  const r = await GET(req(query)); expect(r.status).toBe(400); expect(r.headers.get("cache-control")).toBe("no-store"); expect(h.read).not.toHaveBeenCalled();
});
it("supports deliberate all-warehouse reads, exact warehouse and duplicate SKU normalization", async () => {
  expect((await GET(req("skuIds=1,1,2"))).status).toBe(200); expect(h.read).toHaveBeenLastCalledWith({ skuIds: [1, 2], warehouseId: null });
  const r = await GET(req("skuIds=1&warehouseId=2")); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store"); expect(h.read).toHaveBeenLastCalledWith({ skuIds: [1], warehouseId: 2 });
});
it("rejects 201 values instead of silently returning 200", async () => {
  expect((await GET(req(`skuIds=${Array.from({ length: 201 }, (_, i) => i + 1)}`))).status).toBe(400); expect(h.read).not.toHaveBeenCalled();
});
it("auth precedes parsing and service access", async () => {
  h.auth.mockRejectedValue(new ApiError(401, "未登录")); expect((await GET(req("skuIds=bad"))).status).toBe(401); expect(h.read).not.toHaveBeenCalled();
});
