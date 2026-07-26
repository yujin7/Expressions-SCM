import { beforeAll, describe, expect, it } from "vitest";
import { skus, spus, transitRefs } from "@/db/schema";
import { getMaterialReferenceLines } from "@/server/core/material-reference";
import { createTestDb, type TestDb } from "../helpers/db";

describe("旧流程包材参考装配", () => {
  let db: TestDb;
  let productSkuId = 0;
  let materialSkuId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "P-MREF", nameCn: "参考测试" }).returning();
    const [product, material, otherMaterial] = await db
      .insert(skus)
      .values([
        { code: "FG-MREF", name: "成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
        { code: "PK-MREF", name: "包材", spuId: spu.id, skuType: "packaging", baseUom: "个" },
        { code: "PK-OTHER", name: "其他包材", spuId: spu.id, skuType: "packaging", baseUom: "个" },
      ])
      .returning();
    productSkuId = product.id;
    materialSkuId = material.id;

    await db.insert(transitRefs).values([
      {
        kind: "pkg_order",
        skuId: product.id,
        materialSkuId: material.id,
        qty: "100",
        revisedDate: "2026-08-09",
        replyDate: "2026-08-08",
        needDate: "2026-08-07",
        externalNo: "PO-LEGACY-1",
        sourceJobId: 1,
      },
      {
        kind: "pkg_order",
        skuId: product.id,
        materialSkuId: material.id,
        qty: "20",
        replyDate: "2026-08-12",
        needDate: "2026-08-11",
        feishuNo: "FS-2",
        sourceJobId: 1,
      },
      {
        kind: "pkg_order",
        skuId: product.id,
        materialSkuId: material.id,
        qty: "0",
        needDate: "2026-08-01",
        sourceJobId: 1,
      },
      {
        kind: "pkg_stock",
        skuId: product.id,
        materialSkuId: material.id,
        qty: "999",
        remainQty: "35",
        expectDate: "2026-08-20",
        approvalNo: "STOCK-1",
        sourceJobId: 1,
      },
      {
        kind: "pkg_stock",
        skuId: product.id,
        materialSkuId: material.id,
        remainQty: "-2",
        sourceJobId: 1,
      },
      {
        kind: "pkg_order",
        skuId: product.id,
        materialSkuId: otherMaterial.id,
        qty: "777",
        sourceJobId: 1,
      },
      {
        kind: "pkg_order",
        skuId: product.id,
        materialCode: "UNRESOLVED",
        qty: "888",
        sourceJobId: 1,
      },
    ]);
  });

  it("只返回命中物料的正数量参考行，并保留成品归属和来源", async () => {
    const lines = await getMaterialReferenceLines(db, [materialSkuId]);
    expect(lines.map((line) => ({
      productSkuId: line.productSkuId,
      qty: line.qty,
      source: line.source,
      ref: line.ref,
    }))).toEqual([
      {
        productSkuId,
        qty: "100.0000",
        source: "legacy_pkg_order",
        ref: "PO-LEGACY-1",
      },
      {
        productSkuId,
        qty: "20.0000",
        source: "legacy_pkg_order",
        ref: "FS-2",
      },
      {
        productSkuId,
        qty: "35.0000",
        source: "legacy_pkg_stock",
        ref: "STOCK-1",
      },
    ]);
  });

  it("包材在途交期优先二次修改→采购回复→需求交期；备料使用日不冒充到货日", async () => {
    const lines = await getMaterialReferenceLines(db, [materialSkuId]);
    expect(lines.map((line) => ({ qty: line.qty, expectDate: line.expectDate }))).toEqual([
      { qty: "100.0000", expectDate: "2026-08-09" },
      { qty: "20.0000", expectDate: "2026-08-12" },
      { qty: "35.0000", expectDate: null },
    ]);
    expect(lines.every((line) => Number.isFinite(Date.parse(line.asOf)))).toBe(true);
  });

  it("空物料集合不查询并直接返回空", async () => {
    expect(await getMaterialReferenceLines(db, [])).toEqual([]);
  });
});
