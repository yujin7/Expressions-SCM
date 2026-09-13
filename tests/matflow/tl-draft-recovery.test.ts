import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { createTl, submitTl, updateTl, approveTl, getTl } from "@/server/modules/matflow/tl";
import { post, getBalance } from "@/server/posting";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, seq = 0;
beforeAll(async () => { f = await createTestDb(); await f.db.insert(s.approvalConfigs).values({ docType: "tl", approverRole: "warehouse" }); });
afterAll(async () => f?.client.close());
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const key = `TL-REC-${++seq}`;
  const [maker, checker, other] = await f.db.insert(s.users).values([
    { name: key, roles: ["warehouse"] }, { name: key + "-CHECK", roles: ["admin"], isApprover: true },
    { name: key + "-OTHER", roles: ["warehouse"] },
  ]).returning();
  const [spu] = await f.db.insert(s.spus).values({ code: key, nameCn: key }).returning();
  const [product, material] = await f.db.insert(s.skus).values([
    { code: key + "-P", spuId: spu.id, skuType: "finished", baseUom: "支" },
    { code: key + "-M", spuId: spu.id, skuType: "raw", baseUom: "kg" },
  ]).returning();
  const [supplier] = await f.db.insert(s.suppliers).values({ code: key, name: key }).returning();
  const [own, out] = await f.db.insert(s.warehouses).values([
    { code: key + "-OWN", name: key, kind: "raw" },
    { code: key + "-OUT", name: key, kind: "outsource", supplierId: supplier.id },
  ]).returning();
  const [bom] = await f.db.insert(s.boms).values({ productSkuId: product.id, versionNo: "1" }).returning();
  const [wo] = await f.db.insert(s.woDocs).values({ docNo: key, productSkuId: product.id, supplierId: supplier.id, bomId: bom.id, qty: "10", feeRatePlan: "1", createdBy: maker.id }).returning();
  const [jg] = await f.db.insert(s.jgDocs).values({ docNo: key, woId: wo.id, productSkuId: product.id, supplierId: supplier.id, qty: "10", feeRateCurrent: "1", status: "in_progress", createdBy: maker.id }).returning();
  const [batch] = await f.db.insert(s.batches).values({ skuId: material.id, batchNo: key, expiryDate: "2000-01-01" }).returning();
  const [fl] = await f.db.insert(s.flDocs).values({ docNo: key, jgId: jg.id, fromWarehouseId: own.id, toWarehouseId: out.id, status: "completed", createdBy: maker.id }).returning();
  await f.db.insert(s.flLines).values({ flId: fl.id, skuId: material.id, qty: "5", batchId: batch.id });
  await post(f.db, { sourceDocType: "opening", sourceDocId: seq, action: "post", lines: [{ sourceLineId: 1, skuId: material.id, warehouseId: out.id, batchId: batch.id, qtyDelta: "10" }] });
  const doc = await createTl(maker, { jgId: jg.id, fromWarehouseId: out.id, toWarehouseId: own.id,
    lines: [{ skuId: material.id, qty: "6", batchId: batch.id, reason: "surplus_return" }] }, f.db);
  const detail = await getTl(doc.id, f.db, maker);
  const input = { version: doc.version, toWarehouseId: own.id, remark: "核对实际退回量", lines: [{ id: detail.lines[0].id, qty: "4.1234", reason: "defect_exchange" }] };
  return { maker, checker, other, product, material, batch, own, out, jg, doc, detail, input };
}
async function snapshot() {
  return { docs: await f.db.select().from(s.tlDocs), lines: await f.db.select().from(s.tlLines), audit: await f.db.select().from(s.auditLogs),
    approvals: await f.db.select().from(s.approvals), ledger: await f.db.select().from(s.stockLedger), balances: await f.db.select().from(s.stockBalances) };
}
it("new return creation preserves operator-selected expired identity and rejects omitted batch atomically", async () => {
  const x = await fixture();
  await f.db.insert(s.sysParams).values({ scope: "global", key: "batch_posting_enabled", value: "1" })
    .onConflictDoUpdate({ target: [s.sysParams.scope, s.sysParams.key], set: { value: "1" } });
  try {
    const base = { jgId: x.jg.id, fromWarehouseId: x.out.id, toWarehouseId: x.own.id };
    const before = await snapshot();
    await expect(createTl(x.maker, { ...base, lines: [{ skuId: x.material.id, qty: "1", reason: "defect_exchange" }] }, f.db)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
    const input = { ...base, lines: [{ skuId: x.material.id, qty: "1.1234", batchId: x.batch.id, reason: "defect_exchange" }] };
    vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("create audit down"));
    await expect(createTl(x.maker, input, f.db)).rejects.toThrow("create audit down");
    expect(await snapshot()).toEqual(before);
    const created = await createTl(x.maker, input, f.db);
    expect((await getTl(created.id, f.db)).lines).toMatchObject([{ batchId: x.batch.id, qty: "1.1234", reason: "defect_exchange" }]);
    expect(await getBalance(f.db, x.material.id, x.out.id, x.batch.id)).toBe("10.0000");
  } finally { await f.db.update(s.sysParams).set({ value: "0" }).where(eq(s.sysParams.key, "batch_posting_enabled")); }
});
it("over-return → reject → correct same expired physical lot → approve once, preserving line id/history", async () => {
  const x = await fixture(), pending = await submitTl(x.maker, x.doc.id, 1, f.db);
  const before = await snapshot();
  await expect(approveTl(x.checker, x.doc.id, { action: "approve", version: pending.version }, f.db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
  await approveTl(x.checker, x.doc.id, { action: "reject", version: pending.version, comment: "实际退回4.1234，请核对原批次" }, f.db);
  const rejected = await getTl(x.doc.id, f.db, x.maker);
  expect(rejected.actions?.edit).toBe(true);
  const input = { ...x.input, version: rejected.version };
  const saved = await updateTl(x.maker, x.doc.id, input, f.db);
  expect(saved).toMatchObject({ id: x.doc.id, docNo: x.doc.docNo, jgId: x.jg.id, fromWarehouseId: x.out.id, createdBy: x.maker.id, version: rejected.version + 1, status: "draft" });
  const detail = await getTl(x.doc.id, f.db);
  expect(detail.approvals).toEqual(rejected.approvals);
  expect(detail.lines[0]).toMatchObject({ id: x.detail.lines[0].id, batchId: x.batch.id, qty: "4.1234", reason: "defect_exchange" });
  expect(await getBalance(f.db, x.material.id, x.out.id, x.batch.id)).toBe("10.0000");
  await expect(updateTl(x.maker, x.doc.id, input, f.db)).rejects.toMatchObject({ status: 409 });
  const sent = await submitTl(x.maker, saved.id, saved.version, f.db);
  expect(await approveTl(x.checker, sent.id, { action: "approve", version: sent.version }, f.db)).toMatchObject({ status: "completed" });
  expect(await getBalance(f.db, x.material.id, x.out.id, x.batch.id)).toBe("5.8766");
  expect(await getBalance(f.db, x.material.id, x.own.id, x.batch.id)).toBe("4.1234");
  const final = await snapshot();
  expect(await approveTl(x.checker, sent.id, { action: "approve", version: sent.version }, f.db)).toMatchObject({ idempotent: true });
  expect(await snapshot()).toEqual(final);
});
it("audit failure rolls back original header and lines; retry commits once", async () => {
  const x = await fixture(), before = await snapshot();
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("audit down"));
  await expect(updateTl(x.maker, x.doc.id, x.input, f.db)).rejects.toThrow("audit down");
  expect(await snapshot()).toEqual(before);
  await updateTl(x.maker, x.doc.id, x.input, f.db);
  const row = (await f.db.select().from(s.auditLogs)).find(a => a.entity === "tl" && a.entityId === x.doc.id && a.action === "update_draft");
  expect(row?.before).toMatchObject({ lines: [{ qty: "6.0000", reason: "surplus_return" }] });
  expect(row?.after).toMatchObject({ lines: [{ qty: "4.1234", reason: "defect_exchange" }] });
});
it.each(["other", "disabled", "role", "session"])("rejects current %s authority without changes", async kind => {
  const x = await fixture();
  if (kind !== "other") await f.db.update(s.users).set(kind === "disabled" ? { active: false } : kind === "role" ? { roles: ["ops"] } : { sessionVersion: x.maker.sessionVersion + 1 }).where(eq(s.users.id, x.maker.id));
  const before = await snapshot();
  await expect(updateTl(kind === "other" ? x.other : x.maker, x.doc.id, x.input, f.db)).rejects.toMatchObject({ status: kind === "session" ? 401 : 403 });
  expect(await snapshot()).toEqual(before);
});
it.each(["pending", "completed", "void"] as const)("%s cannot be edited by admin", async status => {
  const x = await fixture(); await f.db.update(s.tlDocs).set({ status }).where(eq(s.tlDocs.id, x.doc.id));
  const before = await snapshot(); await expect(updateTl(x.checker, x.doc.id, x.input, f.db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
});
it("refuses duplicate/foreign lines, implicit source changes and rounded-to-zero quantities", async () => {
  const x = await fixture(), y = await fixture(), before = await snapshot();
  for (const input of [
    { ...x.input, jgId: y.jg.id }, { ...x.input, fromWarehouseId: y.out.id },
    { ...x.input, lines: [{ ...x.input.lines[0], batchId: y.batch.id }] },
    { ...x.input, lines: [x.input.lines[0], x.input.lines[0]] },
    { ...x.input, lines: [{ ...x.input.lines[0], qty: "0.00001" }] },
    { ...x.input, lines: [{ ...x.input.lines[0], id: y.detail.lines[0].id }] },
    { ...x.input, lines: [] }, { ...x.input, toWarehouseId: x.out.id },
  ]) await expect(updateTl(x.maker, x.doc.id, input, f.db)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
it("retained line ids remain stable when another original row is removed", async () => {
  const x = await fixture();
  await f.db.insert(s.tlLines).values({ tlId: x.doc.id, skuId: x.material.id, qty: "1", reason: "surplus_return", batchId: null });
  await updateTl(x.maker, x.doc.id, x.input, f.db);
  expect((await getTl(x.doc.id, f.db)).lines).toMatchObject([{ id: x.detail.lines[0].id, batchId: x.batch.id }]);
  expect((await getTl(x.doc.id, f.db)).lines).toHaveLength(1);
});
it("posted drafts and wrong-SKU batch identities cannot be rewritten or mislabelled", async () => {
  const x = await fixture();
  const [wrong] = await f.db.insert(s.batches).values({ skuId: x.product.id, batchNo: `WRONG-${seq}` }).returning();
  await f.db.update(s.tlLines).set({ batchId: wrong.id }).where(eq(s.tlLines.tlId, x.doc.id));
  expect((await getTl(x.doc.id, f.db)).lines[0]).toMatchObject({ batchId: wrong.id, batchNo: null, expiryDate: null });
  let before = await snapshot();
  await expect(updateTl(x.maker, x.doc.id, x.input, f.db)).rejects.toMatchObject({ code: "BATCH_IDENTITY" });
  expect(await snapshot()).toEqual(before);
  await post(f.db, { sourceDocType: "tl_return", sourceDocId: x.doc.id, action: "post", lines: [{ sourceLineId: 1, skuId: x.material.id, warehouseId: x.own.id, batchId: x.batch.id, qtyDelta: "1" }] });
  before = await snapshot();
  await expect(updateTl(x.checker, x.doc.id, x.input, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("库存流水") });
  expect(await snapshot()).toEqual(before);
});
it("closed JG can return before settlement freezes; frozen settlement blocks edits and action hints", async () => {
  const x = await fixture();
  await f.db.update(s.jgDocs).set({ status: "closed" }).where(eq(s.jgDocs.id, x.jg.id));
  const saved = await updateTl(x.maker, x.doc.id, x.input, f.db);
  await f.db.insert(s.jsDocs).values({ docNo: `TL-FROZEN-${seq}`, jgId: x.jg.id, goodQty: "1", feePayable: "1", settleAmount: "1", status: "approved", createdBy: x.checker.id });
  const before = await snapshot();
  expect((await getTl(x.doc.id, f.db, x.maker)).actions?.edit).toBe(false);
  await expect(updateTl(x.maker, x.doc.id, { ...x.input, version: saved.version }, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("冻结") });
  expect(await snapshot()).toEqual(before);
});
it.each(["disabled-source", "other-factory", "snapshot-destination"])("rechecks current %s warehouse qualification", async kind => {
  const x = await fixture();
  if (kind === "disabled-source") await f.db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, x.out.id));
  if (kind === "other-factory") await f.db.update(s.warehouses).set({ supplierId: null }).where(eq(s.warehouses.id, x.out.id));
  if (kind === "snapshot-destination") await f.db.update(s.warehouses).set({ kind: "snapshot", accountingMode: "snapshot" }).where(eq(s.warehouses.id, x.own.id));
  const before = await snapshot();
  await expect(updateTl(x.maker, x.doc.id, x.input, f.db)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
