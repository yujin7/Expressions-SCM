import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { createCt, getCt, voidCt } from "@/server/modules/matflow/ct";
import { createCtRequest, getCtCreateResult } from "@/server/modules/matflow/ct-create-request";
import { post } from "@/server/posting";
import { createTestDb } from "../helpers/db";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const { db, client } = await createTestDb();
  const users = await db.insert(s.users).values([{ name: "原仓管", roles: ["warehouse"] }, { name: "另一仓管", roles: ["warehouse"] }, { name: "管理员", roles: ["admin"] }]).returning();
  const [actor, peer, admin]: SessionUser[] = users.map(u => ({ id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion }));
  const [supplier] = await db.insert(s.suppliers).values({ code: "CT-REPLACE", name: "替代验证供应商" }).returning();
  const [spu] = await db.insert(s.spus).values({ code: "CT-REPLACE", nameCn: "替代验证" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "CT-REPLACE", name: "替代验证", spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
  const [warehouse] = await db.insert(s.warehouses).values({ code: "CT-REPLACE", name: "替代验证仓", kind: "raw", accountingMode: "realtime" }).returning();
  const [po] = await db.insert(s.poDocs).values({ docNo: "CT-REPLACE-PO", supplierId: supplier.id, createdBy: actor.id, status: "completed" }).returning();
  const [line] = await db.insert(s.poLines).values({ poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", uomFactor: "1", qty: "10", price: "1", receivedQty: "10" }).returning();
  const body = { poId: po.id, warehouseId: warehouse.id, lines: [{ poLineId: line.id, skuId: sku.id, qty: "0.0001", batchId: null }] };
  const original = await createCt(actor, body, db);
  const voidOriginal = () => voidCt(actor, original.id, { version: original.version, reason: "采购来源录错，明确重新填写" }, db);
  const snapshot = async () => ({ docs: await db.select().from(s.ctDocs), lines: await db.select().from(s.ctLines),
    receipt: await db.select().from(s.ctCreateRequests), ledger: await db.select().from(s.stockLedger), balances: await db.select().from(s.stockBalances),
    poLines: await db.select().from(s.poLines), audit: await db.select().from(s.auditLogs), counters: await db.select().from(s.docCounters) });
  return { db, client, actor, peer, admin, body, original, voidOriginal, snapshot, sku, warehouse, po, line };
}
it("replacement is an independent draft, preserves the original, links both ways and changes no stock or PO receipts", async () => {
  const f = await fixture(); try {
    const old = await f.voidOriginal(), before = await f.snapshot();
    const child = await createCt(f.actor, { ...f.body, replacementOfId: old.id, lines: [{ ...f.body.lines[0], qty: "2.5001" }] }, f.db);
    expect(child).toMatchObject({ status: "draft", replacementOfId: old.id });
    expect((await f.db.select().from(s.ctDocs).where(eq(s.ctDocs.id, old.id)))[0]).toEqual(old);
    expect((await getCt(old.id, f.db, f.actor)).replacement).toMatchObject({ successor: { id: child.id }, canCreate: false });
    expect((await getCt(child.id, f.db, f.actor)).replacement).toMatchObject({ predecessor: { id: old.id, status: "void" } });
    const after = await f.snapshot();
    for (const key of ["ledger", "balances", "poLines"] as const) expect(after[key]).toEqual(before[key]);
    expect(after.audit).toHaveLength(before.audit.length + 1); expect(after.audit.at(-1)?.after).toMatchObject({ replacementOfId: old.id });
    expect(after.lines.at(-1)?.qty).toBe("2.5001");
  } finally { await f.client.close(); }
});
it.each(["draft", "pending", "approved", "in_progress", "completed", "closed"])("%s predecessor is rejected without effects", async status => {
  const f = await fixture(); try {
    await f.db.update(s.ctDocs).set({ status: status as "draft" }).where(eq(s.ctDocs.id, f.original.id)); const before = await f.snapshot();
    await expect(createCt(f.actor, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toMatchObject({ status: 409 });
    expect((await getCt(f.original.id, f.db, f.actor)).replacement.canCreate).toBe(false); expect(await f.snapshot()).toEqual(before);
  } finally { await f.client.close(); }
});
it("posted history is never laundered through a void status and replacement", async () => {
  const f = await fixture(); try {
    await f.voidOriginal();
    await post(f.db, { sourceDocType: "opening", sourceDocId: 12345, action: "post", lines: [{ sourceLineId: 1, skuId: f.sku.id, warehouseId: f.warehouse.id, qtyDelta: "1" }] });
    await post(f.db, { sourceDocType: "ct_return", sourceDocId: f.original.id, action: "post", lines: [{ sourceLineId: 1, skuId: f.sku.id, warehouseId: f.warehouse.id, qtyDelta: "-0.0001" }] });
    const before = await f.snapshot();
    await expect(createCt(f.actor, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("库存流水") });
    expect((await getCt(f.original.id, f.db, f.actor)).replacement.canCreate).toBe(false); expect(await f.snapshot()).toEqual(before);
  } finally { await f.client.close(); }
});
it("successor remains unique after being voided; replacement continues from that successor", async () => {
  const f = await fixture(); try {
    await f.voidOriginal(); const child = await createCt(f.actor, { ...f.body, replacementOfId: f.original.id }, f.db);
    await voidCt(f.actor, child.id, { version: child.version, reason: "新选择也有误" }, f.db);
    await expect(createCt(f.actor, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toMatchObject({ status: 409 });
    const next = await createCt(f.actor, { ...f.body, replacementOfId: child.id }, f.db); expect(next.replacementOfId).toBe(child.id);
    await expect(f.db.insert(s.ctDocs).values({ docNo: "DUP", createdBy: f.actor.id, poId: f.po.id, warehouseId: f.warehouse.id, replacementOfId: child.id })).rejects.toThrow();
    await expect(f.db.update(s.ctDocs).set({ replacementOfId: next.id }).where(eq(s.ctDocs.id, next.id))).rejects.toThrow();
    await expect(f.db.update(s.ctDocs).set({ replacementOfId: -12345 }).where(eq(s.ctDocs.id, next.id))).rejects.toThrow();
  } finally { await f.client.close(); }
});
it("current owner, missing original and audit failure are enforced before any partial chain", async () => {
  const f = await fixture(); try {
    await f.voidOriginal(); const before = await f.snapshot();
    await expect(createCt(f.peer, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toMatchObject({ status: 403 });
    expect((await getCt(f.original.id, f.db, f.peer)).replacement.canCreate).toBe(false);
    await expect(createCt(f.actor, { ...f.body, replacementOfId: 999999 }, f.db)).rejects.toMatchObject({ status: 404 });
    vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("replacement audit failure"));
    const request = { ...f.body, requestKey: randomUUID(), replacementOfId: f.original.id };
    await expect(createCtRequest(f.actor, request, f.db)).rejects.toThrow("replacement audit failure"); expect(await f.snapshot()).toEqual(before);
    expect((await getCtCreateResult(f.actor, request.requestKey, f.db)).document).toBeNull();
    const child = await createCtRequest(f.admin, request, f.db); expect((await getCt(child.document.id, f.db, f.admin)).createdBy).toBe(f.admin.id);
  } finally { await f.client.close(); }
});
it("old invalid source does not trap correction; fresh destination is independently validated and lineage bound to the receipt", async () => {
  const f = await fixture(); try {
    await f.voidOriginal();
    await f.db.update(s.poDocs).set({ status: "void" }).where(eq(s.poDocs.id, f.po.id));
    await f.db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, f.warehouse.id));
    expect((await getCt(f.original.id, f.db, f.actor)).replacement.canCreate).toBe(true);
    const before = await f.snapshot();
    await expect(createCtRequest(f.actor, { ...f.body, requestKey: randomUUID(), replacementOfId: f.original.id }, f.db)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
    const [wh] = await f.db.insert(s.warehouses).values({ code: "CORRECT", name: "正确仓", kind: "raw", accountingMode: "realtime" }).returning();
    const [po] = await f.db.insert(s.poDocs).values({ docNo: "CORRECT", supplierId: f.po.supplierId, createdBy: f.actor.id, status: "completed" }).returning();
    const [line] = await f.db.insert(s.poLines).values({ poId: po.id, skuId: f.sku.id, lineType: "raw", purchaseUom: "kg", uomFactor: "1", qty: "5", price: "1", receivedQty: "5" }).returning();
    const request = { requestKey: randomUUID(), replacementOfId: f.original.id, poId: po.id, warehouseId: wh.id, lines: [{ poLineId: line.id, skuId: f.sku.id, qty: "0.0001", batchId: null }] };
    const first = await createCtRequest(f.actor, request, f.db); expect(await createCtRequest(f.actor, request, f.db)).toEqual(first);
    for (const replacementOfId of [undefined, first.document.id]) await expect(createCtRequest(f.actor, { ...request, replacementOfId }, f.db)).rejects.toMatchObject({ status: 409 });
  } finally { await f.client.close(); }
});
it("old no-lineage request hash stays byte-identical and GET-only recovery remains valid", async () => {
  const f = await fixture(); try {
    const request = { ...f.body, requestKey: randomUUID() }, first = await createCtRequest(f.actor, request, f.db);
    const [receipt] = await f.db.select().from(s.ctCreateRequests).where(eq(s.ctCreateRequests.requestKey, request.requestKey));
    const oldHash = createHash("sha256").update(JSON.stringify({ poId: f.body.poId, warehouseId: f.body.warehouseId, remark: null,
      lines: f.body.lines.map(l => ({ ...l, reason: null })) })).digest("hex");
    expect(receipt.requestHash).toBe(oldHash); expect(await getCtCreateResult(f.actor, request.requestKey, f.db)).toEqual(first);
  } finally { await f.client.close(); }
});
