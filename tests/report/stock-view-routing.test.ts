/**
 * 「在库/最新快照」只有一处实现——`core/stock-view` 的 `getOnHandBySku` / `getLatestSnapshotRows`
 * （CLAUDE.md 共享层唯一权威）。本文件钉住三个此前各自复制了一份子查询的读者：
 *
 * 1. `report/inventory-analytics`：本地复制「Σ余额 + 最新快照子查询」并用 **float 累加**，
 *    且不出 `snapDate` —— 页面标不出「快照那部分是哪天的数」。
 * 2. `inventory/queries.listSnapshotBalances`：同一份子查询的第二次逐字复制，
 *    且从不 select `commercialRole` —— 余额页快照 Tab 的「业务用途」列有渲染、永远空白
 *    （0727 会议要「小样单独查库存」，就卡在这一列上）。
 * 3. `master/sku-panorama`：同一份子查询的第三次复制。
 *
 * 判别性：快照仓存**两期**（旧期 999、新期 40.2）。只认最新一期的实现给 140.3；
 * 把两期都算进来的实现给 1139.3。权威口径同时返回 decimal 字符串（`"140.300000"`），
 * 精度契约由 `core/decimal` 保证，不再靠各页面自己 `+`。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { skus, spus, stockBalances, stockSnapshots, warehouses } from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { getOnHandBySku } from "@/server/core/stock-view";
import { getInventoryAnalytics } from "@/server/modules/report/inventory-analytics";
import { listSnapshotBalances } from "@/server/modules/inventory/queries";
import { getSkuPanorama } from "@/server/modules/master/sku-panorama";

const OLD_SNAP = "2026-08-01";
const NEW_SNAP = "2026-08-31";

describe("在库/最新快照口径收口于 core/stock-view", () => {
  let db: TestDb;
  let skuId = 0;
  let sampleSkuId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "P80001", nameCn: "快照口径测试品" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "CP80001", name: "快照口径成品", spuId: spu.id, skuType: "finished",
      baseUom: "支", active: true, commercialRole: "retail",
    }).returning();
    skuId = sku.id;
    const [sample] = await db.insert(skus).values({
      code: "CP80002", name: "小样", spuId: spu.id, skuType: "finished",
      baseUom: "支", active: true, commercialRole: "sample",
    }).returning();
    sampleSkuId = sample.id;

    const [whReal] = await db.insert(warehouses).values({
      code: "WH-RT", name: "实时仓", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();
    const [whSnap] = await db.insert(warehouses).values({
      code: "WH-SNAP", name: "云仓", kind: "snapshot", accountingMode: "snapshot", active: true,
    }).returning();

    /* 实时账 100.1 + 快照 40.2：float 累加得 140.29999999999998，decimal 得 140.3 */
    await db.insert(stockBalances).values([
      { skuId, warehouseId: whReal.id, batchId: null, qty: "100.1000" },
      { skuId: sampleSkuId, warehouseId: whReal.id, batchId: null, qty: "5.0000" },
    ]);

    /* 快照仓两期：旧期 999（必须整期忽略），新期 40.2 */
    await db.insert(stockSnapshots).values([
      { skuId, warehouseId: whSnap.id, bizDate: OLD_SNAP, qty: "999.0000" },
      { skuId, warehouseId: whSnap.id, bizDate: NEW_SNAP, qty: "40.2000" },
      { skuId: sampleSkuId, warehouseId: whSnap.id, bizDate: NEW_SNAP, qty: "7.0000" },
    ]);
  });

  it("权威口径：只认最新一期快照，decimal 累加不留 float 尾巴", async () => {
    const v = await getOnHandBySku(db, { skuIds: [skuId] });
    expect(v.bySku.get(skuId)).toBe("140.300000");
    expect(v.snapDate).toBe(NEW_SNAP);
  });

  it("库存分析：走权威口径（140.3，不是 1139.3），并下发 snapDate 供页面标注数据时点", async () => {
    const res = await getInventoryAnalytics({ page: 1, pageSize: 50 }, db);
    // 此前本地复制的实现在这里给 1139.3（两期相加）且 snapDate 字段根本不存在
    expect(res.snapDate).toBe(NEW_SNAP);
    const row = res.rows.find((r) => r.skuId === skuId);
    expect(row?.onHand).toBe(140.3);
  });

  it("余额页快照 Tab：只出最新一期，且每行带业务用途（0727 小样单独查库存）", async () => {
    const res = await listSnapshotBalances({ page: 1, pageSize: 50 }, db);
    const rows = res.rows as { skuId: number; skuCode: string; commercialRole: string; qty: string; bizDate: string }[];
    expect(res.total).toBe(2); // 两个 SKU 各一行最新快照；旧期不出行
    const main = rows.find((r) => r.skuId === skuId)!;
    expect(main).toMatchObject({ skuCode: "CP80001", commercialRole: "retail", bizDate: NEW_SNAP });
    expect(Number(main.qty)).toBe(40.2);
    // 此前 commercialRole 服务端从不 select → 该列永远 undefined/空白
    expect(rows.find((r) => r.skuId === sampleSkuId)?.commercialRole).toBe("sample");
  });

  it("余额页快照 Tab：搜索走同一份最新快照行（不退回全表）", async () => {
    const res = await listSnapshotBalances({ q: "CP80002", page: 1, pageSize: 50 }, db);
    expect(res.total).toBe(1);
    expect((res.rows as { skuCode: string }[])[0].skuCode).toBe("CP80002");
  });

  it("SKU 全景：快照分布只列最新一期（40.2，不是 999+40.2）", async () => {
    const p = await getSkuPanorama(skuId, db);
    expect(p.snapshots.map((s) => [s.warehouseName, Number(s.qty), s.bizDate]))
      .toEqual([["云仓", 40.2, NEW_SNAP]]);
  });
});
