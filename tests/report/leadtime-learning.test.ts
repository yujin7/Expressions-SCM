import { expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { getLeadTimeLearning, applyLeadTimeSuggestion } from "@/server/modules/report/leadtime-learning";

async function setup() {
  const { db, client } = await createTestDb();
  const [user] = await db.insert(s.users).values({ username: "lead-buyer", name: "采购", roles: ["purchasing"] }).returning();
  const [supplier] = await db.insert(s.suppliers).values({ code: "LT-SUP", name: "交期厂" }).returning();
  const [spu] = await db.insert(s.spus).values({ code: "LT-SPU", nameCn: "交期产品" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "LT-SKU", name: "面霜包材", spuId: spu.id, skuType: "packaging", baseUom: "支" }).returning();
  const [wh] = await db.insert(s.warehouses).values({ code: "LT-WH", name: "包材仓", kind: "raw" }).returning();
  await db.insert(s.skuParams).values({ skuId: sku.id, normalLeadDays: 30, purchaseLeadDays: 40 });
  let seq = 0;
  async function order(dates: (string | null)[] = ["2026-08-20"], status: "draft" | "completed" | "closed" | "void" = "completed", type: "normal" | "rework" | "spare" = "normal", qty = "10") {
    const n = ++seq;
    const [po] = await db.insert(s.poDocs).values({ docNo: `PO-LT-${n}`, status, supplierId: supplier.id, createdBy: user.id, createdAt: new Date("2026-08-01T02:00:00Z") }).returning();
    await db.insert(s.poLines).values(dates.map(expectedDate => ({ poId: po.id, skuId: sku.id, lineType: "packaging" as const, purchaseUom: "支", qty: "10", price: "1.00", expectedDate })));
    const [sh] = await db.insert(s.shDocs).values({ docNo: `SH-LT-${n}`, status: "completed", sourceType: "po", sourceId: po.id, warehouseId: wh.id, createdBy: user.id, createdAt: new Date("2026-08-11T02:00:00Z") }).returning();
    await db.insert(s.shLines).values({ shId: sh.id, skuId: sku.id, lineType: type, actualQty: qty });
    return po;
  }
  return { db, client, user: { id: user.id, name: user.name, roles: ["purchasing"], isApprover: false }, supplier, sku, wh, order };
}

it("one PO with three identical SKU lines remains one sample, not enough to recommend", async () => {
  const x = await setup(); try {
    await x.order(["2026-08-20", "2026-08-20", "2026-08-20"]);
    const result = await getLeadTimeLearning({}, x.db);
    expect(result.rows[0].samples).toBe(1); expect(result.rows[0].suggestLeadDays).toBeNull();
  } finally { await x.client.close(); }
});

it("valid independent orders update only purchase lead time with evidence and a single audit; replay conflicts", async () => {
  const x = await setup(); try {
    await x.order(); await x.order(); await x.order(undefined, "closed");
    const row = (await getLeadTimeLearning({}, x.db)).rows[0];
    expect(row).toMatchObject({ samples: 3, promiseSamples: 3, currentLeadDays: 40, suggestLeadDays: 10, targetField: "purchaseLeadDays" });
    const input = { skuId: x.sku.id, supplierId: x.supplier.id, leadDays: 10, evidenceKey: row.evidenceKey };
    const pmc = { ...x.user, roles: ["pmc"] };
    await expect(applyLeadTimeSuggestion(pmc, input, x.db)).resolves.toMatchObject({ ok: true, leadDays: 10 });
    await expect(applyLeadTimeSuggestion(pmc, input, x.db)).rejects.toMatchObject({ status: 409 });
    expect((await x.db.select().from(s.skuParams))[0]).toMatchObject({ normalLeadDays: 30, purchaseLeadDays: 10 });
    const audit = await x.db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "apply_leadtime_suggestion"));
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ supplierId: x.supplier.id, evidenceKey: row.evidenceKey, purchaseLeadDays: 10 });
  } finally { await x.client.close(); }
});

it("purchasing can fill an empty purchase cycle but cannot override it or use another role", async () => {
  const x = await setup(); try {
    await x.order(); await x.order(); await x.order();
    let row = (await getLeadTimeLearning({}, x.db)).rows[0];
    const input = () => ({ skuId: x.sku.id, supplierId: x.supplier.id, leadDays: 10, evidenceKey: row.evidenceKey });
    await expect(applyLeadTimeSuggestion(x.user, input(), x.db)).rejects.toMatchObject({ status: 403 });
    await expect(applyLeadTimeSuggestion({ ...x.user, roles: ["warehouse"] }, input(), x.db)).rejects.toMatchObject({ status: 403 });
    await x.db.update(s.skuParams).set({ purchaseLeadDays: null }).where(eq(s.skuParams.skuId, x.sku.id));
    row = (await getLeadTimeLearning({}, x.db)).rows[0];
    await expect(applyLeadTimeSuggestion(x.user, input(), x.db)).resolves.toMatchObject({ ok: true });
    expect((await x.db.select().from(s.skuParams))[0].normalLeadDays).toBe(30);
  } finally { await x.client.close(); }
});

it("stale source, stale master, modified suggestion and wrong supplier all refuse without writes", async () => {
  const x = await setup(); try {
    await x.order(); await x.order(); await x.order();
    const row = (await getLeadTimeLearning({}, x.db)).rows[0];
    const input = { skuId: x.sku.id, supplierId: x.supplier.id, leadDays: 10, evidenceKey: row.evidenceKey };
    const pmc = { ...x.user, roles: ["pmc"] };
    await expect(applyLeadTimeSuggestion(pmc, { ...input, leadDays: 2 }, x.db)).rejects.toMatchObject({ status: 409 });
    await expect(applyLeadTimeSuggestion(pmc, { ...input, supplierId: 999 }, x.db)).rejects.toMatchObject({ status: 409 });
    await x.order(); // same P50, but different evidence population
    await expect(applyLeadTimeSuggestion(pmc, input, x.db)).rejects.toMatchObject({ status: 409 });
    const fresh = (await getLeadTimeLearning({}, x.db)).rows[0];
    await x.db.update(s.skuParams).set({ purchaseLeadDays: 50 }).where(eq(s.skuParams.skuId, x.sku.id));
    await expect(applyLeadTimeSuggestion(pmc, { ...input, evidenceKey: fresh.evidenceKey }, x.db)).rejects.toMatchObject({ status: 409 });
    expect(await x.db.select().from(s.auditLogs)).toHaveLength(0);
  } finally { await x.client.close(); }
});

it("finished-product PO history stays observable but never rewrites processing time", async () => {
  const x = await setup(); try {
    await x.order(); await x.order(); await x.order();
    await x.db.update(s.skus).set({ skuType: "finished" }).where(eq(s.skus.id, x.sku.id));
    const row = (await getLeadTimeLearning({}, x.db)).rows[0];
    expect(row).toMatchObject({ samples: 3, p50: 10, targetField: null, suggestLeadDays: null, currentLeadDays: null });
    await expect(applyLeadTimeSuggestion({ ...x.user, roles: ["admin"] }, { skuId: x.sku.id, supplierId: x.supplier.id, leadDays: 10, evidenceKey: row.evidenceKey }, x.db)).rejects.toMatchObject({ status: 409 });
    expect((await x.db.select().from(s.skuParams))[0]).toMatchObject({ normalLeadDays: 30, purchaseLeadDays: 40 });
  } finally { await x.client.close(); }
});

it("first positive normal receipt is one sample; missing promises remain unknown; reading never writes", async () => {
  const x = await setup(); try {
    const po = await x.order([null, "2026-08-20"]);
    const [later] = await x.db.insert(s.shDocs).values({ docNo: "SH-LATER", status: "completed", sourceType: "po", sourceId: po.id, warehouseId: x.wh.id, createdBy: x.user.id, createdAt: new Date("2026-08-15T02:00:00Z") }).returning();
    await x.db.insert(s.shLines).values({ shId: later.id, skuId: x.sku.id, actualQty: "1", lineType: "normal" });
    const row = (await getLeadTimeLearning({}, x.db)).rows[0];
    expect(row).toMatchObject({ samples: 1, p50: 10, promiseSamples: 0, onTimeRate: null });
    expect(await x.db.select().from(s.auditLogs)).toHaveLength(0);
    expect((await x.db.select().from(s.skuParams))[0]).toMatchObject({ normalLeadDays: 30, purchaseLeadDays: 40 });
  } finally { await x.client.close(); }
});

it("audit failure rolls back the purchase-cycle mutation", async () => {
  const x = await setup(); try {
    await x.order(); await x.order(); await x.order();
    const row = (await getLeadTimeLearning({}, x.db)).rows[0];
    await x.db.execute(sql`CREATE FUNCTION reject_lead_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
    await x.db.execute(sql`CREATE TRIGGER reject_lead_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_lead_test_audit()`);
    await expect(applyLeadTimeSuggestion({ ...x.user, roles: ["pmc"] }, { skuId: x.sku.id, supplierId: x.supplier.id, leadDays: 10, evidenceKey: row.evidenceKey }, x.db)).rejects.toThrow();
    expect((await x.db.select().from(s.skuParams))[0]).toMatchObject({ normalLeadDays: 30, purchaseLeadDays: 40 });
  } finally { await x.client.close(); }
});
it("draft PO, zero receipt, rework and spare do not masquerade as normal first delivery", async () => {
  const x = await setup(); try {
    await x.order(undefined, "draft"); await x.order(undefined, "completed", "normal", "0");
    await x.order(undefined, "void");
    await x.order(undefined, "completed", "rework"); await x.order(undefined, "completed", "spare");
    expect((await getLeadTimeLearning({}, x.db)).rows).toEqual([]);
  } finally { await x.client.close(); }
});
it("ambiguous dates on the same PO/SKU do not manufacture an on-time denominator", async () => {
  const x = await setup(); try {
    await x.order(["2026-08-05", "2026-08-20"]);
    const row = (await getLeadTimeLearning({}, x.db)).rows[0];
    expect(row.samples).toBe(1); expect(row.onTimeRate).toBeNull();
  } finally { await x.client.close(); }
});
it("an ungrounded value cannot be posted as a learned suggestion", async () => {
  const x = await setup(); try {
    await expect(applyLeadTimeSuggestion(x.user, { skuId: x.sku.id, leadDays: 2 }, x.db)).rejects.toThrow();
    expect((await x.db.select().from(s.skuParams).where(eq(s.skuParams.skuId, x.sku.id)))[0].normalLeadDays).toBe(30);
  } finally { await x.client.close(); }
});
