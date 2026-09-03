/**
 * 预警行动作深链必须落到「已筛选」的页面（审计 #2）：
 * - actions.transfer = /report/transfer-suggest?skuIds=<id>，调拨建议客户端读 skuIds 并转给 API，API 只算这些 SKU；
 * - actions.replenish = /replenish?q=<code>，补货页 q 是已支持的筛选参数；
 * - 库存预警表 / 爆单读模型的服务端筛选（inventory-alerts-query / sales-spike-query）纯函数。
 */
import { describe, expect, it } from "vitest";
import { parseQuery } from "@/components/useListState";
import { filterInventoryAlertRows, pageInventoryAlerts } from "@/server/modules/report/inventory-alerts-query";
import { filterSpikeHits, pageSalesSpike } from "@/server/modules/report/sales-spike-query";
import type { InventoryAlertRow, InventoryAlertsReadModel } from "@/server/modules/report/inventory-alerts";
import type { SalesSpikeReadModel, SpikeHit } from "@/server/modules/report/sales-spike";
import { skuParams, skus, spus, stockBalances, stockLedger, users, warehouses } from "@/db/schema";
import { getTransferSuggestions } from "@/server/modules/report/transfer-suggest";
import { createTestDb } from "../helpers/db";

function row(p: Partial<InventoryAlertRow> & { skuId: number; code: string }): InventoryAlertRow {
  return {
    name: p.code, brand: null, tier: "A", tierSource: "policy", onHand: "10",
    daily: { external: 1, internal: null, ledger: null }, net7External: null, net30External: 30,
    primaryDaily: 1, primaryDailySource: "external", coverDays: 10, alertDays: 35, alertBasis: "加工 20 + 在途 10 + 缓冲 5", usedDefault: false,
    status: "alert", primary: "low_stock", tags: [], priorityScore: "1", spike: false,
    actions: { transfer: `/report/transfer-suggest?skuIds=${p.skuId}`, replenish: `/replenish?q=${encodeURIComponent(p.code)}` },
    ...p,
  } as InventoryAlertRow;
}

describe("预警行深链落到已筛选页面", () => {
  it("调拨建议客户端从 URL 读 skuIds 并转给 API；API 只算这些 SKU", async () => {
    const { db, client } = await createTestDb();
    try {
      await db.insert(users).values({ name: "深链测试", roles: ["pmc"] });
      const [a] = await db.insert(warehouses).values({ code: "DL-A", name: "盈余仓", kind: "finished" }).returning();
      const [b] = await db.insert(warehouses).values({ code: "DL-B", name: "缺口仓", kind: "finished" }).returning();
      const [spu] = await db.insert(spus).values({ code: "PDL01", nameCn: "深链品" }).returning();
      const [s1] = await db.insert(skus).values({ code: "DL001", name: "甲", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
      const [s2] = await db.insert(skus).values({ code: "DL002", name: "乙", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
      let seq = 0;
      for (const skuId of [s1.id, s2.id]) {
        await db.insert(skuParams).values({ skuId, normalLeadDays: 10, logisticsLeadDays: 5 });
        await db.insert(stockBalances).values({ skuId, warehouseId: a.id, batchId: null, qty: "10000" });
        await db.insert(stockBalances).values({ skuId, warehouseId: b.id, batchId: null, qty: "10" });
        for (const warehouseId of [a.id, b.id]) {
          seq += 1;
          await db.insert(stockLedger).values({ skuId, warehouseId, batchId: null, qtyDelta: "-90", sourceDocType: "test_out", sourceDocId: seq, action: "post", occurredAt: new Date(Date.now() - 3 * 86_400_000) });
        }
      }
      // 客户端：useListState 从预警行 href 的查询串解析出 skuIds（此前 defaults 没有 skuIds，参数被丢弃）
      const href = row({ skuId: s1.id, code: "DL001" }).actions.transfer;
      const parsed = parseQuery(href.slice(href.indexOf("?")), { q: "", skuIds: "" });
      expect(parsed.filters.skuIds).toBe(String(s1.id));
      // API：只算这些 SKU
      const all = await getTransferSuggestions({ horizonDays: 90 }, db);
      expect(all.total).toBe(2);
      const only = await getTransferSuggestions({ horizonDays: 90, skuIds: parsed.filters.skuIds.split(",").map(Number) }, db);
      expect(only.total).toBe(1);
      expect(only.rows[0].skuId).toBe(s1.id);
    } finally {
      await client.close();
    }
  });

  it("补货深链用 q（补货页已支持的筛选参数），不再是无人消费的 sku", () => {
    const r = row({ skuId: 7, code: "N001-000" });
    expect(r.actions.replenish).toBe("/replenish?q=N001-000");
    const parsed = parseQuery(r.actions.replenish.slice(r.actions.replenish.indexOf("?")), { q: "", coverDays: "45" });
    expect(parsed.filters.q).toBe("N001-000");
  });
});

describe("inventory-alerts-query：服务端筛选与分页", () => {
  const rows: InventoryAlertRow[] = [
    row({ skuId: 1, code: "S-OUT", tier: "S", primary: "out_of_stock", status: "alert" }),
    row({ skuId: 2, code: "A-LOW", tier: "A", primary: "low_stock", status: "alert" }),
    row({ skuId: 3, code: "B-OK", tier: "B", primary: null, status: "ok", brand: "NING" }),
    row({ skuId: 4, code: "C-LOW", tier: "C", primary: "low_stock", status: "alert" }),
    row({ skuId: 5, code: "X-NONE", tier: null, tierSource: null, primary: null, status: "watch" }),
  ];
  it("缺省只看预警且折叠 C 级；onlyAlert=0 / showC=1 放开；tier=none 取未分层；q 匹配编码/名称/品牌", () => {
    expect(filterInventoryAlertRows(rows, {}).map((r) => r.code)).toEqual(["S-OUT", "A-LOW", "X-NONE"]);
    expect(filterInventoryAlertRows(rows, { showC: "1" }).map((r) => r.code)).toEqual(["S-OUT", "A-LOW", "C-LOW", "X-NONE"]);
    expect(filterInventoryAlertRows(rows, { onlyAlert: "0", showC: "1" })).toHaveLength(5);
    expect(filterInventoryAlertRows(rows, { primary: "out_of_stock" }).map((r) => r.code)).toEqual(["S-OUT"]);
    expect(filterInventoryAlertRows(rows, { tier: "none", onlyAlert: "0" }).map((r) => r.code)).toEqual(["X-NONE"]);
    expect(filterInventoryAlertRows(rows, { q: "ning", onlyAlert: "0" }).map((r) => r.code)).toEqual(["B-OK"]);
  });
  it("分页只切 rows，totals 保持读模型全量，filtered.total 是筛选命中数", () => {
    const model = { key: "inventory-alerts/v1", builtAt: "t", sourceBinding: "b", params: { productionDefault: 30, logisticsDefault: 15, bufferDays: 5, targetDays: null, tierCuts: { sPct: 50, aPct: 80, bPct: 95 } }, totals: { skus: 5, alert: 3, watch: 1, ok: 1, outOfStock: 1, byTier: {} }, rows, limitations: [] } as InventoryAlertsReadModel;
    const page = pageInventoryAlerts(model, { onlyAlert: "0", showC: "1", page: 2, pageSize: 2 });
    expect(page.filtered).toEqual({ total: 5, page: 2, pageSize: 2 });
    expect(page.rows.map((r) => r.code)).toEqual(["B-OK", "C-LOW"]);
    expect(page.totals.skus).toBe(5);
  });
});

describe("sales-spike-query：q 筛选不改总数", () => {
  const hit = (p: Partial<SpikeHit>): SpikeHit => ({ kind: "sku", skuId: 1, code: "N1", name: "爆款", shopName: "旗舰店", platformSkuId: null, anchorDate: "2026-09-03", days: [], baseline: "10", threshold: "15", risePct: "100", href: "/replenish?q=N1", ...p });
  it("hitCount / unmappedCount 是筛选前全量；q 匹配编码/名称/平台 SKU/店铺", () => {
    const model = { key: "sales-spike/v1", builtAt: "t", sourceBinding: "b", state: "ready", anchorDate: "2026-09-03", sourceAsOf: null, params: { consecutiveDays: 3, risePct: 50, minBaseQty: 10, baselineDays: 7 }, coverage: { platformSeries: 2, mappedSeries: 1, systemSkus: 1 }, hits: [hit({}), hit({ skuId: 2, code: "N2", name: "次爆" })], unmappedHits: [hit({ kind: "platform", skuId: null, code: null, name: null, platformSkuId: "P-X", shopName: "海外店" })], limitations: [] } as SalesSpikeReadModel;
    const page = pageSalesSpike(model, "n2");
    expect(page.hitCount).toBe(2);
    expect(page.unmappedCount).toBe(1);
    expect(page.hits.map((h) => h.code)).toEqual(["N2"]);
    expect(page.unmappedHits).toEqual([]);
    expect(filterSpikeHits(model.unmappedHits, "海外").map((h) => h.platformSkuId)).toEqual(["P-X"]);
    expect(filterSpikeHits(model.hits, "")).toHaveLength(2);
  });
});
