/**
 * W2「先挪后买」统一决策表（report/move-or-buy）。
 *
 * 这页存在的唯一理由是：计划员每个 SKU 只有一个问题——**在必须下单之前能不能先挪**。
 * 因此本文件钉住的不是"字段都在"，而是那几条**会被静默破坏**的纪律：
 *  1. 两套可销天数**不可比**，服务端必须原样并排下发口径说明，绝不合并或换算；
 *  2. 合并只发生在**件数**上：挪完仍需买 = 建议补货量 − 可挪合计（不为负）；
 *  3. 排序 = 最晚下单日升序、空值置底（这页回答"今天必须动哪几个"）；
 *  4. 金额（线路费用）按角色剥离——**服务端**剥，前端隐藏不算；
 *  5. 只读：跑一遍不产生任何单据、流水或审计。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { auditLogs, channels, salesMonthly, skus, spus, stockBalances, stockDocs, stockLedger, users, warehouses } from "@/db/schema";
import {
  actionOf,
  COVER_CALIBRES,
  compareByOrderBy,
  getMoveOrBuyDecisions,
  pickLaneCost,
  residualAfterTransfer,
  type MoveOrBuyRow,
} from "@/server/modules/report/move-or-buy";
import type { TransferLaneRow } from "@/server/modules/report/transfer-routes";
import { todayShanghai } from "@/server/modules/master/common";
import { createTestDb, type TestDb } from "../helpers/db";

const row = (p: Partial<MoveOrBuyRow> & { code: string }): MoveOrBuyRow => ({
  skuId: 1, name: "", brand: null, baseUom: "支", onHand: 0, daily: 0, daysCover: null, leadDays: null,
  orderByDate: null, daysToShortage: null, orderWindowMissed: false, suggestQty: null,
  transfers: [], transferQty: 0, residualBuyQty: null, action: "buy_only",
  suppression: null, withheldBuyQty: null,
  inFlightDrafts: { buyQty: 0, buyDocs: 0, transferQty: 0, transferDocs: 0 }, inFlightWarning: null, ...p,
});

const lane = (p: Partial<TransferLaneRow> & { fromWarehouseId: number; toWarehouseId: number }): TransferLaneRow => ({
  laneKey: "k", fromWarehouse: "A", toWarehouse: "B", transferType: "inter_warehouse",
  transferTypeLabel: "仓间调拨", docCount: 1, docCount30: 1, totalQty: "10", amount: null,
  avgUnitFee: null, medianUnitFee: null, samples: 0, medianQty: null, scattered: false,
  status: "ok", latestDocNo: null, latestDate: null, latestDeviationPct: null, latestZ: null,
  statusReason: "", recentDocs: [], ...p,
});

describe("纯函数：残量、结论与排序", () => {
  it("挪完仍需买 = 建议 − 可挪，且不为负（挪得比要买的还多不代表可以退货）", () => {
    expect(residualAfterTransfer("100", 30)).toBe("70.0000");
    expect(residualAfterTransfer("100", 400)).toBe("0.0000");
    expect(residualAfterTransfer(null, 30), "没有补货建议就没有残量，不能当成 0").toBeNull();
  });

  it("结论三档：只能买 / 先挪再买 / 先挪即可", () => {
    expect(actionOf("100", "100.0000", 0)).toBe("buy_only");
    expect(actionOf("100", "70.0000", 30)).toBe("transfer_then_buy");
    expect(actionOf("100", "0.0000", 400)).toBe("transfer_only");
    expect(actionOf(null, null, 30), "只有调拨建议、没有补货建议 = 先挪即可").toBe("transfer_only");
  });

  it("排序按最晚下单日升序，空值一律置底（不让「算不出」霸占决策视野）", () => {
    const rows = [
      row({ code: "C", orderByDate: null }),
      row({ code: "B", orderByDate: "2026-09-10" }),
      row({ code: "A", orderByDate: "2026-09-02" }),
      row({ code: "D", orderByDate: null }),
    ];
    expect([...rows].sort(compareByOrderBy).map((r) => r.code)).toEqual(["A", "B", "C", "D"]);
  });

  it("线路费用取样本最多且有中位单价的那条；没有带单价的样本就是 null（未登记 ≠ 免费）", () => {
    const lanes = [
      lane({ fromWarehouseId: 1, toWarehouseId: 2, medianUnitFee: "2.0000", samples: 3 }),
      lane({ fromWarehouseId: 1, toWarehouseId: 2, medianUnitFee: "5.0000", samples: 9 }),
      lane({ fromWarehouseId: 1, toWarehouseId: 3, medianUnitFee: null, samples: 4 }),
    ];
    expect(pickLaneCost(lanes, 1, 2)).toEqual({ medianUnitFee: "5.0000", samples: 9 });
    expect(pickLaneCost(lanes, 1, 3)).toEqual({ medianUnitFee: null, samples: 4 });
    expect(pickLaneCost(lanes, 9, 9)).toEqual({ medianUnitFee: null, samples: 0 });
  });

  it("两套可销天数的口径文案各自成立，且明说不可比", () => {
    expect(COVER_CALIBRES.replenish.basis).toContain("全网在库");
    expect(COVER_CALIBRES.transfer.basis).toContain("该仓在库");
    expect(COVER_CALIBRES.incomparable).toContain("不可相减");
  });
});

describe("页面：两套口径必须在界面上各自带名字", () => {
  const client = readFileSync(
    path.join(process.cwd(), "src/app/(app)/replenish/move-or-buy/move-or-buy-client.tsx"),
    "utf8",
  );
  const page = readFileSync(
    path.join(process.cwd(), "src/app/(app)/replenish/move-or-buy/page.tsx"),
    "utf8",
  );

  it("列名写死到具体口径，不出现一个孤零零的「可销天数」列", () => {
    expect(client).toContain("全网可销天数");
    expect(client).toContain("调入仓可销");
    expect(client).toContain("calibres.incomparable");
  });

  it("动作复用既有草稿端点，不新增写入面", () => {
    expect(client).toContain('"/api/inventory/stock-doc"');
    expect(client).toContain('"/api/replenish/draft"');
    expect(client).toContain("transferDraftPayload");
  });

  it("列表页平台三件套：useListState + ListToolbar + Suspense", () => {
    expect(client).toContain("useListState");
    expect(client).toContain("<ListToolbar");
    expect(page).toContain("<Suspense>");
  });
});

describe("装配（PGlite）：A 仓积压、B 仓断货的同一个 SKU", () => {
  let db: TestDb;
  let skuId = 0;
  const today = todayShanghai();

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(users).values({ name: "计划员", roles: ["pmc"], isApprover: false });
    const [spu] = await db.insert(spus).values({ code: "P70001", nameCn: "先挪后买测试品" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "CP70001", name: "先挪后买成品", spuId: spu.id, skuType: "finished", baseUom: "支", active: true,
    }).returning();
    skuId = sku.id;

    const [whA] = await db.insert(warehouses).values({
      code: "MB-A", name: "积压仓A", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();
    const [whB] = await db.insert(warehouses).values({
      code: "MB-B", name: "断货仓B", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();

    await db.insert(stockBalances).values([{ skuId, warehouseId: whA.id, batchId: null, qty: "1000.0000" }]);
    const recent = new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 86_400_000);
    await db.insert(stockLedger).values([{
      skuId, warehouseId: whB.id, batchId: null, qtyDelta: "-900.0000",
      sourceDocType: "sales_out", sourceDocId: 1, action: "post", occurredAt: recent,
    }]);
    const [ch] = await db.insert(channels).values({ code: "MB-CH", name: "渠道", kind: "platform" }).returning();
    await db.insert(salesMonthly).values([{ skuId, channelId: ch.id, yearMonth: "2026-08", qty: "900" }]);
  });

  it("同一个 SKU 一行：调拨侧与补货侧并排，件数上给出残量", async () => {
    const res = await getMoveOrBuyDecisions({ roles: ["pmc"] }, db);
    const line = res.rows.find((r) => r.skuId === skuId);
    expect(line, "A 仓有富余、B 仓在发货，这个 SKU 必须出现在决策表上").toBeDefined();
    expect(line!.transfers.length).toBeGreaterThan(0);
    expect(line!.transferQty).toBe(line!.transfers.reduce((s, t) => s + t.qty, 0));
    // 件数是唯一被合并计算的量
    expect(line!.residualBuyQty).toBe(residualAfterTransfer(line!.suggestQty, line!.transferQty));
    expect(res.summary.skuCount).toBe(res.total);
    expect(res.summary.calibres.incomparable).toBe(COVER_CALIBRES.incomparable);
  });

  it("金额按角色在服务端剥离：无金额权限时线路费用整列为 null", async () => {
    const visible = await getMoveOrBuyDecisions({ roles: ["pmc"] }, db);
    const hidden = await getMoveOrBuyDecisions({ roles: ["warehouse"] }, db);
    expect(visible.summary.moneyVisible).toBe(true);
    expect(hidden.summary.moneyVisible).toBe(false);
    for (const r of hidden.rows) {
      for (const t of r.transfers) {
        expect(t.laneMedianUnitFee).toBeNull();
        expect(t.laneEstCost).toBeNull();
      }
    }
  });

  it("只读：跑一遍不产生任何单据、流水或审计", async () => {
    const ledgerBefore = (await db.select().from(stockLedger)).length;
    const auditsBefore = (await db.select().from(auditLogs)).length;
    await getMoveOrBuyDecisions({ roles: ["pmc"] }, db);
    expect((await db.select().from(stockLedger)).length).toBe(ledgerBefore);
    expect((await db.select().from(auditLogs)).length).toBe(auditsBefore);
    expect((await db.select().from(stockDocs)).length).toBe(0);
  });
});
