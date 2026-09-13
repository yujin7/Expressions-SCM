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
 *
 * ── W2 修复钉住的三件事 ──
 *  6. **调拨侧必须取全**：`getTransferSuggestions` 的 pageSize 上限 500，此前本模块只读第一页，
 *     读出 `transfer.total` 又丢掉。生产 620 条建议时排在第 540 位的那条对本页不存在——
 *     该 SKU 显示 `transferQty = 0`、结论 `buy_only`，计划员在一张专门用来"先挪"的页面上
 *     去买了本来躺在另一个仓的货。取不全时必须在 `summary.transferTruncated` 上显式说出来。
 *  7. **金额剥离的测试必须真的有线路数据**：上一版一条 `stock_docs` 都没种，`lanes` 恒为空，
 *     两个角色都拿到 null，删掉 `stripLaneMoney` 照样绿。现在种真实线路 + 费用，
 *     价格角色看得见、非价格角色为 null，两者必须**不同**。
 *  8. `suggestQty === "0"` 且无调拨 ≠「先挪即可」：一条一件都挪不了的行不得冒充
 *     `coveredByTransfer`，它是 `none`（无需动作）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { auditLogs, channels, salesMonthly, skus, spus, stockBalances, stockDocLines, stockDocs, stockLedger, transferFees, users, warehouses } from "@/db/schema";
import { maskSensitive } from "@/server/core/dto";
import {
  actionOf,
  collectTransferSuggestions,
  COVER_CALIBRES,
  compareByOrderBy,
  getMoveOrBuyDecisions,
  pickLaneCost,
  residualAfterTransfer,
  type MoveOrBuyRow,
} from "@/server/modules/report/move-or-buy";
import type { TransferLaneRow } from "@/server/modules/report/transfer-routes";
import type { TransferSuggestRow } from "@/server/modules/report/transfer-suggest";
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

  it("结论四档：只能买 / 先挪再买 / 先挪即可 / 无需动作", () => {
    expect(actionOf("100", "100.0000", 0)).toBe("buy_only");
    expect(actionOf("100", "70.0000", 30)).toBe("transfer_then_buy");
    expect(actionOf("100", "0.0000", 400)).toBe("transfer_only");
    expect(actionOf(null, null, 30), "只有调拨建议、没有补货建议 = 先挪即可").toBe("transfer_only");
    // W2：不用买 + 一件都挪不了 = 无需动作。判成 transfer_only 会让 coveredByTransfer 虚高，
    // 汇总卡「先挪即可（无需采购）」把一条根本没货可挪的行数了进去。
    expect(actionOf("0", "0.0000", 0), "建议量 0 且无调拨 = 无需动作，不是「先挪即可」").toBe("none");
    expect(actionOf(null, null, 0), "既没补货建议也没调拨建议 = 无需动作").toBe("none");
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

describe("调拨侧取数：620 条建议不得只读第一页", () => {
  /** 假分页器：模拟服务端有 total 条建议、每页 pageSize 条 */
  const pager = (total: number, pageSize = 500) => {
    const calls: number[] = [];
    const fetchPage = async (page: number) => {
      calls.push(page);
      const start = (page - 1) * pageSize;
      const rows = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => ({
        skuId: start + i + 1,
      })) as unknown as TransferSuggestRow[];
      return { rows, total };
    };
    return { calls, fetchPage };
  };

  it("620 条：全部取回，不截断（只读第一页会停在 500）", async () => {
    const { calls, fetchPage } = pager(620);
    const r = await collectTransferSuggestions(fetchPage);
    expect(r.rows.length, "第 501–620 条不取回来，这些 SKU 在页面上会显示「无货可挪、只能买」").toBe(620);
    expect(r.total).toBe(620);
    expect(r.truncated).toBe(false);
    expect(calls).toEqual([1, 2]);
    // 第 540 条（生产事故里的那一条）确实在结果里
    expect(r.rows.map((x) => x.skuId)).toContain(540);
  });

  it("刚好一页（500 条）只发一次请求——修复不得把常见情形变慢", async () => {
    const { calls, fetchPage } = pager(500);
    const r = await collectTransferSuggestions(fetchPage);
    expect(r.rows.length).toBe(500);
    expect(calls).toEqual([1]);
  });

  it("超过分页上限：显式 truncated=true，绝不静默截断", async () => {
    const { fetchPage } = pager(30_000);
    const r = await collectTransferSuggestions(fetchPage, 3);
    expect(r.rows.length).toBe(1500);
    expect(r.total).toBe(30_000);
    expect(r.truncated, "取不全就必须说出来——页面据此弹红条").toBe(true);
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
    expect(client).toContain("recovery.submit");
    expect(client).toContain('source: "replenish"');
    expect(readFileSync(path.join(process.cwd(), "src/components/bh-create-request.ts"), "utf8")).toContain('"/api/replenish/draft"');
    expect(client).toContain("transferDraftPayload");
  });

  it("列表页平台三件套：useListState + ListToolbar + Suspense", () => {
    expect(client).toContain("useListState");
    expect(client).toContain("<ListToolbar");
    expect(page).toContain("<Suspense>");
  });

  it("调拨建议取不全时页面必须显式告警（静默截断会让结论反向出错）", () => {
    expect(client).toContain("transferTruncated");
    expect(client).toContain("调拨建议未取全");
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

    /* ── 线路费用样本（W2）──
       没有它，`lanes` 恒为空、两个角色都拿到 null，「金额按角色剥离」的用例就是空转：
       删掉 stripLaneMoney 也照样绿。这里种两张**已完成**的 A→B 调拨单并各登记一笔费用，
       线路 (A,B) 因此有中位单价，价格角色能看到、非价格角色必须看不到。 */
    const [actor] = await db.select().from(users);
    const completedAt = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86_400_000);
    for (const [i, fee] of [["MB-TL-1", "300.00"], ["MB-TL-2", "500.00"]] as const) {
      const [doc] = await db.insert(stockDocs).values({
        docNo: i, subtype: "transfer", status: "completed", transferType: "inter_warehouse",
        createdBy: actor.id, createdAt: completedAt, updatedAt: completedAt,
      }).returning();
      await db.insert(stockDocLines).values({
        stockDocId: doc.id, skuId, warehouseId: whA.id, toWarehouseId: whB.id, qty: "100.0000",
      });
      await db.insert(transferFees).values({
        stockDocId: doc.id, feeType: "freight", amount: fee, bizDate: today, createdBy: actor.id,
      });
    }
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

  it("金额按角色在服务端剥离：价格角色**看得见**、非价格角色为 null（两者必须不同）", async () => {
    const visible = await getMoveOrBuyDecisions({ roles: ["pmc"] }, db);
    const hidden = await getMoveOrBuyDecisions({ roles: ["warehouse"] }, db);
    expect(visible.summary.moneyVisible).toBe(true);
    expect(hidden.summary.moneyVisible).toBe(false);
    expect(visible.summary.laneCostAvailable, "线路读模型必须可用，否则本用例退化成空断言").toBe(true);

    const visibleFees = visible.rows.flatMap((r) => r.transfers.map((t) => t.laneMedianUnitFee));
    expect(
      visibleFees.filter((v) => v != null).length,
      "种了真实线路与费用，价格角色必须至少看到一条单位费用——否则删掉 stripLaneMoney 也不会变红",
    ).toBeGreaterThan(0);
    const visibleCosts = visible.rows.flatMap((r) => r.transfers.map((t) => t.laneEstCost));
    expect(visibleCosts.filter((v) => v != null).length).toBeGreaterThan(0);

    for (const r of hidden.rows) {
      for (const t of r.transfers) {
        expect(t.laneMedianUnitFee).toBeNull();
        expect(t.laneEstCost).toBeNull();
      }
    }
  });

  it("行内金额键在 SENSITIVE_FIELDS 里：maskSensitive 兜底能把它们删干净（路由出口的那层）", () => {
    const payload = {
      transfers: [{ laneMedianUnitFee: "5.0000", laneEstCost: "500.00", qty: 100 }],
    };
    const masked = maskSensitive(payload, ["warehouse"]) as { transfers: Record<string, unknown>[] };
    expect(Object.keys(masked.transfers[0]), "非价格角色出口必须**没有**这两个键")
      .toEqual(["qty"]);
    const kept = maskSensitive(payload, ["pmc"]) as { transfers: Record<string, unknown>[] };
    expect(kept.transfers[0].laneMedianUnitFee).toBe("5.0000");
  });

  it("调拨侧取全：服务端 total 与本页读入条数一致，未取全必须显式标注", async () => {
    const res = await getMoveOrBuyDecisions({ roles: ["pmc"] }, db);
    expect(res.summary.transferLineTotal, "本次种子的调拨建议条数").toBeGreaterThan(0);
    expect(
      res.summary.transferLinesLoaded,
      "读入条数必须等于服务端总条数——只读第一页会让后面的调拨建议在本页凭空消失",
    ).toBe(res.summary.transferLineTotal);
    expect(res.summary.transferTruncated).toBe(false);
    // 每一条服务端建议都必须能在装配结果里找到对应的 SKU 行
    const loadedQty = res.rows.reduce((a, r) => a + r.transfers.length, 0);
    expect(loadedQty).toBe(res.summary.transferLinesLoaded);
  });

  it("只读：跑一遍不产生任何单据、流水或审计", async () => {
    const ledgerBefore = (await db.select().from(stockLedger)).length;
    const auditsBefore = (await db.select().from(auditLogs)).length;
    // 种子里已有 2 张已完成调拨单（线路费用样本），所以比的是**增量为 0**，不是绝对 0
    const docsBefore = (await db.select().from(stockDocs)).length;
    await getMoveOrBuyDecisions({ roles: ["pmc"] }, db);
    expect((await db.select().from(stockLedger)).length).toBe(ledgerBefore);
    expect((await db.select().from(auditLogs)).length).toBe(auditsBefore);
    expect((await db.select().from(stockDocs)).length).toBe(docsBefore);
  });
});
