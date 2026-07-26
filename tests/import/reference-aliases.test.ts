import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { resolveReferenceAliases } from "@/server/import/reference-aliases";
import { createTestDb } from "../helpers/db";

describe("自定义参考层导入：别名治理", () => {
  it("精确主档码直接解析；真正未知值去重入队；占位符不制造噪音", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(schema.spus).values({ code: "PREF01", nameCn: "参考层" }).returning();
    const [sku] = await db
      .insert(schema.skus)
      .values({
        code: "REF-001",
        name: "参考 SKU",
        spuId: spu.id,
        baseUom: "件",
        skuType: "finished",
        barcode: "6900000000001",
      })
      .returning();

    const summary = await resolveReferenceAliases(db, {
      filePath: "/tmp/stock.xlsx",
      template: "stock_summary",
      rows: [
        {
          rowNo: 1,
          targetTable: "transit_ref",
          payload: { skuCode: "REF-001", barcode: "6900000000001", supplier: "/" },
        },
        {
          rowNo: 2,
          targetTable: "transit_ref",
          payload: { skuCode: "UNKNOWN-1", barcode: "6999999999999", supplier: "NEW-OEM" },
        },
        {
          rowNo: 3,
          targetTable: "transit_ref",
          payload: { skuCode: "UNKNOWN-1", barcode: null, supplier: "NEW-OEM" },
        },
      ],
      aliasRefs: (row) => {
        const p = row.payload as { skuCode: string; barcode: string | null; supplier: string };
        return [
          { field: "sku", aliasType: "sku_code", value: p.skuCode },
          { field: "barcode", aliasType: "sku_barcode", value: p.barcode },
          { field: "supplier", aliasType: "supplier_oem", value: p.supplier },
        ];
      },
    });

    expect(summary.validated).toBe(1);
    expect(summary.pending).toBe(2);
    expect(summary.unresolved).toEqual({ sku_code: 1, sku_barcode: 1, supplier_oem: 1 });
    expect((summary.rows[0].payload as { _resolved: Record<string, number> })._resolved).toEqual({
      skuId: sku.id,
      barcodeId: sku.id,
    });

    const exceptions = await db.select().from(schema.aliasExceptions);
    expect(exceptions).toHaveLength(3);
    expect(exceptions.filter((row) => row.rawValue === "UNKNOWN-1")).toHaveLength(1);
    expect(exceptions.some((row) => row.rawValue === "/")).toBe(false);
    expect(
      (await db
        .select()
        .from(schema.aliasExceptions)
        .where(eq(schema.aliasExceptions.aliasType, "supplier_oem")))[0].context,
    ).toMatchObject({ template: "stock_summary", reason: "not_found" });
  });
});
