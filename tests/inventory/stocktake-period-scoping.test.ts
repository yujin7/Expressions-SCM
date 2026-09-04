/**
 * 批次参考层（`batch_stocks`）**盘点期间收口**——一次盘完，六个读口径必须一致。
 *
 * 背景（真实口径事故）：`batch_stocks` 的唯一键含 `stocktake_date`，同一批实物货在
 * **每个盘点期间**各有一行，多期并存是正常状态。谁直接把全表相加，效期量/临期批次数
 * 就随盘点次数成倍虚增（两期 ≈ ×2）。唯一权威是 `core/stock-view.latestStocktakeRows`
 * （逐仓取该仓最大 `stocktake_date`），分批查询的调用方还必须传
 * `loadLatestStocktakeDates(db)` 的整表权威期——否则「本批 SKU 在该仓出现过的最新期」
 * 会被当成「该仓最新期」，退回旧期。
 *
 * 本文件对**每一个读者**各钉一条：两期并存（旧期 7-01、新期 8-01，且新期数量已减半、
 * 旧期还留着一批已过期货），断言读出来的是新期一份，不是两期相加。
 * 收口前这些断言全部为「两期之和」——本文件即为回归证据。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  batches, batchStocks, brands, channels, salesMonthly, skuParams, skus, spus, stockBalances, stockLedger, users, warehouses,
} from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { listExpiryBatches } from "@/server/modules/inventory/expiry-list";
import { traceBatch } from "@/server/modules/inventory/batch-trace";
import { getSkuBrief } from "@/server/modules/master/sku-brief";
import { getSkuPanorama } from "@/server/modules/master/sku-panorama";
import { computeExceptions, getWorkbenchFocus } from "@/server/modules/workbench/focus";
import { getTransferSuggestions } from "@/server/modules/report/transfer-suggest";
import { todayShanghai } from "@/server/modules/master/common";

/** 旧盘点期（应被整期忽略） */
const OLD_PERIOD = "2026-07-01";
/** 新盘点期（唯一有效期） */
const NEW_PERIOD = "2026-08-01";

function plusDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe("批次参考层：盘点期间收口（两期并存不得翻倍）", () => {
  let db: TestDb;
  let skuId = 0;
  let skuCode = "";
  let whAId = 0;
  let whBId = 0;
  /** 只在**旧期**出现过的 SKU（新期已盘掉）——按 SKU 子集查询时最容易退回旧期 */
  let goneSkuId = 0;
  const today = todayShanghai();
  /** 近效期（落在 90 天内，且未过期） */
  const nearExpiry = plusDays(today, 30);
  /** 已过期 */
  const expired = plusDays(today, -10);

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(users).values({ name: "系统管理员", roles: ["admin"], isApprover: true });
    const [brand] = await db.insert(brands).values({ code: "BR-ST", nameCn: "盘点期品牌" }).returning();
    const [spu] = await db.insert(spus).values({ code: "P90001", nameCn: "盘点期测试品" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "CP90001", name: "盘点期成品", spuId: spu.id, brandId: brand.id,
      baseUom: "盒", skuType: "finished", active: true,
    }).returning();
    skuId = sku.id;
    skuCode = sku.code;

    const [whA] = await db.insert(warehouses).values({
      code: "WH-A", name: "盈余仓A", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();
    const [whB] = await db.insert(warehouses).values({
      code: "WH-B", name: "缺口仓B", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();
    whAId = whA.id;
    whBId = whB.id;

    /* ── 两期并存：同一批货 LOT-1（旧期 600 → 新期 300），
          外加一批旧期还挂着、新期已处置掉的过期货 LOT-EXP。 ── */
    await db.insert(batchStocks).values([
      // 旧期（7-01）——必须整期被忽略
      { skuId, warehouseId: whAId, batchNo: "LOT-1", qty: "600", expiryDate: nearExpiry, stocktakeDate: OLD_PERIOD },
      { skuId, warehouseId: whAId, batchNo: "LOT-EXP", qty: "200", expiryDate: expired, stocktakeDate: OLD_PERIOD },
      // 新期（8-01）——唯一有效
      { skuId, warehouseId: whAId, batchNo: "LOT-1", qty: "300", expiryDate: nearExpiry, stocktakeDate: NEW_PERIOD },
    ]);

    /* 只在旧期出现的 SKU：新期已把这批过期货处置掉，新期不再有它的行。
       按 `?skuIds=` 子集查询时，若只用本批 rows 推断「该仓最新期」，就会把旧期当成最新期。 */
    const [gone] = await db.insert(skus).values({
      code: "CP90002", name: "旧期遗留成品", spuId: spu.id, brandId: brand.id,
      baseUom: "盒", skuType: "finished", active: true,
    }).returning();
    goneSkuId = gone.id;
    await db.insert(batchStocks).values([
      { skuId: goneSkuId, warehouseId: whAId, batchNo: "LOT-GONE", qty: "500", expiryDate: expired, stocktakeDate: OLD_PERIOD },
    ]);
    // A 仓账面还有 400（呆滞盈余仓），B 仓在发货（缺口仓）
    await db.insert(stockBalances).values([
      { skuId: goneSkuId, warehouseId: whAId, batchId: null, qty: "400.0000" },
    ]);

    /* 批次登记（batch-trace 的入口要求批次已登记） */
    await db.insert(batches).values({
      batchNo: "LOT-1", skuId, prodDate: "2026-01-02", expiryDate: nearExpiry,
      sourceDocType: "sh", sourceDocId: 1,
    });

    /* 账面在库：A 仓 300（与新期批次一致），B 仓 0 —— 供调拨建议用 */
    await db.insert(stockBalances).values([
      { skuId, warehouseId: whAId, batchId: null, qty: "300.0000" },
    ]);

    /* B 仓有出库历史（证明确实在此仓发货）；A 仓无出库 = 呆滞盈余仓 */
    const recent = new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 86_400_000);
    await db.insert(stockLedger).values([
      {
        skuId, warehouseId: whBId, batchId: null, qtyDelta: "-900.0000",
        sourceDocType: "sales_out", sourceDocId: 1, action: "post", occurredAt: recent,
      },
      {
        skuId: goneSkuId, warehouseId: whBId, batchId: null, qtyDelta: "-900.0000",
        sourceDocType: "sales_out", sourceDocId: 2, action: "post", occurredAt: recent,
      },
    ]);

    const [ch] = await db.insert(channels).values({ code: "CH-ST", name: "盘点期渠道", kind: "platform" }).returning();
    await db.insert(salesMonthly).values([
      { skuId, yearMonth: "2026-08", channelId: ch.id, qty: "900" },
      { skuId: goneSkuId, yearMonth: "2026-08", channelId: ch.id, qty: "900" },
    ]);
    await db.insert(skuParams).values([
      { skuId, normalLeadDays: 30, logisticsLeadDays: 5 },
      { skuId: goneSkuId, normalLeadDays: 30, logisticsLeadDays: 5 },
    ]);
  });

  it("效期清单 /inventory/expiry：只出新期一行 300，旧期 600 与旧期过期批次都不出现", async () => {
    const res = await listExpiryBatches({ page: 1, pageSize: 50, bucket: "all" }, db);
    const mine = res.rows.filter((r) => r.skuId === skuId);
    expect(mine.map((r) => [r.batchNo, r.qty])).toEqual([["LOT-1", 300]]);
    // 收口前：m3 段位会有两行（旧期 600 + 新期 300），已过期段位还多出旧期那 200
    expect(res.bucketCounts.m3).toEqual({ batches: 1, qty: 300 });
    expect(res.bucketCounts.expired).toEqual({ batches: 0, qty: 0 });
  });

  it("批次追溯 /inventory/batch-trace：同一批次不因两期出现两行", async () => {
    const t = await traceBatch(skuCode, "LOT-1", db);
    // 收口前：同一批次会出两行（旧期 600、新期 300），召回时「这批货现在在哪」直接翻倍
    expect(t.stockByWarehouse.map((s) => [s.warehouse, s.qty, s.stocktakeDate]))
      .toEqual([["盈余仓A", 300, NEW_PERIOD]]);
  });

  it("SKU 简报：最短剩余天数不被旧期已处置的过期批次拉成负数", async () => {
    const brief = await getSkuBrief(skuCode, db);
    // 旧期那批已过期货若参与，minDaysLeft 会是 -10
    expect(brief.minDaysLeft).toBeGreaterThan(0);
  });

  it("SKU 全景：效期批次只列新期，数量不翻倍", async () => {
    const p = await getSkuPanorama(skuId, db);
    expect(p.batches.map((b) => [b.batchNo, Number(b.qty)])).toEqual([["LOT-1", 300]]);
  });

  it("工作台 · 运营：90 天内临期批次数按期收口（1 条，不是 2 条）", async () => {
    const focus = await getWorkbenchFocus(["admin"], db);
    const ops = focus.sections.find((s) => s.role === "ops");
    const near = ops?.metrics.find((m) => m.key === "nearExpiryBatches");
    expect(near?.value).toBe(1);
  });

  it("工作台 · 例外：已过期库存只认新期——新期已处置则该例外整条消失", async () => {
    const items = await computeExceptions(db, { recordShown: false, applySnooze: false });
    expect(items.find((i) => i.key === "expired_stock")).toBeUndefined();
  });

  it("调拨建议（SKU 子集深链）：已过期量按新期为 0，不把整仓可调拨量清零", async () => {
    const res = await getTransferSuggestions({ skuIds: [skuId], pageSize: 50 }, db);
    const rows = res.rows.filter((r) => r.skuId === skuId);
    expect(rows.length).toBeGreaterThan(0);
    // 收口前：旧期 200 件过期货被算进 expiredHeld，A 仓可调拨量被清零 → 一条建议都不出
    expect(rows.every((r) => r.expiredHeld === 0)).toBe(true);
    expect(res.summary.expiredHeldTotal).toBe(0);
    expect(rows[0].fromWarehouse).toBe("盈余仓A");
    expect(rows[0].toWarehouse).toBe("缺口仓B");
  });

  it("调拨建议：子集深链必须用整表权威盘点期——只在旧期出现的 SKU 不得退回旧期", async () => {
    /* 该 SKU 在 A 仓**只有旧期行**（新期已把那 500 件过期货盘掉）。
       只用本批 rows 推断「A 仓最新期」会得到旧期 → 500 件过期货复活，
       min(expired, onHand) 把 A 仓 400 的可调拨量清成 0，一条建议都不出。
       传整表权威期（loadLatestStocktakeDates）后 A 仓最新期是 8-01，该 SKU 在其中没有行 → 过期 0。 */
    const res = await getTransferSuggestions({ skuIds: [goneSkuId], pageSize: 50 }, db);
    expect(res.summary.expiredHeldTotal).toBe(0);
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows[0]).toMatchObject({ skuId: goneSkuId, fromWarehouse: "盈余仓A", toWarehouse: "缺口仓B", expiredHeld: 0 });
  });
});
