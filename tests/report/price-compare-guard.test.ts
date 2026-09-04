/**
 * 物料比价（/api/report/price-compare）的角色门禁。
 *
 * 事故背景（2026-09-04 审计）：本报表逐行返回每家供应商的采购基准价
 * （`quotes[].price` / `bestPrice` / `worstPrice`，属 R9 敏感金额），路由却只有 `guardRead()`——
 * 任何登录用户（仓管、运营）打开 /report/price-compare 就能看到全部供应商报价。
 * 同一套系统里 /master/feeref（加工费参考价）对仓管是 403，两个价格页两种口径。
 *
 * 这里钉住：仓管 403 / 财务 200，且响应必须过 maskSensitive（前端隐藏不算数）。
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guardFreshWrite: vi.fn(),
  getPriceCompare: vi.fn(),
}));
vi.mock("@/db", () => ({ getDbAsync: vi.fn(async () => ({})) }));
vi.mock("@/server/modules/outsource/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/outsource/common")>();
  return { ...original, guardFreshWrite: mocks.guardFreshWrite };
});
vi.mock("@/server/modules/report/price-compare", () => ({ getPriceCompare: mocks.getPriceCompare }));

import { GET } from "@/app/api/report/price-compare/route";

const warehouse = { id: 2, name: "仓管", roles: ["warehouse"], isApprover: false, sessionVersion: 1 };
const ops = { id: 4, name: "运营", roles: ["ops"], isApprover: false, sessionVersion: 1 };
const finance = { id: 3, name: "财务", roles: ["finance"], isApprover: false, sessionVersion: 1 };
const purchasing = { id: 5, name: "采购", roles: ["purchasing"], isApprover: false, sessionVersion: 1 };

const url = "http://localhost/api/report/price-compare?page=1&pageSize=20";

describe("物料比价路由门禁", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPriceCompare.mockResolvedValue({
      rows: [{
        skuId: 1, code: "RM001", name: "原料A", supplierCount: 2,
        bestPrice: "10.00", worstPrice: "12.00",
        quotes: [{ supplierId: 1, supplierName: "甲", price: "10.00" }],
      }],
      total: 1,
    });
  });

  it("仓管 / 运营拿不到供应商报价（403），服务层根本不被调用", async () => {
    for (const user of [warehouse, ops]) {
      mocks.guardFreshWrite.mockResolvedValue(user);
      const res = await GET(new NextRequest(url));
      expect(res.status, `${user.name} 应被拒绝`).toBe(403);
    }
    expect(mocks.getPriceCompare).not.toHaveBeenCalled();
  });

  it("采购 / 财务 200 且看得到价格", async () => {
    for (const user of [purchasing, finance]) {
      mocks.guardFreshWrite.mockResolvedValue(user);
      const res = await GET(new NextRequest(url));
      expect(res.status, `${user.name} 应放行`).toBe(200);
      const body = await res.json();
      expect(body.rows[0].bestPrice).toBe("10.00");
      expect(body.rows[0].quotes[0].price).toBe("10.00");
    }
  });

  it("金额报表必须回查新鲜身份（停用/降权立即生效），不得退回 guardRead", async () => {
    mocks.guardFreshWrite.mockResolvedValue(finance);
    await GET(new NextRequest(url));
    expect(mocks.guardFreshWrite).toHaveBeenCalled();
  });
});
