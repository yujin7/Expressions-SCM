/**
 * W2-A 三条 API 的角色门禁（审阅 must-fix）：金额类读模型对非 PRICE_VISIBLE_ROLES 403；
 * ?refresh=1 与销售金额写路径回查会话并按角色 403。服务层全部 mock，只测路由层门禁与错误映射。
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guardRead: vi.fn(),
  guardFreshWrite: vi.fn(),
  loadRatio: vi.fn(),
  refreshRatio: vi.fn(),
  loadPosition: vi.fn(),
  refreshPosition: vi.fn(),
  listSales: vi.fn(),
  prefill: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("@/db", () => ({ getDbAsync: vi.fn(async () => ({})) }));
vi.mock("@/server/modules/master/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/common")>();
  return { ...original, guardRead: mocks.guardRead };
});
vi.mock("@/server/modules/outsource/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/outsource/common")>();
  return { ...original, guardFreshWrite: mocks.guardFreshWrite };
});
vi.mock("@/server/modules/report/inventory-sales-ratio", () => ({
  loadInventorySalesRatio: mocks.loadRatio,
  refreshInventorySalesRatio: mocks.refreshRatio,
}));
vi.mock("@/server/modules/report/inventory-position", () => ({
  loadInventoryPosition: mocks.loadPosition,
  refreshInventoryPosition: mocks.refreshPosition,
}));
vi.mock("@/server/modules/master/sales-amount", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/sales-amount")>();
  return { ...original, listSalesAmountMonthly: mocks.listSales, prefillFromObservation: mocks.prefill, upsertSalesAmountMonthly: mocks.upsert };
});

import { GET as ratioGet } from "@/app/api/report/inventory-sales-ratio/route";
import { GET as positionGet } from "@/app/api/report/inventory-position/route";
import { GET as salesGet, POST as salesPost } from "@/app/api/master/sales-amount/route";

const warehouse = { id: 2, name: "仓管", roles: ["warehouse"], isApprover: false, sessionVersion: 1 };
const finance = { id: 3, name: "财务", roles: ["finance"], isApprover: false, sessionVersion: 1 };

describe("W2-A 路由门禁", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadRatio.mockResolvedValue({ key: "inventory-sales-ratio/v1", rows: [], current: { salesAmount: null }, target: { low: 45, high: 47, baseline: 50 } });
    mocks.loadPosition.mockResolvedValue({ key: "inventory-position/v1", monthEnd: [{ yearMonth: "2026-07" }, { yearMonth: "2026-08" }, { yearMonth: "2026-09", isCurrent: true }], daily: [], current: {}, warehouses: [] });
    mocks.refreshPosition.mockResolvedValue({ key: "inventory-position/v1", monthEnd: [], daily: [], current: {}, warehouses: [] });
    mocks.prefill.mockResolvedValue({ state: "insufficient" });
    mocks.listSales.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 20 });
  });

  it("库存占比：仓库角色 403，财务 200", async () => {
    mocks.guardRead.mockResolvedValue(warehouse);
    const denied = await ratioGet(new NextRequest("http://localhost/api/report/inventory-sales-ratio"));
    expect(denied.status).toBe(403);
    mocks.guardRead.mockResolvedValue(finance);
    const ok = await ratioGet(new NextRequest("http://localhost/api/report/inventory-sales-ratio"));
    expect(ok.status).toBe(200);
    expect(mocks.loadRatio).toHaveBeenCalledTimes(1);
  });

  it("库存日级：读取全员可用且 ?months= 只切片不打穿缓存；?refresh=1 对仓库角色 403", async () => {
    mocks.guardRead.mockResolvedValue(warehouse);
    const res = await positionGet(new NextRequest("http://localhost/api/report/inventory-position?months=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.monthEnd.map((m: { yearMonth: string }) => m.yearMonth)).toEqual(["2026-08", "2026-09"]);
    expect(mocks.loadPosition).toHaveBeenCalledWith(expect.anything());
    mocks.guardFreshWrite.mockResolvedValue(warehouse);
    const denied = await positionGet(new NextRequest("http://localhost/api/report/inventory-position?refresh=1"));
    expect(denied.status).toBe(403);
    expect(mocks.refreshPosition).not.toHaveBeenCalled();
  });

  it("销售金额：预填与写入对仓库角色 403，服务不被调用", async () => {
    mocks.guardRead.mockResolvedValue(warehouse);
    mocks.guardFreshWrite.mockResolvedValue(warehouse);
    const prefillDenied = await salesGet(new NextRequest("http://localhost/api/master/sales-amount?prefill=1&yearMonth=2026-08"));
    expect(prefillDenied.status).toBe(403);
    expect(mocks.prefill).not.toHaveBeenCalled();
    const postDenied = await salesPost(new NextRequest("http://localhost/api/master/sales-amount", { method: "POST", body: JSON.stringify({ yearMonth: "2026-08", scopeKind: "company", amount: "1.00" }), headers: { "content-type": "application/json" } }));
    expect(postDenied.status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
