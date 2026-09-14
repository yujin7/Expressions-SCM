import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { createStockDoc, getStockDoc, voidStockDoc } from "@/server/modules/inventory/stock-doc";
import { createStockRequest } from "@/server/modules/inventory/stock-create-request";
import { post } from "@/server/posting";
import { createTestDb } from "../helpers/db";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const { db, client } = await createTestDb();
  const actors = await db.insert(s.users).values([{ name: "原仓管", roles: ["warehouse"] }, { name: "另一仓管", roles: ["warehouse"] }, { name: "管理员", roles: ["admin"] }]).returning();
  const [actor, peer, admin]: SessionUser[] = actors.map(u => ({ id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion }));
  const [spu] = await db.insert(s.spus).values({ code: "REPLACE", nameCn: "替代测试" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "REPLACE", name: "替代测试", spuId: spu.id, baseUom: "kg", skuType: "raw" }).returning();
  const [warehouse] = await db.insert(s.warehouses).values({ code: "REPLACE", name: "替代测试仓", kind: "raw", accountingMode: "realtime" }).returning();
  const body = { subtype: "opening", warehouseId: warehouse.id, lines: [{ skuId: sku.id, qty: "0.0001", price: "1.23" }] };
  const original = await createStockDoc(actor, body, db);
  const voidOriginal = () => voidStockDoc(actor, original.id, { version: original.version, reason: "原仓库录错，明确纠正" }, db);
  const snapshot = async () => ({ docs: await db.select().from(s.stockDocs), lines: await db.select().from(s.stockDocLines),
    ledger: await db.select().from(s.stockLedger), balances: await db.select().from(s.stockBalances), audit: await db.select().from(s.auditLogs), counters: await db.select().from(s.docCounters) });
  return { db, client, actor, peer, admin, body, original, voidOriginal, snapshot, sku, warehouse };
}
it("an explicit replacement preserves the void original, records one audit, links both ways and posts nothing", async () => {
  const f = await fixture(); try {
    const old = await f.voidOriginal(), before = await f.snapshot();
    const current = await createStockDoc(f.actor, { ...f.body, replacementOfId: old.id, lines: [{ skuId: f.sku.id, qty: "2.5001" }] }, f.db);
    expect(current).toMatchObject({ status: "draft", replacementOfId: old.id, sourceDocId: null, sourceDocType: null, reversalOfId: null });
    expect((await f.db.select().from(s.stockDocs).where(eq(s.stockDocs.id, old.id)))[0]).toEqual(old);
    expect((await getStockDoc(old.id, f.db, f.actor)).replacement).toMatchObject({ successor: { id: current.id }, canCreate: false });
    expect((await getStockDoc(current.id, f.db, f.actor)).replacement).toMatchObject({ predecessor: { id: old.id, status: "void" } });
    const after = await f.snapshot(); expect(after.ledger).toEqual(before.ledger); expect(after.balances).toEqual(before.balances);
    expect(after.audit.at(-1)?.after).toMatchObject({ replacementOfId: old.id }); expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(after.lines.at(-1)?.qty).toBe("2.5001");
  } finally { await f.client.close(); }
});
it.each(["draft", "pending", "completed", "closed"])("%s predecessor is rejected without partial effects", async status => {
  const f = await fixture(); try {
    await f.db.update(s.stockDocs).set({ status: status as "draft" }).where(eq(s.stockDocs.id, f.original.id));
    const before = await f.snapshot();
    await expect(createStockDoc(f.actor, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toMatchObject({ status: 409 });
    expect(await f.snapshot()).toEqual(before); expect((await getStockDoc(f.original.id, f.db, f.actor)).replacement.canCreate).toBe(false);
  } finally { await f.client.close(); }
});
it.each(["count_adjust", "reversal", "purchase_in"])("generated %s cannot become a manual replacement source", async subtype => {
  const f = await fixture(); try {
    await f.db.update(s.stockDocs).set({ status: "void", subtype: subtype as "reversal" }).where(eq(s.stockDocs.id, f.original.id));
    const before = await f.snapshot();
    await expect(createStockDoc(f.admin, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toMatchObject({ status: 409 });
    expect(await f.snapshot()).toEqual(before);
  } finally { await f.client.close(); }
});
it("void with prior posting is not laundered into a replacement", async () => {
  const f = await fixture(); try {
    await f.voidOriginal(); await post(f.db, { sourceDocType: "opening", sourceDocId: f.original.id, action: "post",
      lines: [{ sourceLineId: 1, skuId: f.sku.id, warehouseId: f.warehouse.id, qtyDelta: "0.0001" }] });
    const before = await f.snapshot();
    await expect(createStockDoc(f.actor, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("库存流水") });
    expect((await getStockDoc(f.original.id, f.db, f.actor)).replacement.canCreate).toBe(false); expect(await f.snapshot()).toEqual(before);
  } finally { await f.client.close(); }
});
it("one direct successor even when void: correction continues from the latest void successor", async () => {
  const f = await fixture(); try {
    await f.voidOriginal(); const child = await createStockDoc(f.actor, { ...f.body, replacementOfId: f.original.id }, f.db);
    await voidStockDoc(f.actor, child.id, { version: child.version, reason: "本张也有误" }, f.db);
    await expect(createStockDoc(f.actor, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toMatchObject({ status: 409 });
    const next = await createStockDoc(f.actor, { ...f.body, replacementOfId: child.id }, f.db); expect(next.replacementOfId).toBe(child.id);
    await expect(f.db.insert(s.stockDocs).values({ docNo: "DUP", subtype: "opening", createdBy: f.actor.id, replacementOfId: child.id })).rejects.toThrow();
    await expect(f.db.insert(s.stockDocs).values({ id: 99999, docNo: "SELF", subtype: "opening", createdBy: f.actor.id, replacementOfId: 99999 })).rejects.toThrow();
  } finally { await f.client.close(); }
});
it("fresh owner authorization, missing predecessor, and failed audit all leave the chain unchanged", async () => {
  const f = await fixture(); try {
    await f.voidOriginal(); const before = await f.snapshot();
    await expect(createStockDoc(f.peer, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toMatchObject({ status: 403 });
    await expect(createStockDoc(f.actor, { ...f.body, replacementOfId: 99999 }, f.db)).rejects.toMatchObject({ status: 404 });
    expect((await getStockDoc(f.original.id, f.db, f.peer)).replacement.canCreate).toBe(false);
    vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("replacement audit failed"));
    await expect(createStockDoc(f.actor, { ...f.body, replacementOfId: f.original.id }, f.db)).rejects.toThrow("replacement audit failed");
    expect(await f.snapshot()).toEqual(before);
    const child = await createStockDoc(f.admin, { ...f.body, replacementOfId: f.original.id }, f.db); expect(child.createdBy).toBe(f.admin.id);
  } finally { await f.client.close(); }
});
it("old warehouse may be disabled; new source is independently revalidated and request lineage is immutable", async () => {
  const f = await fixture(); try {
    await f.voidOriginal(); await f.db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, f.warehouse.id));
    const [newWh] = await f.db.insert(s.warehouses).values({ code: "CORRECT", name: "正确仓", kind: "raw", accountingMode: "realtime" }).returning();
    const request = { ...f.body, replacementOfId: f.original.id, warehouseId: newWh.id, requestKey: randomUUID() };
    const first = await createStockRequest(f.actor, request, f.db);
    expect(await createStockRequest(f.actor, request, f.db)).toEqual(first);
    await expect(createStockRequest(f.actor, { ...request, replacementOfId: undefined }, f.db)).rejects.toMatchObject({ status: 409 });
    await expect(createStockRequest(f.actor, { ...request, replacementOfId: first.document.id }, f.db)).rejects.toMatchObject({ status: 409 });
  } finally { await f.client.close(); }
});
