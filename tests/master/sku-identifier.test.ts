import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, skuIdentifiers, skus, spus, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import {
  createSkuIdentifier,
  listSkuIdentifiers,
  setSkuIdentifierActive,
  setSkuIdentifierPrimary,
} from "@/server/modules/master/sku-identifier";
import { resolveKnownReference } from "@/server/modules/dimension/resolver";

describe("SKU 多标识治理", () => {
  it("登记主 GTIN 同步兼容条码、可解析、可审计并可安全停用", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(users).values({ username: "identifier-admin", name: "标识管理员" }).returning();
    const [spu] = await db.insert(spus).values({ code: "P99801", nameCn: "多标识测试" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "S1-EXP-F-000001-00",
      name: "测试成品",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "盒",
    }).returning();
    const actor = { id: user.id, name: user.name, roles: ["admin"], isApprover: true };

    const gtin = await createSkuIdentifier(sku.id, {
      kind: "gtin",
      value: "6901234567892",
      packagingLevel: "each",
      uom: "盒",
      isPrimary: true,
    }, actor, db);
    await createSkuIdentifier(sku.id, {
      kind: "external",
      value: "JST-EXP-001",
      scope: "JST",
    }, actor, db);

    const [storedSku] = await db.select().from(skus).where(eq(skus.id, sku.id));
    expect(storedSku).toMatchObject({ barcode: "6901234567892", barcodeStatus: "valid" });
    expect(await resolveKnownReference(db, "sku_barcode", "6901234567892")).toBe(sku.id);
    expect(await resolveKnownReference(db, "sku_code", "JST-EXP-001")).toBe(sku.id);
    expect(await listSkuIdentifiers(sku.id, db)).toHaveLength(2);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.entity, "sku_identifier"))).toHaveLength(2);

    const replacement = await createSkuIdentifier(sku.id, {
      kind: "gtin",
      value: "96385074",
      packagingLevel: "each",
      uom: "盒",
      isPrimary: true,
    }, actor, db);
    const [demoted] = await db
      .select()
      .from(skuIdentifiers)
      .where(eq(skuIdentifiers.id, gtin.id));
    expect(demoted.isPrimary).toBe(false);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, "demote_primary")),
    ).toHaveLength(1);

    await setSkuIdentifierActive(sku.id, replacement.id, false, actor, db);
    const [deactivatedSku] = await db.select().from(skus).where(eq(skus.id, sku.id));
    expect(deactivatedSku).toMatchObject({ barcode: null, barcodeStatus: null });
    const [deactivated] = await db
      .select()
      .from(skuIdentifiers)
      .where(eq(skuIdentifiers.id, replacement.id));
    expect(deactivated).toMatchObject({ active: false, isPrimary: false });

    await setSkuIdentifierActive(sku.id, replacement.id, true, actor, db);
    const reactivated = await setSkuIdentifierPrimary(
      sku.id,
      replacement.id,
      actor,
      db,
    );
    expect(reactivated).toMatchObject({ active: true, isPrimary: true });
    const [restoredSku] = await db.select().from(skus).where(eq(skus.id, sku.id));
    expect(restoredSku).toMatchObject({ barcode: "96385074", barcodeStatus: "valid" });
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, "promote_primary")),
    ).toHaveLength(1);
  });

  it("GTIN 不能跨 SKU 重复，旧条码冲突也不会被静默抢占", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(users).values({ username: "identifier-guard", name: "防重" }).returning();
    const [spu] = await db.insert(spus).values({ code: "P99802", nameCn: "防重测试" }).returning();
    const [first, second] = await db.insert(skus).values([
      { code: "ID-A", name: "A", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "ID-B", name: "B", spuId: spu.id, skuType: "finished", baseUom: "盒", barcode: "00012345600012" },
    ]).returning();
    const actor = { id: user.id, name: user.name, roles: ["admin"], isApprover: true };

    await expect(createSkuIdentifier(first.id, {
      kind: "gtin",
      value: "00012345600012",
      packagingLevel: "case",
      isPrimary: true,
    }, actor, db)).rejects.toThrow(`SKU ${second.code}`);

    await createSkuIdentifier(first.id, {
      kind: "gtin",
      value: "6901234567892",
      packagingLevel: "each",
      isPrimary: true,
    }, actor, db);
    await expect(createSkuIdentifier(second.id, {
      kind: "gtin",
      value: "6901234567892",
      packagingLevel: "each",
    }, actor, db)).rejects.toThrow(`SKU ${first.code}`);
    await expect(createSkuIdentifier(first.id, {
      kind: "gtin",
      value: "6901234567892",
      packagingLevel: "each",
    }, actor, db)).rejects.toThrow("该标识已登记");

    await db.insert(skuIdentifiers).values({
      skuId: second.id,
      kind: "legacy",
      value: "96385074",
      scope: "LEGACY_BARCODE",
    });
    await expect(createSkuIdentifier(first.id, {
      kind: "gtin",
      value: "96385074",
      packagingLevel: "each",
    }, actor, db)).rejects.toThrow(`SKU ${second.code}`);

    await expect(createSkuIdentifier(second.id, {
      kind: "legacy",
      value: "6901234567892",
      scope: "LEGACY_BARCODE",
    }, actor, db)).rejects.toThrow(`SKU ${first.code}`);

    const [conflictingInactive] = await db.insert(skuIdentifiers).values({
      skuId: second.id,
      kind: "legacy",
      value: "6901234567892",
      scope: "PREEXISTING_DIRTY_DATA",
      active: false,
    }).returning();
    await expect(
      setSkuIdentifierActive(second.id, conflictingInactive.id, true, actor, db),
    ).rejects.toThrow(`SKU ${first.code}`);
  });
});
