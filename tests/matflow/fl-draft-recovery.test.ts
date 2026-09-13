import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as s from "@/db/schema";
import { createFl, submitFl, updateFl, approveFl, getFl } from "@/server/modules/matflow/fl";
import { post, getBalance } from "@/server/posting";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, seq = 0;
beforeAll(async () => {
  f = await createTestDb();
  await f.db.insert(s.approvalConfigs).values({ docType: "fl", approverRole: "warehouse" });
});
afterAll(async () => f?.client.close());
async function fixture() {
  const key = `FL-REC-${++seq}`;
  const [maker, admin, other] = await f.db.insert(s.users).values([
    { name: key, roles: ["warehouse"] }, { name: `${key}-ADMIN`, roles: ["admin"], isApprover: true },
    { name: `${key}-OTHER`, roles: ["warehouse"] },
  ]).returning();
  const [spu] = await f.db.insert(s.spus).values({ code: key, nameCn: key }).returning();
  const [product, material] = await f.db.insert(s.skus).values([
    { code: `${key}-P`, spuId: spu.id, skuType: "finished", baseUom: "支" },
    { code: `${key}-M`, spuId: spu.id, skuType: "raw", baseUom: "kg" },
  ]).returning();
  const [supplier] = await f.db.insert(s.suppliers).values({ code: key, name: key }).returning();
  const [own, out] = await f.db.insert(s.warehouses).values([
    { code: `${key}-OWN`, name: key, kind: "raw" },
    { code: `${key}-OUT`, name: key, kind: "outsource", supplierId: supplier.id },
  ]).returning();
  const [bom] = await f.db.insert(s.boms).values({ productSkuId: product.id, versionNo: "1" }).returning();
  const [wo] = await f.db.insert(s.woDocs).values({ docNo: key, productSkuId: product.id, supplierId: supplier.id, bomId: bom.id, qty: "10", feeRatePlan: "1", createdBy: maker.id }).returning();
  const [jg] = await f.db.insert(s.jgDocs).values({ docNo: key, woId: wo.id, productSkuId: product.id, supplierId: supplier.id, qty: "10", feeRateCurrent: "1", status: "in_progress", createdBy: maker.id }).returning();
  const [batch] = await f.db.insert(s.batches).values({ skuId: material.id, batchNo: key, expiryDate: "2999-01-01" }).returning();
  const doc = await createFl(maker, { jgId: jg.id, fromWarehouseId: own.id, toWarehouseId: out.id, lines: [{ skuId: material.id, qty: "1", batchId: batch.id }] }, f.db);
  const input = { version: doc.version, fromWarehouseId: own.id, toWarehouseId: out.id, remark: "核对后重新配批", lines: [{ skuId: material.id, qty: "2.1234", batchId: batch.id }] };
  return { maker, admin, other, material, product, own, out, batch, doc, input, jg };
}
async function snapshot() {
  return { docs: await f.db.select().from(s.flDocs), lines: await f.db.select().from(s.flLines),
    audits: await f.db.select().from(s.auditLogs), approvals: await f.db.select().from(s.approvals),
    ledger: await f.db.select().from(s.stockLedger), balances: await f.db.select().from(s.stockBalances) };
}
it("reject → correct original draft → resubmit → approve retains history and posts only the reviewed lot once", async () => {
  const x = await fixture();
  const pending = await submitFl(x.maker, x.doc.id, 1, f.db);
  await f.db.update(s.batches).set({ expiryDate: "2000-01-01" }).where(eq(s.batches.id, x.batch.id));
  const before = await snapshot();
  await expect(approveFl(x.admin, x.doc.id, { version: pending.version, action: "approve" }, f.db)).rejects.toMatchObject({ code: "EXPIRED_BATCH" });
  expect(await snapshot()).toEqual(before);
  await approveFl(x.admin, x.doc.id, { version: pending.version, action: "reject", comment: "批次过期，请重新配批" }, f.db);
  const [valid] = await f.db.insert(s.batches).values({ skuId: x.material.id, batchNo: "FL-REC-VALID", expiryDate: "2999-01-01" }).returning();
  await post(f.db, { sourceDocType: "opening", sourceDocId: seq, action: "post", lines: [{ sourceLineId: 1, skuId: x.material.id, warehouseId: x.own.id, batchId: valid.id, qtyDelta: "10" }] });
  const original = await getFl(x.doc.id, f.db, x.maker);
  expect(original.actions?.edit).toBe(true);
  const input = { ...x.input, version: original.version, lines: [{ ...x.input.lines[0], batchId: valid.id }] };
  const saved = await updateFl(x.maker, x.doc.id, input, f.db);
  expect(saved).toMatchObject({ id: x.doc.id, docNo: x.doc.docNo, jgId: x.jg.id, createdBy: x.maker.id, status: "draft", version: original.version + 1 });
  expect((await getFl(x.doc.id, f.db)).approvals).toEqual(original.approvals);
  expect(await getBalance(f.db, x.material.id, x.own.id, valid.id)).toBe("10.0000");
  await expect(updateFl(x.maker, x.doc.id, input, f.db)).rejects.toMatchObject({ status: 409 });
  const [audit] = (await f.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, x.doc.id))).filter(r => r.entity === "fl" && r.action === "update_draft");
  expect(audit.before).toMatchObject({ lines: [{ batchId: x.batch.id, qty: "1.0000" }] });
  expect(audit.after).toMatchObject({ lines: [{ batchId: valid.id, qty: "2.1234" }] });
  const submitted = await submitFl(x.maker, saved.id, saved.version, f.db);
  expect(await approveFl(x.admin, saved.id, { version: submitted.version, action: "approve" }, f.db)).toMatchObject({ status: "completed" });
  expect(await getBalance(f.db, x.material.id, x.own.id, valid.id)).toBe("7.8766");
  expect(await getBalance(f.db, x.material.id, x.out.id, valid.id)).toBe("2.1234");
  const final = await snapshot();
  expect(await approveFl(x.admin, saved.id, { version: submitted.version, action: "approve" }, f.db)).toMatchObject({ idempotent: true });
  expect(await snapshot()).toEqual(final);
});
it("only the current warehouse maker or admin can edit; read hints match the write boundary", async () => {
  const x = await fixture(), before = await snapshot();
  expect((await getFl(x.doc.id, f.db, x.other)).actions?.edit).toBe(false);
  await expect(updateFl(x.other, x.doc.id, x.input, f.db)).rejects.toMatchObject({ status: 403 });
  expect(await snapshot()).toEqual(before);
  expect((await getFl(x.doc.id, f.db, x.admin)).actions?.edit).toBe(true);
  expect(await updateFl(x.admin, x.doc.id, x.input, f.db)).toMatchObject({ createdBy: x.maker.id });
});
it.each(["pending", "completed", "void"] as const)("%s cannot be edited even by admin", async status => {
  const x = await fixture();
  await f.db.update(s.flDocs).set({ status }).where(eq(s.flDocs.id, x.doc.id));
  const before = await snapshot();
  await expect(updateFl(x.admin, x.doc.id, x.input, f.db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
});
it.each(["expired", "wrong-sku", "missing"])("rejects %s batch without rewriting lines or history", async kind => {
  const x = await fixture();
  if (kind === "expired") await f.db.update(s.batches).set({ expiryDate: "2000-01-01" }).where(eq(s.batches.id, x.batch.id));
  const [wrong] = await f.db.insert(s.batches).values({ skuId: x.product.id, batchNo: `WRONG-${seq}` }).returning();
  const before = await snapshot();
  await expect(updateFl(x.maker, x.doc.id, { ...x.input, lines: [{ ...x.input.lines[0], batchId: kind === "missing" ? 9999999 : kind === "wrong-sku" ? wrong.id : x.batch.id }] }, f.db)).rejects.toMatchObject({ code: kind === "expired" ? "EXPIRED_BATCH" : "BATCH_IDENTITY" });
  expect(await snapshot()).toEqual(before);
});
it("source, explicit batch choice, and supplier location cannot silently change", async () => {
  const x = await fixture(), before = await snapshot();
  await expect(updateFl(x.maker, x.doc.id, { ...x.input, jgId: x.jg.id + 1 }, f.db)).rejects.toThrow();
  await expect(updateFl(x.maker, x.doc.id, { ...x.input, lines: [{ skuId: x.material.id, qty: "1" }] }, f.db)).rejects.toThrow();
  await expect(updateFl(x.maker, x.doc.id, { ...x.input, toWarehouseId: x.own.id }, f.db)).rejects.toMatchObject({ status: 409 });
  await expect(updateFl(x.maker, x.doc.id, { ...x.input, fromWarehouseId: x.out.id }, f.db)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
it("a corrupt draft status does not allow rewriting an already posted document", async () => {
  const x = await fixture();
  await post(f.db, { sourceDocType: "fl_issue", sourceDocId: x.doc.id, action: "post", lines: [{ sourceLineId: 1, skuId: x.material.id, warehouseId: x.out.id, batchId: x.batch.id, qtyDelta: "1" }] });
  const before = await snapshot();
  await expect(updateFl(x.admin, x.doc.id, x.input, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("库存流水") });
  expect(await snapshot()).toEqual(before);
});
it("detail cannot label a material with another SKU's batch metadata", async () => {
  const x = await fixture();
  const [wrong] = await f.db.insert(s.batches).values({ skuId: x.product.id, batchNo: `OTHER-SKU-${seq}`, expiryDate: "2999-01-01" }).returning();
  await f.db.update(s.flLines).set({ batchId: wrong.id }).where(eq(s.flLines.flId, x.doc.id));
  expect((await getFl(x.doc.id, f.db)).lines[0]).toMatchObject({ batchId: wrong.id, batchNo: null, expiryDate: null });
});
