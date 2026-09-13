import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/matflow/tl/return-lots/route";
import { ApiError } from "@/server/modules/master/common";
const h = vi.hoisted(() => ({ fresh: vi.fn(), read: vi.fn(), user: { id: 1, name: "仓管", roles: ["warehouse"], isApprover: false } }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: h.fresh }));
vi.mock("@/server/modules/matflow/return-lots", () => ({ listTlReturnLots: h.read }));
beforeEach(() => { h.fresh.mockReset().mockResolvedValue(h.user); h.read.mockReset().mockResolvedValue({ rows: [], total: 0 }); });
const req = (query: string) => new NextRequest(`http://localhost/api/matflow/tl/return-lots?${query}`);
it("fresh identity, bounded scope and exact remote selection reach service without cache", async () => {
  const response = await GET(req('jgId=1&warehouseId=2&skuId=3&selectedValues=%5B4,%22unbatched%22%5D'));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(h.read).toHaveBeenCalledWith(h.user, expect.objectContaining({ jgId: 1, warehouseId: 2, skuId: 3, page: 1, pageSize: 50, ids: ["4", "unbatched"] }));
});
it.each(["", "jgId=1&warehouseId=2&skuId=3&skuId=4", "jgId=1&warehouseId=2&skuId=3&all=1", "jgId=1&warehouseId=2&skuId=3&pageSize=51", "jgId=1&warehouseId=2&skuId=3&selectedValues=bad", 'jgId=1&warehouseId=2&skuId=3&selectedValues=%5B%22guess%22%5D'])("rejects invalid query %s", async q => {
  expect((await GET(req(q))).status).toBe(400); expect(h.read).not.toHaveBeenCalled();
});
it("missing current session cannot read lots", async () => {
  h.fresh.mockRejectedValueOnce(new ApiError(401, "重新登录"));
  expect((await GET(req("jgId=1&warehouseId=2&skuId=3"))).status).toBe(401); expect(h.read).not.toHaveBeenCalled();
});
