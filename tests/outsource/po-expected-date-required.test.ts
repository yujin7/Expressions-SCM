import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { poDocs, poLines, skus, spus, suppliers, sysParams, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { submitPo } from "@/server/modules/outsource/po";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * D63：PO 提交须填承诺交期（OTIF 可评前提），由 sys_params po_expected_date_required 开关（缺省 0 不强制）。
 * 表头有交期或全部行有行交期任一满足即可。
 */
describe("submitPo 承诺交期必填开关", () => {
  let db: TestDb;
  let buyer: SessionUser;
  let poId = 0;
  let line1 = 0;
  let line2 = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [user] = await db.insert(users).values({ username: "exp_buyer", name: "采购", roles: ["purchasing"], isApprover: true }).returning();
    buyer = { id: user.id, name: user.name, roles: ["purchasing"], isApprover: true };
    const [supplier] = await db.insert(suppliers).values({ code: "EXP-SUP", name: "交期供应商", kinds: ["raw"], status: "qualified" }).returning();
    const [spu] = await db.insert(spus).values({ code: "EXP-SPU", nameCn: "交期产品" }).returning();
    const [sku] = await db.insert(skus).values({ spuId: spu.id, code: "EXP-SKU", name: "交期物料", skuType: "raw", baseUom: "kg" }).returning();
    const [po] = await db.insert(poDocs).values({ docNo: "PO-EXP-1", status: "draft", supplierId: supplier.id, createdBy: user.id }).returning();
    poId = po.id;
    const lines = await db.insert(poLines).values([
      { poId, skuId: sku.id, lineType: "raw", purchaseUom: "kg", qty: "10", price: "2" },
      { poId, skuId: sku.id, lineType: "raw", purchaseUom: "kg", qty: "5", price: "2" },
    ]).returning();
    line1 = lines[0].id;
    line2 = lines[1].id;
  });

  it("开关缺省关闭：无交期也可提交", async () => {
    const r = await submitPo(buyer, poId, 1, db);
    expect(r.status).toBe("pending");
  });

  it("开关开启：表头与行都缺交期 → 409 并保持草稿；补齐行交期后放行", async () => {
    await db.insert(sysParams).values({ scope: "global", key: "po_expected_date_required", value: "1" });
    await expect(submitPo(buyer, poId, 1, db)).rejects.toMatchObject({ status: 409 });
    const [still] = await db.select().from(poDocs).where(eq(poDocs.id, poId));
    expect(still.status).toBe("draft");

    await db.update(poLines).set({ expectedDate: "2026-10-01" }).where(eq(poLines.id, line1));
    await expect(submitPo(buyer, poId, 1, db)).rejects.toMatchObject({ status: 409 }); // 仍有一行缺
    await db.update(poLines).set({ expectedDate: "2026-10-05" }).where(eq(poLines.id, line2));
    const r = await submitPo(buyer, poId, 1, db);
    expect(r.status).toBe("pending");
  });

  it("开关开启：表头有交期即可（行交期可空）", async () => {
    await db.insert(sysParams).values({ scope: "global", key: "po_expected_date_required", value: "1" });
    await db.update(poDocs).set({ expectedDate: "2026-10-01" }).where(eq(poDocs.id, poId));
    const r = await submitPo(buyer, poId, 1, db);
    expect(r.status).toBe("pending");
  });
});
