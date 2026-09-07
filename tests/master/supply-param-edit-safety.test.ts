import { afterEach, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditLogs, skuParams } from "@/db/schema";
import { patchSupplyParams } from "@/server/modules/master/sku-supply-params-fill";
import { bulkFillSupplyParams } from "@/server/modules/master/sku-supply-params-bulk";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

let db: TestDb, w: TierWorld, close: () => Promise<void>;
beforeEach(async () => { const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close(); w = await seedTierWorld(db); });
afterEach(async () => close());

it("stale row edit refuses atomically; refreshed baseline is an explicit new decision", async () => {
  await patchSupplyParams(w.pmc, w.sku.A, { normalLeadDays: 20 }, db);
  await expect(patchSupplyParams(w.pmc, w.sku.A, { normalLeadDays: 30, logisticsLeadDays: 8, expected: { normalLeadDays: null, logisticsLeadDays: null } }, db)).rejects.toMatchObject({ status: 409 });
  expect((await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.A)))[0]).toMatchObject({ normalLeadDays: 20, logisticsLeadDays: null });
  expect(await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku_params"))).toHaveLength(1);
  await patchSupplyParams(w.pmc, w.sku.A, { normalLeadDays: 30, expected: { normalLeadDays: 20 } }, db);
  await expect(patchSupplyParams(w.purchasing, w.sku.A, { normalLeadDays: 40, expected: { normalLeadDays: 30 } }, db)).rejects.toMatchObject({ status: 403 });
});

it("lost row response can be reconciled by same value without a second audit", async () => {
  const input = { normalLeadDays: 30, expected: { normalLeadDays: null } };
  await patchSupplyParams(w.purchasing, w.sku.A, input, db);
  expect(await patchSupplyParams(w.purchasing, w.sku.A, input, db)).toMatchObject({ normalLeadDays: 30 });
  expect(await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku_params"))).toHaveLength(1);
});

it("bulk scope carries q and missing exactly, including explicit no-missing-filter", async () => {
  const input = { scope: { kind: "filter", q: "TIER-A", missing: "logistics", onlyMissing: false }, values: { normalLeadDays: 25 } };
  const preview = await bulkFillSupplyParams(w.pmc, { ...input, dryRun: true }, db);
  expect(preview.matched).toBe(1); expect(preview.sampleCodes).toEqual(["TIER-A"]);
  const result = await bulkFillSupplyParams(w.pmc, { ...input, expectedPreview: preview.previewKey }, db);
  expect(result.changedSkus).toBe(1);
  expect(await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.C))).toHaveLength(0);
});

it("changed preview facts, values or targets reject the entire batch", async () => {
  const input = { scope: { kind: "ids", ids: [w.sku.A, w.sku.C] }, values: { normalLeadDays: 30 }, overwrite: true };
  const preview = await bulkFillSupplyParams(w.pmc, { ...input, dryRun: true }, db);
  await expect(bulkFillSupplyParams(w.pmc, { ...input, values: { normalLeadDays: 31 }, expectedPreview: preview.previewKey }, db)).rejects.toMatchObject({ status: 409 });
  await patchSupplyParams(w.pmc, w.sku.A, { normalLeadDays: 20 }, db);
  await expect(bulkFillSupplyParams(w.pmc, { ...input, expectedPreview: preview.previewKey }, db)).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.C))).toHaveLength(0);
  expect(await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku_params"))).toHaveLength(1);
});

it("audit failure rolls back all values in a confirmed bulk write", async () => {
  const input = { scope: { kind: "ids", ids: [w.sku.A, w.sku.C] }, values: { normalLeadDays: 30 } };
  const preview = await bulkFillSupplyParams(w.pmc, { ...input, dryRun: true }, db);
  await db.execute(sql`CREATE FUNCTION qa_supply_audit_fail() RETURNS trigger AS $$ BEGIN IF NEW.entity = 'sku_params' THEN RAISE EXCEPTION 'QA audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await db.execute(sql`CREATE TRIGGER qa_supply_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION qa_supply_audit_fail()`);
  await expect(bulkFillSupplyParams(w.pmc, { ...input, expectedPreview: preview.previewKey }, db)).rejects.toThrow();
  expect(await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.A))).toHaveLength(0);
  expect(await db.select().from(skuParams).where(eq(skuParams.skuId, w.sku.C))).toHaveLength(0);
});
