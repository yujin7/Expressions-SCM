/**
 * 预警行动作深链必须落到「已筛选」的页面（审计 #2）：
 * - actions.transfer = /report/transfer-suggest?skuIds=<id>，调拨建议客户端读 skuIds 并转给 API，API 只算这些 SKU；
 * - actions.replenish = /replenish?q=<code>，补货页 q 是已支持的筛选参数；
 * - 库存预警表 / 爆单读模型的服务端筛选（inventory-alerts-query / sales-spike-query）纯函数。
 *
 * ── 夹具纪律（审计 C11）──
 * 本文件的夹具**不得**用 `as unknown as` 绕过类型：那样写等于把「生产者改了形状」这件事
 * 从编译期抹掉——曾经 `row()` 少了 v2 的八个字段（statusOnHand / downgradedBySupply /
 * inTransit* / nextArrival / priorityTerms / nearExpiry / overstock …），生产者改名也照样绿。
 * 现在夹具按导出的 `InventoryAlertRow` / `InventoryAlertsReadModel` / `SpikeHit` /
 * `SalesSpikeReadModel` 逐字段构造，键也一律取自导出的键常量而不是字符串字面量：
 * 生产者一改形状，这个文件先红。
 */
import { describe, expect, it } from "vitest";
import { parseQuery } from "@/components/useListState";
import { filterInventoryAlertRows, pageInventoryAlerts } from "@/server/modules/report/inventory-alerts-query";
import { filterSpikeHits, pageSalesSpike } from "@/server/modules/report/sales-spike-query";
import {
  INVENTORY_ALERTS_CACHE_KEY,
  type InventoryAlertRow,
  type InventoryAlertsReadModel,
} from "@/server/modules/report/inventory-alerts";
import {
  SALES_SPIKE_CACHE_KEY,
  type SalesSpikeReadModel,
  type SpikeHit,
} from "@/server/modules/report/sales-spike";
import { skuParams, skus, spus, stockBalances, stockLedger, users, warehouses } from "@/db/schema";
import { getTransferSuggestions } from "@/server/modules/report/transfer-suggest";
import { createTestDb } from "../helpers/db";

/**
 * 完整的 InventoryAlertRow 夹具——**每个字段都显式给值**，不使用类型断言。
 * 生产者新增/改名字段时，这里会因缺字段而编译失败，那正是本夹具的作用。
 */
function row(p: Partial<InventoryAlertRow> & { skuId: number; code: string }): InventoryAlertRow {
  const base: InventoryAlertRow = {
    skuId: p.skuId,
    code: p.code,
    name: p.code,
    brand: null,
    tier: "A",
    tierSource: "policy",
    onHand: "10",
    daily: { external: 1, internal: null, ledger: null },
    net7External: null,
    net30External: "30.0000",
    primaryDaily: 1,
    primaryDailySource: "external",
    coverDays: 10,
    coverDaysWithSupply: 10,
    inTransitDated: 0,
    inTransitUndated: 0,
    inTransitOverdue: 0,
    nextArrival: null,
    alertDays: 35,
    alertBasis: "加工 20 + 在途 10 + 缓冲 5",
    usedDefault: false,
    learnedLead: null,
    statusOnHand: "alert",
    status: "alert",
    downgradedBySupply: false,
    statusBasis: null,
    primary: "low_stock",
    tags: [],
    priorityScore: "1",
    priorityTerms: { dailyAvg: "1.0000", alertDays: 35, coverDays: "10.0000", gapDays: "25.0000" },
    priorityFormula: "日均销 × 缺口天数",
    spike: false,
    spikeExpected: false,
    nearExpiry: null,
    overstock: false,
    actions: {
      transfer: `/report/transfer-suggest?skuIds=${p.skuId}`,
      replenish: `/replenish?q=${encodeURIComponent(p.code)}`,
      nearExpiry: `/inventory/expiry?q=${encodeURIComponent(p.code)}&bucket=all`,
      overstock: `/report/risk?q=${encodeURIComponent(p.code)}`,
    },
  };
  return { ...base, ...p };
}

/** 完整的读模型夹具（键取自导出的常量，升版时本文件跟着走） */
function alertsModel(rows: InventoryAlertRow[]): InventoryAlertsReadModel {
  return {
    key: INVENTORY_ALERTS_CACHE_KEY,
    builtAt: "2026-09-04T00:00:00.000Z",
    sourceBinding: "b",
    params: {
      productionDefault: 30,
      logisticsDefault: 15,
      bufferDays: 5,
      targetDays: null,
      tierCuts: { sPct: 50, aPct: 80, bPct: 95 },
      slowDaysThreshold: 180,
      learnedToleranceDays: 3,
      today: "2026-09-04",
    },
    totals: {
      skus: rows.length,
      alert: rows.filter((r) => r.status === "alert").length,
      watch: rows.filter((r) => r.status === "watch").length,
      ok: rows.filter((r) => r.status === "ok").length,
      outOfStock: rows.filter((r) => r.primary === "out_of_stock").length,
      downgradedBySupply: rows.filter((r) => r.downgradedBySupply).length,
      nearExpiry: rows.filter((r) => r.nearExpiry != null).length,
      overstock: rows.filter((r) => r.overstock).length,
      learnedObserved: rows.filter((r) => r.learnedLead != null).length,
      byTier: {},
    },
    rows,
    limitations: [],
  };
}

/** 完整的 SpikeHit 夹具 */
function hit(p: Partial<SpikeHit> = {}): SpikeHit {
  const base: SpikeHit = {
    kind: "sku",
    skuId: 1,
    code: "N1",
    name: "爆款",
    shopName: "旗舰店",
    platformSkuId: null,
    anchorDate: "2026-09-03",
    days: [],
    baseline: "10",
    threshold: "15",
    risePct: "100",
    href: "/replenish?q=N1",
    reason: "连续 3 天 ≥ 基线×1.5",
    gaps: 0,
    expected: false,
    planEventRef: null,
    expectedUpliftPct: null,
    planEventWindow: null,
  };
  return { ...base, ...p };
}

function spikeModel(hits: SpikeHit[], unmappedHits: SpikeHit[]): SalesSpikeReadModel {
  return {
    key: SALES_SPIKE_CACHE_KEY,
    builtAt: "2026-09-04T00:00:00.000Z",
    sourceBinding: "b",
    state: "ready",
    evaluations: [],
    anchorDate: "2026-09-03",
    sourceAsOf: null,
    params: { consecutiveDays: 3, risePct: 50, minBaseQty: 10, baselineDays: 7 },
    coverage: {
      platformSeries: 2, mappedSeries: 1, systemSkus: 1,
      calendarSkus: 0, calendarPct: null, expectedHits: 0, evaluatedItems: 2, incompleteItems: 0,
    },
    hits,
    unmappedHits,
    limitations: [],
  };
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

  /**
   * 每个**主预警种类**都要有落地页。此前 actions 只有 transfer/replenish：
   * near_expiry 与 overstock 两类主预警在行上亮着标签，却没有任何可点的下一步——
   * 用户只能自己去猜该开哪个页面、再手工搜一遍编码。
   */
  it("临期/积压主预警各有落地页深链，且深链参数是目标页真正消费的筛选", () => {
    const r = row({ skuId: 9, code: "N002-000" });
    // 效期页默认只看「已到期」段位，临期批次落在 3/6 月段——必须显式 bucket=all 才看得到该 SKU 全部批次
    expect(r.actions.nearExpiry).toBe("/inventory/expiry?q=N002-000&bucket=all");
    const exp = parseQuery(r.actions.nearExpiry.slice(r.actions.nearExpiry.indexOf("?")), { q: "", bucket: "expired", brand: "" });
    expect(exp.filters).toMatchObject({ q: "N002-000", bucket: "all" });

    expect(r.actions.overstock).toBe("/report/risk?q=N002-000");
    const risk = parseQuery(r.actions.overstock.slice(r.actions.overstock.indexOf("?")), { q: "", action: "" });
    expect(risk.filters.q).toBe("N002-000");
  });
});

describe("inventory-alerts-query：服务端筛选与分页", () => {
  const rows: InventoryAlertRow[] = [
    row({ skuId: 1, code: "S-OUT", tier: "S", primary: "out_of_stock", status: "alert", statusOnHand: "alert", onHand: "0" }),
    row({ skuId: 2, code: "A-LOW", tier: "A", primary: "low_stock", status: "alert", statusOnHand: "alert" }),
    row({ skuId: 3, code: "B-OK", tier: "B", primary: null, status: "ok", statusOnHand: "ok", brand: "NING" }),
    row({ skuId: 4, code: "C-LOW", tier: "C", primary: "low_stock", status: "alert", statusOnHand: "alert" }),
    row({ skuId: 5, code: "X-NONE", tier: null, tierSource: null, primary: null, status: "watch", statusOnHand: "alert", downgradedBySupply: true }),
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
    const model = alertsModel(rows);
    const page = pageInventoryAlerts(model, { onlyAlert: "0", showC: "1", page: 2, pageSize: 2 });
    expect(page.filtered).toEqual({ total: 5, page: 2, pageSize: 2 });
    expect(page.rows.map((r) => r.code)).toEqual(["B-OK", "C-LOW"]);
    expect(page.totals.skus).toBe(5);
  });
  it("夹具与生产者同键：读模型 key 取自导出的常量，升版后本文件自动跟随", () => {
    expect(alertsModel([]).key).toBe(INVENTORY_ALERTS_CACHE_KEY);
    expect(spikeModel([], []).key).toBe(SALES_SPIKE_CACHE_KEY);
  });
});

describe("sales-spike-query：q 筛选不改总数", () => {
  it("hitCount / unmappedCount 是筛选前全量；q 匹配编码/名称/平台 SKU/店铺", () => {
    const model = spikeModel(
      [hit(), hit({ skuId: 2, code: "N2", name: "次爆" })],
      [hit({ kind: "platform", skuId: null, code: null, name: null, platformSkuId: "P-X", shopName: "海外店" })],
    );
    const page = pageSalesSpike(model, "n2");
    expect(page.hitCount).toBe(2);
    expect(page.unmappedCount).toBe(1);
    expect(page.hits.map((h) => h.code)).toEqual(["N2"]);
    expect(page.unmappedHits).toEqual([]);
    expect(filterSpikeHits(model.unmappedHits, "海外").map((h) => h.platformSkuId)).toEqual(["P-X"]);
    expect(filterSpikeHits(model.hits, "")).toHaveLength(2);
  });
});
