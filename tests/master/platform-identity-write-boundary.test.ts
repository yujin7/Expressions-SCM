import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { claimPlatformSku, claimPlatformSkusBulk } from "@/server/modules/master/platform-sku-claim";
import { fillSkuBarcodesBulk } from "@/server/modules/master/sku-barcode-fill";

// These derived refreshes are not part of identity ownership/transaction proof.
vi.mock("@/server/modules/report/platform-sku-identity-gap", () => ({ refreshPlatformSkuIdentityGap: vi.fn() }));
vi.mock("@/server/modules/report/external-demand-signal", () => ({ refreshJiandaoyunExternalDemandReadModel: vi.fn() }));
vi.mock("@/server/modules/report/external-velocity", () => ({ refreshExternalVelocity: vi.fn() }));

describe("identity writes enforce roles/scopes and shared barcode ownership", () => {
  it.each([
    { roles: ["ops"], channelScope: null, deptScope: null },
    { roles: ["finance"], channelScope: null, deptScope: null },
    { roles: ["pmc"], channelScope: [1], deptScope: null },
    { roles: ["warehouse"], channelScope: [], deptScope: null },
    { roles: ["purchasing"], channelScope: null, deptScope: ["purchasing"] },
  ])("all service entrypoints reject unauthorized actor before any transaction: %j", async policy => {
    const actor = { id: 1, name: "QA", isApprover: false, ...policy };
    const transaction = vi.fn();
    const db = { transaction };
    const item = { shopName: "QA", platformSkuId: "platform-1", skuId: 1 };
    for (const invoke of [
      () => claimPlatformSku(actor, item, db),
      () => claimPlatformSkusBulk(actor, { items: [item] }, db),
      () => fillSkuBarcodesBulk(actor, { items: [{ skuId: 1, barcode: "4006381333931" }] }, db),
    ]) await expect(invoke()).rejects.toMatchObject({ status: 403 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "gtin" as const, active: true }, { kind: "legacy" as const, active: true },
    { kind: "gtin" as const, active: false }, { kind: "legacy" as const, active: false },
  ])("barcode fill preserves reserved ownership even when legacy SKU barcode is empty: %j", async ({ kind, active }) => {
    const { db, client } = await createTestDb();
    try {
      const [user] = await db.insert(schema.users).values({ name: "QA", roles: ["pmc"] }).returning();
      const actor = { id: user.id, name: user.name, roles: ["pmc"], isApprover: false };
      const [spu] = await db.insert(schema.spus).values({ code: "P90001", nameCn: "QA" }).returning();
      const [owner, target] = await db.insert(schema.skus).values([
        { code: "QA-OWNER", name: "Owner", spuId: spu.id, skuType: "finished", baseUom: "件" },
        { code: "QA-TARGET", name: "Target", spuId: spu.id, skuType: "finished", baseUom: "件" },
      ]).returning();
      await db.insert(schema.skuIdentifiers).values({ skuId: owner.id, kind, active, scope: kind === "gtin" ? "GS1" : "INTERNAL", value: "4006381333931", packagingLevel: "each", createdBy: actor.id });
      const result = await fillSkuBarcodesBulk(actor, { items: [{ skuId: target.id, barcode: "4006381333931" }] }, db);
      expect(result).toMatchObject({ filled: 0, unchanged: 0, conflicts: 1 });
      expect(result.results[0].error).toContain("QA-OWNER");
      const [row] = await db.select().from(schema.skus).where(eq(schema.skus.id, target.id));
      expect(row.barcode).toBeNull();
      expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "barcode_fill"))).toHaveLength(0);
    } finally { await client.close(); }
  });

  it("rolls back the barcode when its same-transaction audit insert fails", async () => {
    const { db, client } = await createTestDb();
    try {
      const [user] = await db.insert(schema.users).values({ name: "QA", roles: ["pmc"] }).returning();
      const actor = { id: user.id, name: user.name, roles: ["pmc"], isApprover: false };
      const [spu] = await db.insert(schema.spus).values({ code: "P90001", nameCn: "QA" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "QA-FAULT", name: "QA", spuId: spu.id, skuType: "finished", baseUom: "件" }).returning();
      await db.execute(sql`CREATE FUNCTION qa_identity_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'QA identity audit deliberately rejected'; END; $$`);
      await db.execute(sql`CREATE TRIGGER qa_identity_audit_fault BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION qa_identity_audit_fault()`);
      const result = await fillSkuBarcodesBulk(actor, { items: [{ skuId: sku.id, barcode: "4006381333931" }] }, db);
      expect(result.filled).toBe(0);
      const [row] = await db.select().from(schema.skus).where(eq(schema.skus.id, sku.id));
      expect(row.barcode).toBeNull();
      expect(await db.select().from(schema.auditLogs)).toHaveLength(0);
    } finally { await client.close(); }
  });
});
