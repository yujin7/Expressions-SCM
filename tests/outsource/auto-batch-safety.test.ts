import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { createBatchJg, previewAutoChain } from "@/server/modules/outsource/auto-chain";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], actor: SessionUser, seq = 0;
beforeAll(async () => {
  ({ db, client } = await createTestDb());
  [actor] = await db.insert(s.users).values({ name: "合成PMC", roles: ["pmc"] }).returning();
});
afterAll(async () => { await client.close(); });
async function fixture() {
  const no = `BATCH-SAFE-${++seq}`;
  const [spu] = await db.insert(s.spus).values({ code: no, nameCn: no }).returning();
  const [product, material] = await db.insert(s.skus).values([
    { code: `${no}-FG`, name: "合成成品", spuId: spu.id, skuType: "finished" as const, baseUom: "支" },
    { code: `${no}-MAT`, name: "合成物料", spuId: spu.id, skuType: "packaging" as const, baseUom: "个" },
  ]).returning();
  const [sup] = await db.insert(s.suppliers).values({ code: no, name: "合成加工厂" }).returning();
  const [bom] = await db.insert(s.boms).values({ productSkuId: product.id, versionNo: "1", status: "active" }).returning();
  const [wo] = await db.insert(s.woDocs).values({ docNo: `WO-${no}`, status: "approved", productSkuId: product.id, qty: "100", supplierId: sup.id, feeRatePlan: "1", bomId: bom.id, createdBy: actor.id }).returning();
  await db.insert(s.woLines).values({ woId: wo.id, materialSkuId: material.id, qtyPer: "1", grossReq: "100", suggestedQty: "100" });
  const [po] = await db.insert(s.poDocs).values({ docNo: `PO-${no}`, woId: wo.id, supplierId: sup.id, status: "in_progress", createdBy: actor.id }).returning();
  await db.insert(s.poLines).values({ poId: po.id, skuId: material.id, lineType: "packaging", qty: "100", receivedQty: "50", purchaseUom: "个", uomFactor: "1", price: "1" });
  return { wo, product, sup, po };
}
const batches = (woId: number) => db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, woId));

it("creates only a draft with fee segment and audit; repeat refuses without another stock or draft effect", async () => {
  const f = await fixture();
  const before = await db.select().from(s.stockLedger);
  const jg = await createBatchJg(actor, f.wo.id, db);
  expect(jg).toMatchObject({ woId: f.wo.id, qty: "50.0000", status: "draft", batchSeq: 1, createdBy: actor.id });
  expect(await db.select().from(s.jgFeeSegments).where(eq(s.jgFeeSegments.jgId, jg.id))).toHaveLength(1);
  expect(await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "auto_chain"), eq(s.auditLogs.entityId, jg.id), eq(s.auditLogs.action, "batch_jg")))).toHaveLength(1);
  await expect(createBatchJg(actor, f.wo.id, db)).rejects.toMatchObject({ status: 409 });
  expect(await batches(f.wo.id)).toHaveLength(1);
  expect(await db.select().from(s.stockLedger)).toEqual(before);
});
it("rechecks revoked role, disabled account, and expired session inside the service", async () => {
  const f = await fixture();
  const [revoked] = await db.insert(s.users).values({ name: "撤权", roles: ["warehouse"] }).returning();
  const [inactive] = await db.insert(s.users).values({ name: "停用", roles: ["pmc"], active: false }).returning();
  await expect(createBatchJg({ ...revoked, roles: ["pmc"] }, f.wo.id, db)).rejects.toMatchObject({ status: 403 });
  await expect(createBatchJg(inactive, f.wo.id, db)).rejects.toMatchObject({ status: 403 });
  await expect(createBatchJg({ ...actor, sessionVersion: 999 }, f.wo.id, db)).rejects.toMatchObject({ status: 401 });
  expect(await batches(f.wo.id)).toHaveLength(0);
});
it.each(["paused", "blacklisted"] as const)("preview and write both refuse supplier %s", async (status) => {
  const f = await fixture();
  await db.update(s.suppliers).set({ status }).where(eq(s.suppliers.id, f.sup.id));
  expect((await previewAutoChain(db)).batches.find(b => b.woId === f.wo.id)?.blockedReason).toContain("禁止新单");
  await expect(createBatchJg(actor, f.wo.id, db)).rejects.toMatchObject({ status: 409 });
  expect(await batches(f.wo.id)).toHaveLength(0);
});
it("refuses inactive product, changed WO status, review flags and invalid source IDs", async () => {
  const f = await fixture();
  await db.update(s.skus).set({ active: false }).where(eq(s.skus.id, f.product.id));
  await expect(createBatchJg(actor, f.wo.id, db)).rejects.toThrow("停用");
  await db.update(s.skus).set({ active: true, attrs: { needsReview: ["单位未核实"] } }).where(eq(s.skus.id, f.product.id));
  await expect(createBatchJg(actor, f.wo.id, db)).rejects.toThrow("待复核");
  await db.update(s.woDocs).set({ status: "closed" }).where(eq(s.woDocs.id, f.wo.id));
  await expect(createBatchJg(actor, f.wo.id, db)).rejects.toMatchObject({ status: 409 });
  for (const id of [0, -1, 0.5, 2147483648]) await expect(createBatchJg(actor, id, db)).rejects.toMatchObject({ status: 400 });
  await expect(createBatchJg(actor, 2147483647, db)).rejects.toMatchObject({ status: 404 });
  expect(await batches(f.wo.id)).toHaveLength(0);
});
it("uses the current received quantity rather than the prior visible preview", async () => {
  const f = await fixture();
  expect((await previewAutoChain(db)).batches.find(b => b.woId === f.wo.id)?.suggestQty).toBe("50.0000");
  await db.update(s.poLines).set({ receivedQty: "20" }).where(eq(s.poLines.poId, f.po.id));
  expect((await createBatchJg(actor, f.wo.id, db)).qty).toBe("20.0000");
});
it("aggregates duplicate WO material requirements before sharing the same received supply", async () => {
  const f = await fixture();
  const [line] = await db.select().from(s.woLines).where(eq(s.woLines.woId, f.wo.id));
  await db.insert(s.woLines).values({ woId: f.wo.id, materialSkuId: line.materialSkuId, qtyPer: "1", grossReq: "100", suggestedQty: "100" });
  const preview = (await previewAutoChain(db)).batches.find(b => b.woId === f.wo.id);
  expect(preview?.receivedBasis).toHaveLength(1);
  expect(preview?.suggestQty).toBe("25.0000"); // 50 received / (200 total material / 100 products)
  expect((await createBatchJg(actor, f.wo.id, db)).qty).toBe("25.0000");
});
it("audit failure rolls back draft, fee segment and number allocation; retry succeeds", async () => {
  const f = await fixture();
  const counter = await db.select().from(s.docCounters);
  const segments = await db.select().from(s.jgFeeSegments);
  const fail = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(new Error("synthetic batch audit failure"));
  try { await expect(createBatchJg(actor, f.wo.id, db)).rejects.toThrow("audit failure"); }
  finally { fail.mockRestore(); }
  expect(await batches(f.wo.id)).toHaveLength(0);
  expect(await db.select().from(s.jgFeeSegments)).toEqual(segments);
  expect(await db.select().from(s.docCounters)).toEqual(counter);
  expect((await createBatchJg(actor, f.wo.id, db)).status).toBe("draft");
});
it("continues after a legacy batch sequence gap without colliding or exceeding the WO", async () => {
  const f = await fixture();
  await db.insert(s.jgDocs).values({ docNo: `JG-GAP-${f.wo.id}`, woId: f.wo.id, batchSeq: 3, productSkuId: f.product.id, supplierId: f.sup.id, qty: "10", feeRateCurrent: "1", status: "completed", createdBy: actor.id });
  expect(await createBatchJg(actor, f.wo.id, db)).toMatchObject({ batchSeq: 4, qty: "40.0000" });
});

it.each([
  ["3000", "1", "0.5", "1500.0000"],
  ["1000", "0.0001", "0.0001", "1000.0000"],
] as const)("preview, draft and audit share exact capacity for WO %s gross %s", async (qty, grossReq, receivedQty, expected) => {
  const f = await fixture();
  await db.update(s.woDocs).set({ qty }).where(eq(s.woDocs.id, f.wo.id));
  await db.update(s.woLines).set({ grossReq }).where(eq(s.woLines.woId, f.wo.id));
  await db.update(s.poLines).set({ receivedQty }).where(eq(s.poLines.poId, f.po.id));
  const before = await db.select().from(s.stockLedger);
  const row = (await previewAutoChain(db)).batches.find(b => b.woId === f.wo.id)!;
  expect(row.suggestQty).toBe(expected);
  const draft = await createBatchJg(actor, f.wo.id, db);
  expect(draft.qty).toBe(expected);
  const [event] = await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "auto_chain"), eq(s.auditLogs.entityId, draft.id), eq(s.auditLogs.action, "batch_jg")));
  expect(event.after).toMatchObject({ qty: expected, producible: row.producible });
  expect(await db.select().from(s.stockLedger)).toEqual(before);
});

it("a tiny missing material cannot be skipped to generate a full production batch", async () => {
  const f = await fixture();
  const [base] = await db.select().from(s.woLines).where(eq(s.woLines.woId, f.wo.id));
  await db.update(s.woDocs).set({ qty: "1000" }).where(eq(s.woDocs.id, f.wo.id));
  const [material] = await db.insert(s.skus).values({ code: `TINY-${f.wo.id}`, name: "合成微量料", spuId: f.product.spuId, skuType: "packaging", baseUom: "个" }).returning();
  await db.insert(s.woLines).values({ woId: f.wo.id, materialSkuId: material.id, qtyPer: "0.0001", grossReq: "0.0001", suggestedQty: "0.0001" });
  expect(base.materialSkuId).not.toBe(material.id);
  await expect(createBatchJg(actor, f.wo.id, db)).rejects.toMatchObject({ status: 409 });
  expect(await batches(f.wo.id)).toHaveLength(0);
});
