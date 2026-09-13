import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as s from "@/db/schema";
import { approveCt, createCt, getCt, submitCt } from "@/server/modules/matflow/ct";
import { listCtReturnLots } from "@/server/modules/matflow/return-lots";
import { createCtSchema } from "@/server/modules/matflow/schemas";
import { post, getBalance } from "@/server/posting";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, n = 0;
beforeAll(async () => {
  f = await createTestDb();
  await f.db.insert(s.approvalConfigs).values({ docType: "ct", approverRole: "warehouse" });
  await f.db.insert(s.sysParams).values({ scope: "global", key: "batch_posting_enabled", value: "1" });
});
afterAll(async () => f?.client.close());
async function fixture() {
  const db = f.db, code = `CT-PHYSICAL-${++n}`;
  const [maker, checker] = await db.insert(s.users).values([{ name: code, roles: ["warehouse"] }, { name: code + "-复核", roles: ["warehouse"], isApprover: true }]).returning();
  const [spu] = await db.insert(s.spus).values({ code, nameCn: code }).returning();
  const [sku] = await db.insert(s.skus).values({ code, name: code, spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
  const [sup] = await db.insert(s.suppliers).values({ code, name: code }).returning();
  const [wh] = await db.insert(s.warehouses).values({ code, name: code, kind: "raw", accountingMode: "realtime" }).returning();
  const [po] = await db.insert(s.poDocs).values({ docNo: code, supplierId: sup.id, status: "completed", createdBy: maker.id }).returning();
  const [line] = await db.insert(s.poLines).values({ poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", qty: "10", uomFactor: "1", price: "1", receivedQty: "10" }).returning();
  const [old, fresh] = await db.insert(s.batches).values([{ skuId: sku.id, batchNo: "EXPIRED-" + code, expiryDate: "2000-01-01" }, { skuId: sku.id, batchNo: "FRESH-" + code, expiryDate: "2999-01-01" }]).returning();
  await db.transaction(tx => post(tx, { sourceDocType: "opening", sourceDocId: n, action: "post", lines: [
    { sourceLineId: 1, skuId: sku.id, warehouseId: wh.id, batchId: old.id, qtyDelta: "4.1234" },
    { sourceLineId: 2, skuId: sku.id, warehouseId: wh.id, batchId: fresh.id, qtyDelta: "5" },
    { sourceLineId: 3, skuId: sku.id, warehouseId: wh.id, batchId: null, qtyDelta: "2" },
  ] }));
  const input = { poId: po.id, warehouseId: wh.id, lines: [{ poLineId: line.id, skuId: sku.id, batchId: old.id, qty: "1.1234", reason: "实际过期批次退回" }] };
  return { db, maker, checker, sku, wh, po, line, old, fresh, input };
}
it("requires an observed lot, preserves mixed expired/fresh/null, posts once and rolls back exact PO total", async () => {
  const x = await fixture();
  await expect(createCt(x.maker, { ...x.input, lines: [{ ...x.input.lines[0], batchId: undefined }] }, x.db)).rejects.toMatchObject({ status: 409 });
  const ct = await createCt(x.maker, { ...x.input, lines: [...x.input.lines,
    { ...x.input.lines[0], batchId: x.fresh.id, qty: "1" }, { ...x.input.lines[0], batchId: null, qty: "1" }] }, x.db);
  expect((await getCt(ct.id, x.db)).lines.map(l => l.batchId)).toEqual([x.old.id, x.fresh.id, null]);
  const ledger = () => x.db.select().from(s.stockLedger).where(and(eq(s.stockLedger.sourceDocType, "ct_return"), eq(s.stockLedger.sourceDocId, ct.id)));
  expect(await ledger()).toHaveLength(0);
  const pending = await submitCt(x.maker, ct.id, ct.version, x.db);
  await expect(approveCt(x.maker, ct.id, { action: "approve", version: pending.version }, x.db)).rejects.toMatchObject({ status: 403 });
  expect(await approveCt(x.checker, ct.id, { action: "approve", version: pending.version }, x.db)).toMatchObject({ status: "completed", idempotent: false });
  expect(await approveCt(x.checker, ct.id, { action: "approve", version: pending.version }, x.db)).toMatchObject({ idempotent: true });
  expect(await ledger()).toHaveLength(3);
  expect(await getBalance(x.db, x.sku.id, x.wh.id, x.old.id)).toBe("3.0000");
  expect(await getBalance(x.db, x.sku.id, x.wh.id, x.fresh.id)).toBe("4.0000");
  expect(await getBalance(x.db, x.sku.id, x.wh.id, null)).toBe("1.0000");
  expect((await x.db.select().from(s.poLines).where(eq(s.poLines.id, x.line.id)))[0].receivedQty).toBe("6.8766");
});
it("split rows cannot exceed the selected lot or the source PO line ceiling", async () => {
  const x = await fixture();
  await expect(createCt(x.maker, { ...x.input, lines: [x.input.lines[0], { ...x.input.lines[0], qty: "4" }] }, x.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("批次库存不足") });
  await expect(createCt(x.maker, { ...x.input, lines: [{ ...x.input.lines[0], qty: "6" }, { ...x.input.lines[0], batchId: x.fresh.id, qty: "5" }] }, x.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("超过已收数") });
});
it("create audit failure leaves no draft, lines or PO quantity change", async () => {
  const x = await fixture();
  await x.db.execute(sql`CREATE FUNCTION ct_physical_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity='ct' AND NEW.action='create' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
  await x.db.execute(sql`CREATE TRIGGER ct_physical_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ct_physical_fail()`);
  try {
    await expect(createCt(x.maker, x.input, x.db)).rejects.toThrow();
    expect(await x.db.select().from(s.ctDocs).where(eq(s.ctDocs.poId, x.po.id))).toHaveLength(0);
    expect((await x.db.select().from(s.poLines).where(eq(s.poLines.id, x.line.id)))[0].receivedQty).toBe("10.0000");
  } finally { await x.db.execute(sql`DROP TRIGGER ct_physical_fail ON audit_logs`); await x.db.execute(sql`DROP FUNCTION ct_physical_fail()`); }
});
it("source/warehouse changes block new create, submit and approval, without blocking rejection", async () => {
  const x = await fixture(), ct = await createCt(x.maker, x.input, x.db);
  await x.db.update(s.poDocs).set({ status: "void" }).where(eq(s.poDocs.id, x.po.id));
  await expect(createCt(x.maker, x.input, x.db)).rejects.toMatchObject({ status: 409 });
  await expect(submitCt(x.maker, ct.id, ct.version, x.db)).rejects.toMatchObject({ status: 409 });
  await x.db.update(s.poDocs).set({ status: "completed" }).where(eq(s.poDocs.id, x.po.id));
  const pending = await submitCt(x.maker, ct.id, ct.version, x.db);
  await x.db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, x.wh.id));
  await expect(approveCt(x.checker, ct.id, { action: "approve", version: pending.version }, x.db)).rejects.toMatchObject({ status: 400 });
  expect((await getCt(ct.id, x.db)).status).toBe("pending");
  expect(await approveCt(x.checker, ct.id, { action: "reject", version: pending.version }, x.db)).toMatchObject({ status: "draft" });
});
it("option scope uses exact PO line, validates role and returns old/fresh/null with bounded paging", async () => {
  const x = await fixture(), q = { poId: x.po.id, poLineId: x.line.id, warehouseId: x.wh.id, q: "", page: 1, pageSize: 2 };
  const first = await listCtReturnLots(x.maker, q, x.db); expect(first.total).toBe(3); expect(first.rows).toHaveLength(2);
  const second = await listCtReturnLots(x.maker, { ...q, page: 2 }, x.db);
  expect(second.rows).toHaveLength(1);
  expect(new Set([...first.rows, ...second.rows].map(l => l.batchId))).toEqual(new Set([null, x.old.id, x.fresh.id]));
  expect((await listCtReturnLots(x.maker, { ...q, ids: [String(x.old.id)] }, x.db)).rows).toMatchObject([{ batchId: x.old.id, availableQty: "4.1234" }]);
  expect((await listCtReturnLots(x.maker, { ...q, ids: ["unbatched"] }, x.db)).rows).toMatchObject([{ batchId: null }]);
  expect((await listCtReturnLots(x.maker, { ...q, q: "EXPIRED" }, x.db)).rows).toMatchObject([{ batchId: x.old.id }]);
  await expect(listCtReturnLots({ ...x.maker, roles: ["ops"] }, q, x.db)).rejects.toMatchObject({ status: 403 });
  await expect(listCtReturnLots(x.maker, { ...q, poLineId: x.line.id + 999 }, x.db)).rejects.toMatchObject({ status: 409 });
});
it.each(["0.00001", "1.12345", "10000000000", "-1"])("CT rejects invalid precision %s without rounding", qty => {
  expect(createCtSchema.safeParse({ poId: 1, warehouseId: 1, lines: [{ poLineId: 1, skuId: 1, qty }] }).success).toBe(false);
});
