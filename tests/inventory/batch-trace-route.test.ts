import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const h = vi.hoisted(() => ({ guard: vi.fn(), trace: vi.fn() }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: h.guard }));
vi.mock("@/server/modules/inventory/batch-trace", () => ({ traceBatch: h.trace }));
import { ApiError } from "@/server/modules/master/common";
import { GET } from "@/app/api/inventory/batch-trace/route";
const request = (query = "") => GET(new NextRequest(`http://localhost/api/inventory/batch-trace?sku=SKU&batch=LOT${query}`));
beforeEach(() => { vi.clearAllMocks(); h.guard.mockResolvedValue({ id: 1 }); h.trace.mockResolvedValue({ ledger: [], ledgerPage: { page: 1, pageSize: 30, total: 0 } }); });
it("passes explicit pagination through to the full-batch service", async () => {
  expect((await request("&page=7&pageSize=50")).status).toBe(200);
  expect(h.trace).toHaveBeenCalledWith("SKU", "LOT", undefined, { page: 7, pageSize: 50 });
});
it.each(["&page=0", "&page=-1", "&page=1.5", "&page=NaN", "&page=", "&page=1&page=2", "&pageSize=", "&pageSize=30&pageSize=100"])("malformed pagination %s fails visibly before reading", async query => {
  const result = await request(query); expect(result.status).toBe(400); expect(JSON.stringify(await result.json())).toContain("分页"); expect(h.trace).not.toHaveBeenCalled();
});
it("unauthenticated callers never read trace data", async () => {
  h.guard.mockRejectedValue(new ApiError(401, "请先登录")); expect((await request()).status).toBe(401); expect(h.trace).not.toHaveBeenCalled();
});
