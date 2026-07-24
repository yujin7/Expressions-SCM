import { beforeAll, describe, expect, it } from "vitest";
import {
  bomLines, boms, brands, channels, poDocs, poLines, salesMonthly, shDocs, spus, skus,
  stockBalances, stockDocs, stockLedger, stockSnapshots, suppliers, users, warehouses, woDocs,
} from "@/db/schema";
import { getSkuPanorama } from "@/server/modules/master/sku-panorama";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * SKU 360° 全景：纯数量口径（不出任何金额键）；
 * 快照取最新 bizDate；PO 未收数=qty×factor−receivedQty>0；流水单号按来源表批量解析。
 */
describe("SKU 全景 getSkuPanorama", () => {
  let db: TestDb;
  let skuId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());

    const [admin] = await db.insert(users).values({ name: "管理员", roles: ["admin"], isApprover: true }).returning();
    const uid = admin.id;

    const [brand] = await db.insert(brands).values({ code: "NING", nameCn: "宁品牌" }).returning();
    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "胶原蛋白肽" }).returning();
    const [sku] = await db
      .insert(skus)
      .values({
        code: "CP00001", name: "胶原蛋白肽 50ml×10", spuId: spu.id, baseUom: "盒",
        skuType: "finished", spec: "50ml×10", brandId: brand.id,
        attrs: { needsReview: true },
      })
      .returning();
    skuId = sku.id;
    const [mat] = await db
      .insert(skus)
      .values({ code: "YL00001", name: "原料", spuId: spu.id, baseUom: "kg", skuType: "raw" })
      .returning();

    const [whFin] = await db.insert(warehouses).values({ code: "WH1", name: "成品仓", kind: "finished" }).returning();
    const [whSnap] = await db
      .insert(warehouses)
      .values({ code: "WHS", name: "云仓", kind: "snapshot", accountingMode: "snapshot" })
      .returning();

    /* 实时余额 + 快照（两日期，取最新） */
    await db.insert(stockBalances).values([
      { skuId: sku.id, warehouseId: whFin.id, batchId: null, qty: "100" },
      { skuId: mat.id, warehouseId: whFin.id, batchId: null, qty: "7" }, // 他品不串
    ]);
    await db.insert(stockSnapshots).values([
      { warehouseId: whSnap.id, skuId: sku.id, bizDate: "2026-07-01", qty: "50" },
      { warehouseId: whSnap.id, skuId: sku.id, bizDate: "2026-07-20", qty: "60" },
    ]);

    /* 效期批次：qty=0 行剔除；按到期日升序 */
    const { batchStocks } = await import("@/db/schema");
    await db.insert(batchStocks).values([
      { skuId: sku.id, warehouseId: whFin.id, batchNo: "B2", expiryDate: "2026-12-31", qty: "40", stocktakeDate: "2026-07-01" },
      { skuId: sku.id, warehouseId: whFin.id, batchNo: "B1", expiryDate: "2026-08-15", qty: "10", stocktakeDate: "2026-07-01" },
      { skuId: sku.id, warehouseId: whFin.id, batchNo: "B0", expiryDate: "2026-08-01", qty: "0", stocktakeDate: "2026-07-01" },
    ]);

    /* 销量：两渠道两月（窗口=近6月自动回推，缺月补0） */
    const [ch1] = await db.insert(channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
    const [ch2] = await db.insert(channels).values({ code: "pdd", name: "拼多多", kind: "platform" }).returning();
    await db.insert(salesMonthly).values([
      { skuId: sku.id, channelId: ch1.id, yearMonth: "2026-05", qty: "100" },
      { skuId: sku.id, channelId: ch1.id, yearMonth: "2026-06", qty: "200" },
      { skuId: sku.id, channelId: ch2.id, yearMonth: "2026-06", qty: "50" },
    ]);

    /* 在途 PO：行1 open=10×12−20=100；行2 收完不计；draft 单不计 */
    const [sup] = await db.insert(suppliers).values({ code: "S001", name: "供应商甲" }).returning();
    const [po1] = await db
      .insert(poDocs)
      .values({ docNo: "PO-P-1", status: "in_progress", supplierId: sup.id, expectedDate: "2026-08-01", createdBy: uid })
      .returning();
    const [poDraft] = await db
      .insert(poDocs)
      .values({ docNo: "PO-P-2", status: "draft", supplierId: sup.id, createdBy: uid })
      .returning();
    await db.insert(poLines).values([
      { poId: po1.id, skuId: sku.id, lineType: "raw", purchaseUom: "箱", uomFactor: "12", qty: "10", price: "5.00", receivedQty: "20" },
      { poId: po1.id, skuId: sku.id, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "1", price: "5.00", receivedQty: "10" },
      { poId: poDraft.id, skuId: sku.id, lineType: "raw", purchaseUom: "箱", uomFactor: "12", qty: "99", price: "5.00" },
    ]);

    /* 在制 WO（产出=本品） */
    const [bom] = await db.insert(boms).values({ productSkuId: sku.id, versionNo: "V2", status: "active" }).returning();
    await db.insert(bomLines).values([
      { bomId: bom.id, materialSkuId: mat.id, qtyPer: "0.5" },
      { bomId: bom.id, materialSkuId: sku.id, qtyPer: "1" },
    ]);
    await db.insert(woDocs).values([
      {
        docNo: "WO-P-1", status: "in_progress", productSkuId: sku.id, qty: "500",
        supplierId: sup.id, feeRatePlan: "2.00", bomId: bom.id, createdBy: uid,
      },
      {
        docNo: "WO-P-2", status: "completed", productSkuId: sku.id, qty: "300",
        supplierId: sup.id, feeRatePlan: "2.00", bomId: bom.id, createdBy: uid,
      },
    ]);

    /* 流水：stock_doc 载体（opening）+ SH 载体（sh_purchase_in），单号应解析 */
    const [rk] = await db
      .insert(stockDocs)
      .values({ docNo: "RK-P-1", status: "completed", subtype: "opening", createdBy: uid })
      .returning();
    const [sh] = await db
      .insert(shDocs)
      .values({ docNo: "SH-P-1", status: "completed", sourceType: "po", sourceId: po1.id, warehouseId: whFin.id, createdBy: uid })
      .returning();
    await db.insert(stockLedger).values([
      {
        skuId: sku.id, warehouseId: whFin.id, qtyDelta: "100", sourceDocType: "opening",
        sourceDocId: rk.id, sourceLineId: 1, action: "post", occurredAt: new Date("2026-07-10T08:00:00+08:00"),
      },
      {
        skuId: sku.id, warehouseId: whFin.id, qtyDelta: "-6", sourceDocType: "sh_purchase_in",
        sourceDocId: sh.id, sourceLineId: 1, action: "post", occurredAt: new Date("2026-07-15T08:00:00+08:00"),
      },
    ]);
  });

  it("happy path：各区块形状与口径正确", async () => {
    const p = await getSkuPanorama(skuId, db);

    /* 头部 */
    expect(p.sku).toMatchObject({
      code: "CP00001", brandName: "宁品牌", spuCode: "P00001", spuName: "胶原蛋白肽",
      skuType: "finished", lifecycle: "on_sale",
    });
    expect((p.sku.attrs as { needsReview?: boolean }).needsReview).toBe(true);

    /* 库存：实时 1 行（他品不串）；快照取最新 2026-07-20=60 且带数据龄 */
    expect(p.balances).toHaveLength(1);
    expect(p.balances[0]).toMatchObject({ warehouseName: "成品仓", warehouseKind: "finished" });
    expect(Number(p.balances[0].qty)).toBe(100);
    expect(p.snapshots).toHaveLength(1);
    expect(p.snapshots[0]).toMatchObject({ warehouseName: "云仓", bizDate: "2026-07-20" });
    expect(Number(p.snapshots[0].qty)).toBe(60);
    expect(p.snapshots[0].ageDays).toBeGreaterThanOrEqual(0);

    /* 效期：qty=0 剔除；到期日升序；带 daysLeft */
    expect(p.batches.map((b) => b.batchNo)).toEqual(["B1", "B2"]);
    expect(typeof p.batches[0].daysLeft).toBe("number");

    /* 销量：窗口 6 个月止于 2026-06；月合计跨渠道；TOP 渠道排序 */
    expect(p.sales.months).toHaveLength(6);
    expect(p.sales.months[5]).toBe("2026-06");
    const jun = p.sales.byMonth.find((m) => m.month === "2026-06");
    expect(jun?.qty).toBe(250);
    const may = p.sales.byMonth.find((m) => m.month === "2026-05");
    expect(may?.qty).toBe(100);
    expect(p.sales.topChannels[0]).toMatchObject({ name: "天猫", qty: 300 });
    expect(p.sales.topChannels[1]).toMatchObject({ name: "拼多多", qty: 50 });

    /* 在途：仅未收完且已审/执行中的行 */
    expect(p.openDocs.poLines).toHaveLength(1);
    expect(p.openDocs.poLines[0]).toMatchObject({ docNo: "PO-P-1", supplierName: "供应商甲" });
    expect(Number(p.openDocs.poLines[0].openQty)).toBe(100);
    /* 在制：completed 的 WO 不计 */
    expect(p.openDocs.woDocs).toHaveLength(1);
    expect(p.openDocs.woDocs[0].docNo).toBe("WO-P-1");

    /* 流水：倒序、来源单号解析成功 */
    expect(p.ledger).toHaveLength(2);
    expect(p.ledger[0]).toMatchObject({ sourceDocType: "sh_purchase_in", docNo: "SH-P-1" });
    expect(p.ledger[1]).toMatchObject({ sourceDocType: "opening", docNo: "RK-P-1" });

    /* BOM */
    expect(p.activeBom).toMatchObject({ versionNo: "V2", lineCount: 2 });

    /* R9：纯数量口径——载荷中不得出现敏感金额键 */
    const raw = JSON.stringify(p);
    for (const k of ["\"price\"", "\"feeRatePlan\"", "\"feeRateCurrent\"", "\"settleAmount\"", "\"amount\""]) {
      expect(raw).not.toContain(k);
    }
  });

  it("SKU 不存在 → 404", async () => {
    await expect(getSkuPanorama(999999, db)).rejects.toMatchObject({ status: 404 });
  });
});
