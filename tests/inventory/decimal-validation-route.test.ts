import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as stockPost } from "@/app/api/inventory/stock-doc/route";
import { POST as countPost } from "@/app/api/inventory/count/[id]/lines/route";
import { POST as replenishPost } from "@/app/api/replenish/draft/route";
import { createReplenishDraft } from "@/server/modules/replenish/service";
import { ApiError } from "@/server/modules/master/common";
import { TRANSFER_TYPES } from "@/lib/transfer-types";

const h = vi.hoisted(() => ({ fresh: vi.fn(), db: vi.fn(), createBh: vi.fn(), log: vi.fn(), persist: vi.fn() }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: h.fresh }));
vi.mock("@/server/core/svc", async original => ({ ...await original<typeof import("@/server/core/svc")>(), resolveDb: h.db }));
vi.mock("@/server/modules/outsource/bh-create-request", async original => ({ ...await original<typeof import("@/server/modules/outsource/bh-create-request")>(), createBhRequest: h.createBh }));
vi.mock("@/server/core/logger", async original => ({ ...await original<typeof import("@/server/core/logger")>(), log: h.log, persistErrorLog: h.persist }));
const user = { id: 1, name: "合成仓管计划员", roles: ["warehouse", "pmc"], isApprover: false };
beforeEach(() => {
  vi.clearAllMocks(); h.fresh.mockResolvedValue(user);
  h.db.mockRejectedValue(new Error("synthetic database failure"));
  h.createBh.mockRejectedValue(new Error("synthetic request persistence failure"));
  h.persist.mockResolvedValue(undefined);
});
const ctx = { params: Promise.resolve({ id: "1" }) };
type Handler = (req: NextRequest, context: typeof ctx) => Promise<Response>;
type Case = { name: string; handler: Handler; boundary: "db" | "createBh"; body: (value: unknown) => unknown; path: string };
const cases: Case[] = [
  ...["opening", "issue_out", "sales_out", "transfer"].map(subtype => ({ name: `stock ${subtype} quantity`, handler: stockPost, boundary: "db" as const, path: "lines.0.qty",
    body: (qty: unknown) => ({ subtype, warehouseId: 1, ...(subtype === "transfer" ? { toWarehouseId: 2, transferType: TRANSFER_TYPES[0] } : {}), lines: [{ skuId: 1, qty }] }) })),
  { name: "opening price", handler: stockPost, boundary: "db", path: "lines.0.price", body: price => ({ subtype: "opening", warehouseId: 1, lines: [{ skuId: 1, qty: "1", price }] }) },
  { name: "counted quantity", handler: countPost, boundary: "db", path: "lines.0.countedQty", body: countedQty => ({ version: 1, lines: [{ lineId: 1, countedQty }] }) },
  { name: "replenishment quantity", handler: replenishPost, boundary: "createBh", path: "items.0.qty", body: qty => ({ requestKey: "93213c9b-7b03-401e-99df-f8b92fbed748", items: [{ skuId: 1, qty }] }) },
];
const request = (body: unknown) => new NextRequest("http://localhost/api/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
it.each(cases)("$name: real route/schema rejects before business persistence", async c => {
  for (const value of ["abc", "NaN", "1e3", "", "1,000", "-0.0001"]) {
    const response = await c.handler(request(c.body(value)), ctx);
    expect(response.status, String(value)).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining(c.path) });
  }
  expect(h.fresh).toHaveBeenCalledTimes(6);
  expect(h.db).not.toHaveBeenCalled(); expect(h.createBh).not.toHaveBeenCalled();
  expect(h.log).not.toHaveBeenCalled(); expect(h.persist).not.toHaveBeenCalled();
});
it.each(cases)("$name: valid input reaches persistence and unexpected failures still produce 500", async c => {
  const response = await c.handler(request(c.body("1")), ctx);
  expect(h[c.boundary]).toHaveBeenCalledOnce(); expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ errorId: expect.any(String) }); expect(h.persist).toHaveBeenCalledOnce();
});
it.each(cases)("$name: unauthenticated requests cannot expose field details", async c => {
  h.fresh.mockRejectedValue(new ApiError(401, "未登录"));
  const response = await c.handler(request(c.body("abc")), ctx);
  expect(response.status).toBe(401); expect(h.db).not.toHaveBeenCalled(); expect(h.createBh).not.toHaveBeenCalled();
});
it("direct replenishment service also rejects malformed input before any DB operation", async () => {
  for (const qty of ["abc", "1e3", ""]) await expect(createReplenishDraft(user, { items: [{ skuId: 1, qty }] })).rejects.toMatchObject({ name: "ZodError" });
  expect(h.db).not.toHaveBeenCalled();
});
