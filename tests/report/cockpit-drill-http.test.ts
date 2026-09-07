import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/report/inventory-alerts/route";

const state = vi.hoisted(() => ({ role: "pmc" as string | null, db: vi.fn(), load: vi.fn(), refresh: vi.fn() }));
vi.mock("@/db", () => ({ getDbAsync: () => state.db() }));
vi.mock("@/server/modules/report/inventory-alerts", () => ({ loadInventoryAlerts: () => state.load(), refreshInventoryAlerts: () => state.refresh() }));
vi.mock("@/server/modules/master/common", async original => {
  const common = await original<typeof import("@/server/modules/master/common")>();
  return { ...common, guardRead: async () => { if (!state.role) throw new common.ApiError(401, "请先登录"); return { id: 1, roles: [state.role], name: "QA", isApprover: false }; } };
});
vi.mock("@/server/modules/outsource/common", async original => {
  const common = await original<typeof import("@/server/modules/outsource/common")>();
  return { ...common, guardFreshWrite: async () => ({ id: 1, roles: [state.role], name: "QA", isApprover: false }) };
});
const get = (q: string) => GET(new NextRequest(`http://localhost/api/report/inventory-alerts?${q}`));
beforeEach(() => {
  state.role = "pmc"; state.db.mockReset().mockResolvedValue({}); state.load.mockReset(); state.refresh.mockReset();
  state.load.mockResolvedValue({ rows: [
    { skuId: 1, code: "A", name: "同名", tier: "A", status: "alert", primary: "out_of_stock" },
    { skuId: 2, code: "B", name: "同名", tier: "B", status: "ok", primary: null },
    { skuId: 3, code: "C", name: "同名", tier: "C", status: "watch", primary: null },
  ], totals: { alert: 1, watch: 1, outOfStock: 1 } });
});
it("HTTP propagates counted coverage state before pagination, including explicitly requested C tier", async () => {
  const response = await get("status=watch&showC=1&onlyAlert=0&pageSize=1"); expect(response.status).toBe(200);
  const data = await response.json(); expect(data.rows.map((r: { code: string }) => r.code)).toEqual(["C"]);
  expect(data.filtered.total).toBe(data.totals.watch); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});
it("invalid status refuses before database access or cache recomputation", async () => {
  expect((await get("status=watc&refresh=1")).status).toBe(400);
  expect(state.db).not.toHaveBeenCalled(); expect(state.refresh).not.toHaveBeenCalled(); expect(state.load).not.toHaveBeenCalled();
});
it("new drill parameters do not bypass anonymous refusal or privileged recomputation", async () => {
  state.role = null; expect((await get("status=watch")).status).toBe(401);
  state.role = "warehouse"; expect((await get("status=watch&refresh=1")).status).toBe(403);
  expect(state.db).not.toHaveBeenCalled();
});
