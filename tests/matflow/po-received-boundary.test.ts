import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { approveCt } from "@/server/modules/matflow/ct";
import { confirmInbound, createQc } from "@/server/modules/matflow/sh";
import { getBalance } from "@/server/posting";
import { createTestDb, type TestDb } from "../helpers/db";

describe("采购收退货共享已收数边界", () => {
  let db: TestDb, seq = 0;
  const queries: string[] = [];
  beforeAll(async () => {
    const { client } = await createTestDb();
    db = drizzle(client, { schema, logger: { logQuery(query) { queries.push(query); } } });
    await db.insert(schema.approvalConfigs).values({ docType: "ct", approverRole: "warehouse" });
  });
  async function fixture(qty = "0.3") {
    const code = `PR-${++seq}`;
    const [maker, checker] = await db.insert(schema.users).values([
      { name: code, roles: ["warehouse"] }, { name: `${code}-审批`, roles: ["warehouse"], isApprover: true },
    ]).returning();
    const [spu] = await db.insert(schema.spus).values({ code, nameCn: code }).returning();
    const [sku] = await db.insert(schema.skus).values({ code, spuId: spu.id, name: code, skuType: "raw", baseUom: "kg" }).returning();
    const [wh] = await db.insert(schema.warehouses).values({ code, name: code, kind: "raw", accountingMode: "realtime" }).returning();
    const [supplier] = await db.insert(schema.suppliers).values({ code, name: code, kinds: ["raw"] }).returning();
    const [po] = await db.insert(schema.poDocs).values({ docNo: `PO-${code}`, status: "in_progress", supplierId: supplier.id, createdBy: maker.id }).returning();
    const [line] = await db.insert(schema.poLines).values({ poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", qty, uomFactor: "1", price: "1" }).returning();
    const actor = { id: maker.id, name: maker.name, roles: maker.roles, isApprover: false };
    const approver = { id: checker.id, name: checker.name, roles: checker.roles, isApprover: true };
    return { code, sku, wh, po, line, actor, approver };
  }
  async function receipt(f: Awaited<ReturnType<typeof fixture>>, qty: string) {
    const [sh] = await db.insert(schema.shDocs).values({ docNo: `SH-${++seq}`, status: "approved", sourceType: "po", sourceId: f.po.id, warehouseId: f.wh.id, createdBy: f.actor.id }).returning();
    const [line] = await db.insert(schema.shLines).values({ shId: sh.id, skuId: f.sku.id, actualQty: qty }).returning();
    await createQc(f.actor, { shId: sh.id, lines: [{ shLineId: line.id, passQty: qty, failQty: "0", concessionQty: "0" }] }, db);
    return sh;
  }
  async function returnDoc(f: Awaited<ReturnType<typeof fixture>>, qty: string) {
    const [ct] = await db.insert(schema.ctDocs).values({ docNo: `CT-${++seq}`, status: "pending", poId: f.po.id, warehouseId: f.wh.id, createdBy: f.actor.id }).returning();
    await db.insert(schema.ctLines).values({ ctId: ct.id, poLineId: f.line.id, skuId: f.sku.id, qty });
    return ct;
  }
  function expectPurchaseLocksBeforeStock() {
    const header = queries.findIndex(q => q.includes('from "po_docs"') && q.endsWith("for update"));
    const lines = queries.findIndex(q => q.includes('from "po_lines"') && q.includes('order by "po_lines"."id"') && q.endsWith("for update"));
    // The warehouse lock now also reads the fresh execution kind. Match compiled SQL,
    // rather than requiring the old raw SELECT spelling that read kind before locking.
    const warehouseLocks = queries.filter(q => q.includes('from "warehouses"') && q.endsWith("for update"));
    const stock = queries.findIndex(q => q.includes('from "warehouses"') && q.includes('"kind"') && q.endsWith("for update"));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(lines).toBeGreaterThan(header);
    expect(stock).toBeGreaterThan(lines);
    expect(queries[stock]).toContain('"kind"');
    expect(queries[stock]).toContain('order by "warehouses"."id"');
    expect(warehouseLocks.every(q => q.includes('order by "warehouses"."id"'))).toBe(true);
  }
  const received = async (id: number) => (await db.select().from(schema.poLines).where(eq(schema.poLines.id, id)))[0].receivedQty;

  it("SH编译查询按PO头→有序PO行→库存锁；0.1+0.2全收只完成一次", async () => {
    const f = await fixture(), a = await receipt(f, "0.1"), b = await receipt(f, "0.2");
    queries.length = 0;
    await confirmInbound(f.actor, a.id, db);
    expectPurchaseLocksBeforeStock();
    await confirmInbound(f.actor, b.id, db);
    expect(await received(f.line.id)).toBe("0.3000");
    expect(await getBalance(db, f.sku.id, f.wh.id)).toBe("0.3000");
    expect((await db.select().from(schema.poDocs).where(eq(schema.poDocs.id, f.po.id)))[0].status).toBe("completed");
    expect(await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "po"), eq(schema.auditLogs.entityId, f.po.id), eq(schema.auditLogs.action, "complete")))).toHaveLength(1);
  });

  it("CT同顺序锁PO；审批重放不重复减数，第二张超额拒绝", async () => {
    const f = await fixture("1"), sh = await receipt(f, "0.3");
    await confirmInbound(f.actor, sh.id, db);
    const a = await returnDoc(f, "0.2"), b = await returnDoc(f, "0.2");
    queries.length = 0;
    const input = { action: "approve", version: a.version };
    await approveCt(f.approver, a.id, input, db);
    expectPurchaseLocksBeforeStock();
    expect(await approveCt(f.approver, a.id, input, db)).toMatchObject({ idempotent: true });
    await expect(approveCt(f.approver, b.id, { action: "approve", version: b.version }, db)).rejects.toMatchObject({ status: 409 });
    expect(await received(f.line.id)).toBe("0.1000");
    expect(await getBalance(db, f.sku.id, f.wh.id)).toBe("0.1000");
    expect(await db.select().from(schema.approvals).where(and(eq(schema.approvals.docType, "ct"), eq(schema.approvals.docId, b.id)))).toHaveLength(0);
  });

  it("历史CT行若挂到另一PO则整笔拒绝，不能扣其他订单已收数", async () => {
    const f = await fixture(), g = await fixture(), sh = await receipt(g, "0.3");
    await confirmInbound(g.actor, sh.id, db);
    const ct = await returnDoc(f, "0.1");
    await db.update(schema.ctLines).set({ poLineId: g.line.id, skuId: g.sku.id }).where(eq(schema.ctLines.ctId, ct.id));
    await expect(approveCt(f.approver, ct.id, { action: "approve", version: ct.version }, db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("不匹配") });
    expect(await received(g.line.id)).toBe("0.3000");
  });

  it.each(["sh", "ct"] as const)("%s末尾审计失败回滚订单累计、库存和单据状态", async (entity) => {
    const f = await fixture(), sh = await receipt(f, "0.3");
    if (entity === "ct") await confirmInbound(f.actor, sh.id, db);
    const ct = entity === "ct" ? await returnDoc(f, "0.1") : null;
    await db.execute(sql`CREATE FUNCTION pr_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (NEW.entity='sh' AND NEW.action='inbound') OR (NEW.entity='ct' AND NEW.action='post_and_complete') THEN RAISE EXCEPTION 'synthetic end audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER pr_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION pr_reject_audit()`);
    try {
      const write = () => ct ? approveCt(f.approver, ct.id, { action: "approve", version: ct.version }, db) : confirmInbound(f.actor, sh.id, db);
      await expect(write()).rejects.toThrow();
      expect(await received(f.line.id)).toBe(ct ? "0.3000" : "0.0000");
      expect(await getBalance(db, f.sku.id, f.wh.id)).toBe(ct ? "0.3000" : "0");
      const sourceType = ct ? "ct_return" : "sh_purchase_in";
      expect(await db.select().from(schema.stockLedger).where(and(eq(schema.stockLedger.sourceDocType, sourceType), eq(schema.stockLedger.sourceDocId, ct?.id ?? sh.id)))).toHaveLength(0);
      if (ct) expect((await db.select().from(schema.ctDocs).where(eq(schema.ctDocs.id, ct.id)))[0].status).toBe("pending");
      else expect((await db.select().from(schema.shDocs).where(eq(schema.shDocs.id, sh.id)))[0].status).toBe("approved");
    } finally {
      await db.execute(sql`DROP TRIGGER pr_audit ON audit_logs`);
      await db.execute(sql`DROP FUNCTION pr_reject_audit()`);
    }
  });
});
