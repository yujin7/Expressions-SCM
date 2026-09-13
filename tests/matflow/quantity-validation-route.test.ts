import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as flPost } from "@/app/api/matflow/fl/route";
import { PATCH as flPatch } from "@/app/api/matflow/fl/[id]/route";
import { POST as tlPost } from "@/app/api/matflow/tl/route";
import { PATCH as tlPatch } from "@/app/api/matflow/tl/[id]/route";
import { POST as shPost } from "@/app/api/matflow/sh/route";
import { POST as qcPost } from "@/app/api/matflow/sh/[id]/qc/route";
import { POST as ctPost } from "@/app/api/matflow/ct/route";

const h = vi.hoisted(() => ({ fresh: vi.fn(), db: vi.fn(), log: vi.fn(), persist: vi.fn() }));
vi.mock("@/server/modules/outsource/common", async original => ({
  ...await original<typeof import("@/server/modules/outsource/common")>(), guardFreshWrite: h.fresh, resolveDb: h.db,
}));
vi.mock("@/server/core/logger", async original => ({
  ...await original<typeof import("@/server/core/logger")>(), log: h.log, persistErrorLog: h.persist,
}));
beforeEach(() => {
  vi.clearAllMocks();
  h.fresh.mockResolvedValue({ id: 1, name: "仓管", roles: ["warehouse"], isApprover: false });
  h.db.mockRejectedValue(new Error("synthetic database failure"));
  h.persist.mockResolvedValue(undefined);
});

const ctx = { params: Promise.resolve({ id: "1" }) };
type Handler = (req: NextRequest, context: typeof ctx) => Promise<Response>;
type Case = { name: string; handler: Handler; method: string; field: string; body: Record<string, unknown>; line: Record<string, unknown> };
const cases: Case[] = [
  { name: "FL", handler: flPost, method: "POST", field: "qty", body: { jgId: 1, fromWarehouseId: 1 }, line: { skuId: 1, batchId: null } },
  { name: "FL correction", handler: flPatch, method: "PATCH", field: "qty", body: { version: 1, fromWarehouseId: 1, toWarehouseId: 2 }, line: { skuId: 1, batchId: null } },
  { name: "TL", handler: tlPost, method: "POST", field: "qty", body: { jgId: 1, toWarehouseId: 1 }, line: { skuId: 1, reason: "surplus_return" } },
  { name: "TL correction", handler: tlPatch, method: "PATCH", field: "qty", body: { version: 1, toWarehouseId: 1 }, line: { id: 1, reason: "surplus_return" } },
  ...["actualQty", "expectedQty"].map(field => ({ name: `SH ${field}`, handler: shPost, method: "POST", field, body: { sourceType: "po", sourceId: 1, warehouseId: 1 }, line: { skuId: 1, actualQty: "1", expectedQty: "1" } })),
  ...["passQty", "failQty", "concessionQty"].map(field => ({ name: `QC ${field}`, handler: qcPost, method: "POST", field, body: {}, line: { shLineId: 1, passQty: "1", failQty: "0", concessionQty: "0" } })),
  { name: "CT", handler: ctPost, method: "POST", field: "qty", body: { poId: 1, warehouseId: 1 }, line: { poLineId: 1, skuId: 1 } },
];
const request = (c: Case, value: unknown) => new NextRequest("http://localhost/api/matflow/test", {
  method: c.method, headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...c.body, lines: [{ ...c.line, [c.field]: value }] }),
});

it.each(cases)("$name rejects malformed quantity at the real service boundary before any business DB access", async c => {
  for (const value of ["abc", "NaN", "1e3", "", "1,000", "-0.0001"]) {
    const response = await c.handler(request(c, value), ctx);
    expect(response.status, String(value)).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining(`lines.0.${c.field}`) });
  }
  expect(h.fresh).toHaveBeenCalledTimes(6);
  expect(h.db).not.toHaveBeenCalled(); // No transaction, number, document, balance, ledger or audit.
  expect(h.log).not.toHaveBeenCalled();
  expect(h.persist).not.toHaveBeenCalled();
});

it.each(cases)("$name still exposes unexpected backend failures as 500, not false validation success", async c => {
  const response = await c.handler(request(c, "1"), ctx);
  expect(h.db).toHaveBeenCalledOnce();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: expect.stringContaining("系统错误"), errorId: expect.any(String) });
  expect(h.persist).toHaveBeenCalledOnce();
});

it("does not reveal quantity errors before authentication", async () => {
  const { ApiError } = await import("@/server/modules/master/common");
  h.fresh.mockRejectedValue(new ApiError(401, "未登录"));
  const response = await ctPost(request(cases[cases.length - 1], "abc"));
  expect(response.status).toBe(401);
  expect(h.db).not.toHaveBeenCalled();
});
