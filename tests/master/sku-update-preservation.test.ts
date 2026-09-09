import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { updateSku } from "@/server/modules/master/sku";
import { requireBatchForExpirySkus } from "@/server/modules/inventory/batch-trace";
import { createTestDb, type TestDb } from "../helpers/db";

const deps = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/core/audit", async original => {
  const actual = await original<typeof import("@/server/core/audit")>();
  return { ...actual, writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
    await actual.writeAudit(...args); if (deps.fail) throw new Error("synthetic sku audit failure");
  } };
});
let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], actor: SessionUser;
beforeAll(async () => { ({ db, client } = await createTestDb()); const [u] = await db.insert(schema.users).values({ name: "合成SKU管理员", roles: ["admin"] }).returning(); actor = { id: u.id, name: u.name, roles: ["admin"], isApprover: false }; });
afterAll(async () => client?.close());
async function fixture() {
  const key = randomUUID();
  const [spu] = await db.insert(schema.spus).values({ code: `P-${key}`, nameCn: "合成产品" }).returning();
  const [row] = await db.insert(schema.skus).values({ code: `QA-${key}`, name: "合成精华", spuId: spu.id, skuType: "finished", baseUom: "支",
    lifecycle: "halted", active: false, commercialRole: "sample", shortName: "合成简称", spec: "30ml", version: "V2", prodMode: "委外", lossCategory: "packaging", shelfLifeDays: 1095, nearExpiryDays: 180 }).returning();
  await db.insert(schema.skuParams).values({ skuId: row.id, normalLeadDays: 35, logisticsLeadDays: 7 });
  return { row, base: { name: row.name, spuId: spu.id, skuType: row.skuType, baseUom: row.baseUom } };
}
it("updating a required field preserves omitted lifecycle, enablement, expiry and optional master data", async () => {
  const { row, base } = await fixture();
  const result = await updateSku(row.id, { ...base, name: "已核对合成精华" }, actor, db);
  for (const key of ["lifecycle", "active", "commercialRole", "shortName", "spec", "version", "prodMode", "lossCategory", "shelfLifeDays", "nearExpiryDays"] as const) expect(result[key], key).toEqual(row[key]);
  expect(result.name).toBe("已核对合成精华");
  await expect(requireBatchForExpirySkus(db, [{ skuId: row.id, batchNo: null }])).rejects.toThrow("收货必须填写批次号");
  const [audit] = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, row.id));
  expect(audit.after).toMatchObject({ lifecycle: "halted", active: false, normalLeadDays: 35, logisticsLeadDays: 7 });
});
it("explicit clearing differs from omission, and explicit state changes are not overridden by defaults", async () => {
  const { row, base } = await fixture();
  const changed = await updateSku(row.id, { ...base, lifecycle: "trial", active: true, shelfLifeDays: null, nearExpiryDays: null,
    spec: "", shortName: null, version: null, prodMode: null, lossCategory: null, normalLeadDays: null }, actor, db);
  expect(changed).toMatchObject({ lifecycle: "trial", active: true, shelfLifeDays: null, nearExpiryDays: null, spec: null, shortName: null, version: null, prodMode: null, lossCategory: null, commercialRole: "sample" });
  expect((await db.select().from(schema.skuParams).where(eq(schema.skuParams.skuId, row.id)))[0]).toMatchObject({ normalLeadDays: null, logisticsLeadDays: 7 });
});
it("invalid state or expiry refuses atomically and audit failure rolls back the master and parameters", async () => {
  const { row, base } = await fixture();
  for (const patch of [{ lifecycle: null }, { lifecycle: "enabled" }, { active: null }, { nearExpiryDays: 0 }, { shelfLifeDays: -1 }]) await expect(updateSku(row.id, { ...base, ...patch }, actor, db)).rejects.toThrow();
  deps.fail = true;
  try { await expect(updateSku(row.id, { ...base, active: true, normalLeadDays: 99 }, actor, db)).rejects.toThrow("synthetic sku audit failure"); } finally { deps.fail = false; }
  expect((await db.select().from(schema.skus).where(eq(schema.skus.id, row.id)))[0]).toEqual(row);
  expect((await db.select().from(schema.skuParams).where(eq(schema.skuParams.skuId, row.id)))[0].normalLeadDays).toBe(35);
  expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, row.id))).toHaveLength(0);
});
