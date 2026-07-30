import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { claimException } from "@/server/modules/import-review/service";
import { createTestDb, type TestDb } from "../helpers/db";

describe("别名认领：立即传播到参考层关系", () => {
  let db: TestDb;
  let user: { id: number; name: string; roles: string[]; isApprover: boolean };
  let productSkuId: number;
  let materialSkuId: number;
  let supplierId: number;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [u] = await db
      .insert(schema.users)
      .values({ name: "数据管理员", roles: ["admin"], isApprover: true })
      .returning();
    user = { id: u.id, name: u.name, roles: ["admin"], isApprover: true };
    const [spu] = await db.insert(schema.spus).values({ code: "PROP01", nameCn: "传播测试" }).returning();
    const [product] = await db
      .insert(schema.skus)
      .values({ code: "PROP-FG", name: "成品", spuId: spu.id, baseUom: "件", skuType: "finished" })
      .returning();
    const [material] = await db
      .insert(schema.skus)
      .values({ code: "PROP-MAT", name: "包材", spuId: spu.id, baseUom: "个", skuType: "packaging" })
      .returning();
    const [supplier] = await db
      .insert(schema.suppliers)
      .values({ code: "PROP-SUP", name: "传播供应商", status: "qualified" })
      .returning();
    productSkuId = product.id;
    materialSkuId = material.id;
    supplierId = supplier.id;
  });

  it("SKU/物料/供应商认领后无需重导即可更新现有 transit_refs", async () => {
    await db.insert(schema.transitRefs).values([
      {
        kind: "pkg_order",
        skuCode: "EXT-FG",
        materialCode: "EXT-MAT",
        oemRaw: "EXT-SUP",
        sourceJobId: 1,
      },
      {
        kind: "pkg_stock",
        materialCode: "EXT-MAT",
        sourceJobId: 1,
      },
    ]);
    const exceptions = await db
      .insert(schema.aliasExceptions)
      .values([
        { aliasType: "sku_code", rawValue: "EXT-FG", status: "open", context: { field: "sku" } },
        { aliasType: "sku_code", rawValue: "EXT-MAT", status: "open", context: { field: "materialSku" } },
        { aliasType: "supplier_oem", rawValue: "EXT-SUP", status: "open", context: { field: "supplier" } },
      ])
      .returning();

    await claimException(user, exceptions[0].id, productSkuId, db);
    await claimException(user, exceptions[1].id, materialSkuId, db);
    await claimException(user, exceptions[2].id, supplierId, db);

    const rows = await db.select().from(schema.transitRefs).orderBy(schema.transitRefs.id);
    expect(rows[0]).toMatchObject({
      skuId: productSkuId,
      materialSkuId,
      supplierId,
    });
    expect(rows[1].materialSkuId).toBe(materialSkuId);
    const open = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.status, "open"));
    expect(open).toHaveLength(0);
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entity, "alias_exception"));
    expect(audits).toHaveLength(3);
    expect(audits.map((row) => row.after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ propagatedProductRows: 1 }),
        expect.objectContaining({ propagatedMaterialRows: 2 }),
        expect.objectContaining({ propagatedSupplierRows: 1 }),
      ]),
    );
  });

  it("外部系统 SKU 认领同时登记 scoped identifier，且不污染 GLOBAL 参考层", async () => {
    await db.insert(schema.transitRefs).values({
      kind: "fg_order",
      skuCode: "SHARED-001",
      sourceJobId: 1,
    });
    const [exception] = await db
      .insert(schema.aliasExceptions)
      .values({
        aliasType: "sku_code",
        scope: "JIANDAOYUN",
        rawValue: "SHARED-001",
        status: "open",
        context: { connector: "jdy", field: "productCode" },
      })
      .returning();

    await claimException(user, exception.id, productSkuId, db);

    const [identifier] = await db
      .select()
      .from(schema.skuIdentifiers)
      .where(eq(schema.skuIdentifiers.value, "SHARED-001"));
    expect(identifier).toMatchObject({
      skuId: productSkuId,
      kind: "external",
      scope: "JIANDAOYUN",
      active: true,
    });
    const [alias] = await db
      .select()
      .from(schema.aliases)
      .where(eq(schema.aliases.rawValue, "SHARED-001"));
    expect(alias).toMatchObject({
      targetId: productSkuId,
      scope: "JIANDAOYUN",
    });
    const [transit] = await db.select().from(schema.transitRefs);
    expect(transit.skuId).toBeNull();
    const [audit] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entity, "alias_exception"));
    expect(audit.after).toMatchObject({
      scope: "JIANDAOYUN",
      externalSkuIdentifierId: identifier.id,
      externalSkuIdentifierCreated: true,
      propagatedProductRows: 0,
    });
  });

  it("外部系统码已属于另一 SKU 时整笔认领回滚", async () => {
    await db.insert(schema.skuIdentifiers).values({
      skuId: materialSkuId,
      kind: "external",
      value: "CONFLICT-001",
      scope: "JIANDAOYUN",
    });
    const [exception] = await db
      .insert(schema.aliasExceptions)
      .values({
        aliasType: "sku_code",
        scope: "JIANDAOYUN",
        rawValue: "CONFLICT-001",
        status: "open",
        context: { connector: "jdy" },
      })
      .returning();

    await expect(
      claimException(user, exception.id, productSkuId, db),
    ).rejects.toThrow("请先完成人工归属裁决");

    const [stillOpen] = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.id, exception.id));
    expect(stillOpen.status).toBe("open");
    expect(
      await db.select().from(schema.aliases).where(eq(schema.aliases.rawValue, "CONFLICT-001")),
    ).toHaveLength(0);
  });
});
