import { beforeAll, describe, expect, it } from "vitest";
import {
  boms, jgDocs, jsDocs, skus, spus, suppliers, users, warehouses, woDocs,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { getSettlementSummary } from "@/server/modules/report/settlement-summary";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * W5 结算汇总表：pending+completed JS 双向分组（bySupplier + docs），
 * 金额=js_docs 落库值直取；角色门禁 采购/PMC/财务（admin 兜底），运营/仓管 403。
 */
describe("结算汇总表 getSettlementSummary：分组、筛选与角色门禁", () => {
  let db: TestDb;
  let adminId = 0;
  let cp = 0;
  let bomId = 0;
  let supA = 0;
  let supB = 0;

  const finance: SessionUser = { id: 0, name: "财务", roles: ["finance"], isApprover: true };
  const ops: SessionUser = { id: 0, name: "运营", roles: ["ops"], isApprover: false };
  const wh: SessionUser = { id: 0, name: "仓管", roles: ["warehouse"], isApprover: false };
  const admin: SessionUser = { id: 0, name: "管理员", roles: ["admin"], isApprover: true };

  let seq = 0;

  async function mkJs(opts: {
    supplierId: number;
    status: "draft" | "pending" | "completed" | "void";
    feePayable: string;
    deductionTotal: string;
    settleAmount: string;
    createdAt?: Date;
  }) {
    seq += 1;
    const [wo] = await db
      .insert(woDocs)
      .values({
        docNo: `WO-SS-${seq}`, status: "completed", productSkuId: cp, qty: "100",
        supplierId: opts.supplierId, feeRatePlan: "2.00", bomId, createdBy: adminId,
      })
      .returning();
    const [jg] = await db
      .insert(jgDocs)
      .values({
        docNo: `JG-SS-${seq}`, status: "completed", woId: wo.id, supplierId: opts.supplierId,
        productSkuId: cp, qty: "100", feeRateCurrent: "2.00", createdBy: adminId,
      })
      .returning();
    const [js] = await db
      .insert(jsDocs)
      .values({
        docNo: `JS-SS-${seq}`, status: opts.status, jgId: jg.id,
        goodQty: "100", concessionQty: "10", spareQty: "5",
        feePayable: opts.feePayable, deductionTotal: opts.deductionTotal,
        settleAmount: opts.settleAmount, createdBy: adminId,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      })
      .returning();
    return { jsId: js.id, jsNo: js.docNo, jgNo: jg.docNo };
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [adminRow] = await db
      .insert(users)
      .values({ name: "管理员", roles: ["admin"], isApprover: true })
      .returning();
    adminId = adminRow.id;

    const [spu] = await db.insert(spus).values({ code: "P0SS", nameCn: "汇总测试产品" }).returning();
    const [s] = await db
      .insert(skus)
      .values({ code: "CPSS001", name: "汇总成品", spuId: spu.id, skuType: "finished", baseUom: "个" })
      .returning();
    cp = s.id;
    await db.insert(warehouses).values({ code: "WH-SS", name: "成品仓SS", kind: "finished" });
    const [bom] = await db
      .insert(boms)
      .values({ productSkuId: cp, versionNo: "V1", status: "active", effectiveDate: "2026-01-01" })
      .returning();
    bomId = bom.id;

    const [a] = await db
      .insert(suppliers)
      .values({ code: "SUPSSA", name: "汇总加工厂A", kinds: ["processor"], status: "qualified" })
      .returning();
    supA = a.id;
    const [b] = await db
      .insert(suppliers)
      .values({ code: "SUPSSB", name: "汇总加工厂B", kinds: ["processor"], status: "qualified" })
      .returning();
    supB = b.id;

    // supA：completed 2100−225=1875、pending 300−0.50=299.50；draft 999（不出表）
    await mkJs({
      supplierId: supA, status: "completed",
      feePayable: "2100.00", deductionTotal: "225.00", settleAmount: "1875.00",
      createdAt: new Date("2026-07-01T04:00:00Z"), // 上海 2026-07-01 12:00
    });
    await mkJs({
      supplierId: supA, status: "pending",
      feePayable: "300.00", deductionTotal: "0.50", settleAmount: "299.50",
      createdAt: new Date("2026-07-20T04:00:00Z"),
    });
    await mkJs({
      supplierId: supA, status: "draft",
      feePayable: "999.00", deductionTotal: "0.00", settleAmount: "999.00",
    });
    // supB：completed 88.88−8.88=80.00
    await mkJs({
      supplierId: supB, status: "completed",
      feePayable: "88.88", deductionTotal: "8.88", settleAmount: "80.00",
      createdAt: new Date("2026-06-15T04:00:00Z"),
    });
  });

  it("1) 双向分组：docs 仅 pending+completed；bySupplier 金额 decimal 累加", async () => {
    const res = await getSettlementSummary(finance, {}, db);
    expect(res.docs).toHaveLength(3); // draft 不出表
    expect(res.docs.every((d) => d.status === "pending" || d.status === "completed")).toBe(true);

    const a = res.bySupplier.find((r) => r.supplierId === supA)!;
    expect(a).toMatchObject({
      supplierName: "汇总加工厂A", jsCount: 2,
      feePayable: "2400.00", deductionTotal: "225.50", settleAmount: "2174.50",
    });
    const b = res.bySupplier.find((r) => r.supplierId === supB)!;
    expect(b).toMatchObject({ jsCount: 1, feePayable: "88.88", settleAmount: "80.00" });

    // docs 行字段完整（导出列的取数源）
    const doc = res.docs.find((d) => d.settleAmount === "1875.00")!;
    expect(doc.jsNo).toMatch(/^JS-SS-/);
    expect(doc.jgNo).toMatch(/^JG-SS-/);
    expect(doc.goodQty).toBe("100.0000");
    expect(doc.concessionQty).toBe("10.0000");
    expect(doc.spareQty).toBe("5.0000");
  });

  it("2) 筛选：时间窗（上海口径闭区间）、supplierId、status", async () => {
    // 只取 7 月 → supB 6 月单排除
    const july = await getSettlementSummary(finance, { from: "2026-07-01", to: "2026-07-31" }, db);
    expect(july.docs).toHaveLength(2);
    expect(july.bySupplier.map((r) => r.supplierId)).toEqual([supA]);

    // from=创建当日（上海 07-01）应含边界单
    const boundary = await getSettlementSummary(finance, { from: "2026-07-01", to: "2026-07-01" }, db);
    expect(boundary.docs).toHaveLength(1);
    expect(boundary.docs[0].settleAmount).toBe("1875.00");

    const bOnly = await getSettlementSummary(finance, { supplierId: supB }, db);
    expect(bOnly.docs).toHaveLength(1);
    expect(bOnly.bySupplier[0].jsCount).toBe(1);

    const pendingOnly = await getSettlementSummary(finance, { status: "pending" }, db);
    expect(pendingOnly.docs).toHaveLength(1);
    expect(pendingOnly.docs[0].settleAmount).toBe("299.50");

    await expect(getSettlementSummary(finance, { status: "draft" }, db)).rejects.toThrow(/无效的状态/);
  });

  it("3) 角色门禁：运营/仓管 403（金额报表整表拒绝）；采购/PMC/财务/admin 放行", async () => {
    for (const user of [ops, wh]) {
      const err = await getSettlementSummary(user, {}, db).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(403);
    }
    for (const roles of [["purchasing"], ["pmc"], ["finance"]]) {
      const u: SessionUser = { id: 0, name: "t", roles, isApprover: false };
      await expect(getSettlementSummary(u, {}, db)).resolves.toBeTruthy();
    }
    await expect(getSettlementSummary(admin, {}, db)).resolves.toBeTruthy();
  });
});
