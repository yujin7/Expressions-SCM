import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  auditLogs,
  bhDocs,
  boms,
  jgDocs,
  jsDocs,
  poDocs,
  qcRecords,
  shDocs,
  skus,
  spus,
  suppliers,
  users,
  warehouses,
  woDocs,
} from "@/db/schema";
import { getNextActions } from "@/server/modules/workbench/next-actions";
import { createTestDb, type TestDb } from "../helpers/db";

describe("C153 审计事件 → 当前状态 → 下一步建议", () => {
  let db: TestDb;
  let userId = 0;
  let supplierId = 0;
  let skuId = 0;
  let bomId = 0;
  let warehouseId = 0;
  let bhId = 0;
  let woId = 0;
  let poId = 0;
  let approvedJgId = 0;
  let shId = 0;
  let completedJgId = 0;

  const event = async (entity: string, entityId: number, action: string, minute: number) => {
    await db.insert(auditLogs).values({
      userId,
      entity,
      entityId,
      action,
      createdAt: new Date(`2026-07-27T00:${String(minute).padStart(2, "0")}:00Z`),
    });
  };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [user] = await db.insert(users).values({ name: "下一步测试员", roles: ["admin"] }).returning();
    userId = user.id;
    const [spu] = await db.insert(spus).values({ code: "NEXT-SPU", nameCn: "下一步测试品" }).returning();
    const [sku] = await db
      .insert(skus)
      .values({ code: "NEXT-SKU", name: "下一步测试品", spuId: spu.id, baseUom: "盒", skuType: "finished" })
      .returning();
    skuId = sku.id;
    const [supplier] = await db.insert(suppliers).values({ code: "NEXT-SUP", name: "下一步加工厂" }).returning();
    supplierId = supplier.id;
    const [warehouse] = await db
      .insert(warehouses)
      .values({ code: "NEXT-WH", name: "下一步成品仓", kind: "finished" })
      .returning();
    warehouseId = warehouse.id;
    const [bom] = await db.insert(boms).values({ productSkuId: skuId, versionNo: "NEXT-V1", status: "active" }).returning();
    bomId = bom.id;

    const [bh] = await db.insert(bhDocs).values({ docNo: "BH-NEXT", status: "approved", createdBy: userId }).returning();
    bhId = bh.id;

    const [wo] = await db
      .insert(woDocs)
      .values({
        docNo: "WO-NEXT",
        status: "approved",
        productSkuId: skuId,
        qty: "100",
        supplierId,
        feeRatePlan: "2",
        bomId,
        createdBy: userId,
      })
      .returning();
    woId = wo.id;

    const [po] = await db
      .insert(poDocs)
      .values({ docNo: "PO-NEXT", status: "approved", supplierId, createdBy: userId })
      .returning();
    poId = po.id;

    const [approvedWo] = await db
      .insert(woDocs)
      .values({
        docNo: "WO-JG-NEXT",
        status: "in_progress",
        productSkuId: skuId,
        qty: "100",
        supplierId,
        feeRatePlan: "2",
        bomId,
        createdBy: userId,
      })
      .returning();
    const [approvedJg] = await db
      .insert(jgDocs)
      .values({
        docNo: "JG-NEXT",
        status: "approved",
        woId: approvedWo.id,
        supplierId,
        productSkuId: skuId,
        qty: "100",
        feeRateCurrent: "2",
        createdBy: userId,
      })
      .returning();
    approvedJgId = approvedJg.id;

    const [sh] = await db
      .insert(shDocs)
      .values({
        docNo: "SH-NEXT",
        status: "approved",
        sourceType: "po",
        sourceId: poId,
        warehouseId,
        createdBy: userId,
      })
      .returning();
    shId = sh.id;

    const [closedWo] = await db
      .insert(woDocs)
      .values({
        docNo: "WO-JS-NEXT",
        status: "completed",
        productSkuId: skuId,
        qty: "100",
        supplierId,
        feeRatePlan: "2",
        bomId,
        createdBy: userId,
      })
      .returning();
    const [completedJg] = await db
      .insert(jgDocs)
      .values({
        docNo: "JG-JS-NEXT",
        status: "completed",
        woId: closedWo.id,
        supplierId,
        productSkuId: skuId,
        qty: "100",
        feeRateCurrent: "2",
        createdBy: userId,
      })
      .returning();
    completedJgId = completedJg.id;

    await Promise.all([
      event("bh", bhId, "approve", 1),
      event("wo", woId, "approve", 2),
      event("po", poId, "approve", 3),
      event("jg", approvedJgId, "approve", 4),
      event("sh", shId, "approve", 5),
      event("jg", completedJgId, "complete", 6),
    ]);

    // 当前状态相同但无审计触发证据：不得凭状态猜测事件。
    await db.insert(bhDocs).values({ docNo: "BH-NO-EVENT", status: "approved", createdBy: userId });
    // 驳回不是 approve：不得打开“审批后下一步”。
    const [rejected] = await db
      .insert(bhDocs)
      .values({ docNo: "BH-REJECT-EVENT", status: "approved", createdBy: userId })
      .returning();
    await event("bh", rejected.id, "reject", 7);
  });

  it("管理员得到六类动作；每条都有触发、责任、当前证据与可达链接", async () => {
    const rows = await getNextActions(["admin"], db);
    expect(rows.map((row) => row.ruleId).sort()).toEqual([
      "bh.create_wo",
      "jg.confirm_production",
      "jg.create_settlement",
      "po.confirm_due_date",
      "sh.finish_qc_inbound",
      "wo.generate_execution_docs",
    ]);
    for (const row of rows) {
      expect(row.triggerAt).toBeInstanceOf(Date);
      expect(row.ownerLabel).not.toBe("管理员");
      expect(row.evidence.length).toBeGreaterThan(8);
      expect(row.href).toMatch(/^\//);
    }
    expect(rows.some((row) => row.docNo === "BH-NO-EVENT")).toBe(false);
    expect(rows.some((row) => row.docNo === "BH-REJECT-EVENT")).toBe(false);
  });

  it("角色边界只返回本人有权执行的动作", async () => {
    expect((await getNextActions(["purchasing"], db)).map((row) => row.ruleId)).toEqual([
      "po.confirm_due_date",
    ]);
    expect((await getNextActions(["warehouse"], db)).map((row) => row.ruleId)).toEqual([
      "sh.finish_qc_inbound",
    ]);
    expect(await getNextActions(["pmc"], db)).toHaveLength(4);
    expect(await getNextActions(["ops"], db)).toEqual([]);
  });

  it("下游事实出现后自动消失；SH 有质检时只推进为入库，不重复建议质检", async () => {
    await db.insert(qcRecords).values({ shId, createdBy: userId, conclusion: "合格" });
    let warehouseRows = await getNextActions(["warehouse"], db);
    expect(warehouseRows).toHaveLength(1);
    expect(warehouseRows[0]).toMatchObject({
      actionLabel: "确认入库",
      evidence: "当前状态=已审批；质检记录=已存在",
    });

    await db.insert(woDocs).values({
      docNo: "WO-FROM-BH",
      status: "draft",
      bhId,
      productSkuId: skuId,
      qty: "100",
      supplierId,
      feeRatePlan: "2",
      bomId,
      createdBy: userId,
    });
    await db.insert(jgDocs).values({
      docNo: "JG-FROM-WO",
      status: "draft",
      woId,
      supplierId,
      productSkuId: skuId,
      qty: "100",
      feeRateCurrent: "2",
      createdBy: userId,
    });
    await db.update(poDocs).set({ confirmedAt: new Date() }).where(eq(poDocs.id, poId));
    await db.update(jgDocs).set({ confirmedAt: new Date() }).where(eq(jgDocs.id, approvedJgId));
    await db.update(shDocs).set({ status: "completed" }).where(eq(shDocs.id, shId));
    await db.insert(jsDocs).values({
      docNo: "JS-FROM-JG",
      jgId: completedJgId,
      goodQty: "100",
      feePayable: "200",
      settleAmount: "200",
      createdBy: userId,
    });

    expect(await getNextActions(["admin"], db)).toEqual([]);
  });
});
