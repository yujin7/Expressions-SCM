import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { approveCt, createCt, submitCt } from "@/server/modules/matflow/ct";
import { confirmInbound, createQc, createSh, getSh } from "@/server/modules/matflow/sh";
import { getBalance } from "@/server/posting";
import { getQcOutcome, raiseQcFailureOutcome } from "@/server/modules/quality/qc-outcome";
import { createTestDb, type TestDb } from "../helpers/db";

describe("采购收货保留采购行身份", () => {
  let db: TestDb, seq = 0;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(schema.approvalConfigs).values({ docType: "ct", approverRole: "warehouse" });
  });
  async function fixture() {
    const code = `PO-ID-${++seq}`;
    const [maker, checker] = await db.insert(schema.users).values([
      { name: code, roles: ["warehouse"] }, { name: code + "审批", roles: ["warehouse"], isApprover: true },
    ]).returning();
    const [spu] = await db.insert(schema.spus).values({ code, nameCn: code }).returning();
    const [sku, other] = await db.insert(schema.skus).values([
      { code, spuId: spu.id, name: code, skuType: "raw", baseUom: "kg" },
      { code: code + "-OTHER", spuId: spu.id, name: code, skuType: "raw", baseUom: "kg" },
    ]).returning();
    const [wh] = await db.insert(schema.warehouses).values({ code, name: code, kind: "raw", accountingMode: "realtime" }).returning();
    const [supplier] = await db.insert(schema.suppliers).values({ code, name: code, kinds: ["raw"] }).returning();
    const [po] = await db.insert(schema.poDocs).values({ docNo: code, status: "in_progress", supplierId: supplier.id, createdBy: maker.id }).returning();
    const lines = await db.insert(schema.poLines).values([
      { poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "袋", qty: "1", uomFactor: "0.1", price: "1" },
      { poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "袋", qty: "1", uomFactor: "0.3", price: "2" },
      { poId: po.id, skuId: other.id, lineType: "raw", purchaseUom: "kg", qty: "1", uomFactor: "1", price: "3", receivedQty: "1" },
    ]).returning();
    const actor = { id: maker.id, name: maker.name, roles: maker.roles, isApprover: false };
    const approver = { id: checker.id, name: checker.name, roles: checker.roles, isApprover: true };
    const input = { sourceType: "po", sourceId: po.id, warehouseId: wh.id };
    return { po, lines, sku, other, wh, actor, approver, input };
  }
  const received = async (f: Awaited<ReturnType<typeof fixture>>) => (await db.select().from(schema.poLines).where(eq(schema.poLines.poId, f.po.id)).orderBy(schema.poLines.id)).map(l => l.receivedQty);
  async function inspected(f: Awaited<ReturnType<typeof fixture>>, rows: Array<{ skuId: number; poLineId?: number; actualQty: string }>, concession = false) {
    const sh = await createSh(f.actor, { ...f.input, lines: rows }, db);
    // Isolated fixture starts after approval; business approval path is covered separately.
    await db.update(schema.shDocs).set({ status: "approved" }).where(eq(schema.shDocs.id, sh.id));
    const detail = await getSh(sh.id, db);
    await createQc(f.actor, { shId: sh.id, lines: detail.lines.map(l => ({ shLineId: l.id, passQty: concession ? "0" : l.actualQty, failQty: "0", concessionQty: concession ? l.actualQty : "0" })) }, db);
    return sh;
  }
  it("创建/明细保留显式第二采购行，不按同SKU吞掉身份", async () => {
    const f = await fixture();
    const sh = await createSh(f.actor, { ...f.input, lines: [{ skuId: f.sku.id, poLineId: f.lines[1].id, actualQty: "0.3" }] }, db);
    expect((await getSh(sh.id, db)).lines[0]).toMatchObject({ poLineId: f.lines[1].id });
  });
  it("同SKU多行而未选采购行时拒绝，未取号/建单/写审计", async () => {
    const f = await fixture();
    await expect(createSh(f.actor, { ...f.input, lines: [{ skuId: f.sku.id, actualQty: "0.3" }] }, db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("采购行") });
    expect(await db.select().from(schema.shDocs).where(eq(schema.shDocs.sourceId, f.po.id))).toHaveLength(0);
  });
  it("显式其他PO行或错误SKU不得回退到本PO首行", async () => {
    const f = await fixture(), other = await fixture();
    for (const poLineId of [other.lines[0].id, f.lines[2].id]) {
      await expect(createSh(f.actor, { ...f.input, lines: [{ skuId: f.sku.id, poLineId, actualQty: "0.1" }] }, db)).rejects.toMatchObject({ status: 400 });
    }
  });
  it("历史歧义入库整笔拒绝，QC仍可读但不伪造零可退或先开质量案件", async () => {
    const f = await fixture();
    const sh = await inspected(f, [{ skuId: f.sku.id, poLineId: f.lines[1].id, actualQty: "0.3" }], true);
    await db.update(schema.shLines).set({ poLineId: null }).where(eq(schema.shLines.shId, sh.id));
    await expect(confirmInbound(f.actor, sh.id, db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("多个采购行") });
    expect(await received(f)).toEqual(["0.0000", "0.0000", "1.0000"]);
    expect(await getBalance(db, f.sku.id, f.wh.id)).toBe("0");
    expect(await db.select().from(schema.stockLedger).where(and(eq(schema.stockLedger.sourceDocType, "sh_purchase_in"), eq(schema.stockLedger.sourceDocId, sh.id)))).toHaveLength(0);
    const outcome = await getQcOutcome(f.actor, sh.id, db);
    expect(outcome.lines[0]).toMatchObject({ poLineId: null, purchaseLineIssue: expect.stringContaining("多个采购行") });
    await expect(raiseQcFailureOutcome(f.actor, { shId: sh.id, createCase: true, createReturn: true }, db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("来源待核对") });
    expect(await db.select().from(schema.qualityCases).where(eq(schema.qualityCases.qcRecordId, outcome.qcId))).toHaveLength(0);
  });
  it("让步退货入口使用确切第二采购行，不借用首行可退量", async () => {
    const f = await fixture();
    const sh = await inspected(f, [{ skuId: f.sku.id, poLineId: f.lines[1].id, actualQty: "0.3" }], true);
    await confirmInbound(f.actor, sh.id, db);
    const outcome = await getQcOutcome(f.actor, sh.id, db);
    expect(outcome.lines[0]).toMatchObject({ poLineId: f.lines[1].id, poLineReceivedQty: "0.3000", returnableQty: "0.3000", purchaseLineIssue: null });
    const raised = await raiseQcFailureOutcome(f.actor, { shId: sh.id, createCase: false, createReturn: true }, db);
    expect((await db.select().from(schema.ctLines).where(eq(schema.ctLines.ctId, raised.returnCtId!)))[0]).toMatchObject({ poLineId: f.lines[1].id, qty: "0.3000" });
  });
  it("同采购行分批合并到该行，另一同SKU行不变；全收和退货仍守恒", async () => {
    const f = await fixture();
    const sh = await inspected(f, [
      { skuId: f.sku.id, poLineId: f.lines[1].id, actualQty: "0.1" },
      { skuId: f.sku.id, poLineId: f.lines[1].id, actualQty: "0.2" },
    ]);
    await confirmInbound(f.actor, sh.id, db);
    expect(await received(f)).toEqual(["0.0000", "0.3000", "1.0000"]);
    expect(await getBalance(db, f.sku.id, f.wh.id)).toBe("0.3000");
    const first = await inspected(f, [{ skuId: f.sku.id, poLineId: f.lines[0].id, actualQty: "0.1" }]);
    await confirmInbound(f.actor, first.id, db);
    expect(await received(f)).toEqual(["0.1000", "0.3000", "1.0000"]);
    expect((await db.select().from(schema.poDocs).where(eq(schema.poDocs.id, f.po.id)))[0].status).toBe("completed");
    await expect(confirmInbound(f.actor, sh.id, db)).rejects.toMatchObject({ status: 409 });
    const ct = await createCt(f.actor, { poId: f.po.id, warehouseId: f.wh.id, lines: [{ poLineId: f.lines[1].id, skuId: f.sku.id, qty: "0.2" }] }, db);
    const pending = await submitCt(f.actor, ct.id, ct.version, db);
    await approveCt(f.approver, ct.id, { action: "approve", version: pending.version }, db);
    expect(await received(f)).toEqual(["0.1000", "0.1000", "1.0000"]);
    expect(await getBalance(db, f.sku.id, f.wh.id)).toBe("0.2000");
    expect(await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "po"), eq(schema.auditLogs.entityId, f.po.id), eq(schema.auditLogs.action, "complete")))).toHaveLength(1);
  });
});
