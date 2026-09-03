/**
 * D60 调拨线路读模型（report/transfer-routes.ts /v1）：线路键 (from,to,type)、数量加权均价、中位数、样本数、
 * 留一法偏差判定、数量异常、零散；缓存按 source_binding 命中/失效；金额按角色置空。
 */
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { skus, spus, stockDocLines, stockDocs, transferFees, users, warehouses } from "@/db/schema";
import {
  computeTransferRoutes, filterTransferRoutes, laneKeyOf, loadTransferDocFacts, loadTransferRoutes, refreshTransferRoutes,
  stripLaneMoney, TRANSFER_ROUTES_CACHE_KEY,
} from "@/server/modules/report/transfer-routes";
import { createTestDb, type TestDb } from "../helpers/db";

const AS_OF = "2026-09-03";
const PARAMS = { windowDays: 180, deviationPct: 20, qtyDeviationX: 3, batchMaxDocs: 4 };

describe("transfer-routes 读模型", () => {
  let db: TestDb;
  let userId: number;
  let whA: number;
  let whB: number;
  let whC: number;
  let skuId: number;
  let seq = 0;

  async function mkDoc(opts: { from: number; to: number; type: string | null; qty: string; date: string; fee?: string; status?: string }): Promise<number> {
    seq += 1;
    const ts = new Date(`${opts.date}T10:00:00+08:00`);
    const [doc] = await db
      .insert(stockDocs)
      .values({
        docNo: `DB-TR${String(seq).padStart(4, "0")}`,
        subtype: "transfer",
        status: (opts.status ?? "completed") as "completed",
        transferType: opts.type,
        createdBy: userId,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await db.insert(stockDocLines).values({ stockDocId: doc.id, skuId, warehouseId: opts.from, toWarehouseId: opts.to, qty: opts.qty });
    if (opts.fee != null) {
      await db.insert(transferFees).values({ stockDocId: doc.id, feeType: "freight", amount: opts.fee, bizDate: opts.date, createdBy: userId });
    }
    return doc.id;
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "线路测试", roles: ["warehouse"] }).returning();
    userId = u.id;
    const [a] = await db.insert(warehouses).values({ code: "TR-A", name: "工厂仓", kind: "finished" }).returning();
    const [b] = await db.insert(warehouses).values({ code: "TR-B", name: "华东仓", kind: "finished" }).returning();
    const [c] = await db.insert(warehouses).values({ code: "TR-C", name: "华南仓", kind: "finished" }).returning();
    whA = a.id; whB = b.id; whC = c.id;
    const [spu] = await db.insert(spus).values({ code: "PTR01", nameCn: "线路品" }).returning();
    const [s] = await db.insert(skus).values({ code: "TR001", name: "线路SKU", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    skuId = s.id;

    // 线路 A→B factory_to_warehouse：9 单有费用，单位费 ≈ 1.00，最后一单 2.50（离群）
    const dates = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29", "2026-08-04", "2026-08-12", "2026-08-19"];
    const fees = ["100.00", "102.00", "98.00", "101.00", "99.00", "100.00", "103.00", "97.00"];
    for (let i = 0; i < dates.length; i++) await mkDoc({ from: whA, to: whB, type: "factory_to_warehouse", qty: "100", date: dates[i], fee: fees[i] });
    await mkDoc({ from: whA, to: whB, type: "factory_to_warehouse", qty: "100", date: "2026-08-26", fee: "250.00" });
    // 同线路一单未登记费用（不进样本）
    await mkDoc({ from: whA, to: whB, type: "factory_to_warehouse", qty: "100", date: "2026-08-27" });
    // 窗口外（超过 180 天）不计
    await mkDoc({ from: whA, to: whB, type: "factory_to_warehouse", qty: "100", date: "2026-01-01", fee: "999.00" });
    // 草稿不计
    await mkDoc({ from: whA, to: whB, type: "factory_to_warehouse", qty: "100", date: "2026-08-28", fee: "1.00", status: "draft" });
    // 线路 A→C 未分类（存量）：2 单，样本不足；近 30 天 5 单 → 零散（含无费用单）
    await mkDoc({ from: whA, to: whC, type: null, qty: "10", date: "2026-08-10", fee: "30.00" });
    await mkDoc({ from: whA, to: whC, type: null, qty: "10", date: "2026-08-20", fee: "60.00" });
    for (const d of ["2026-08-25", "2026-08-28", "2026-09-01"]) await mkDoc({ from: whA, to: whC, type: null, qty: "10", date: d });
    // 线路 B→C 仓间：数量异常（7 月 8 单 10 件 + 08-30 1 单 100 件），无费用；近 30 天仅 1 单不零散
    for (let i = 1; i <= 8; i++) await mkDoc({ from: whB, to: whC, type: "inter_warehouse", qty: "10", date: `2026-07-${String(i).padStart(2, "0")}` });
    await mkDoc({ from: whB, to: whC, type: "inter_warehouse", qty: "100", date: "2026-08-30" });
  });

  it("事实装载：只取完成单；件数/费用净额/hasFee 正确；未分类单 transferType=null", async () => {
    const facts = await loadTransferDocFacts(db, { statuses: ["completed"] });
    expect(facts.every((f) => f.status === "completed")).toBe(true);
    const ab = facts.filter((f) => f.fromWarehouseId === whA && f.toWarehouseId === whB);
    expect(ab).toHaveLength(11); // 9 有费 + 1 无费 + 1 窗口外
    expect(ab[0]).toMatchObject({ qty: "100.0000", fromWarehouse: "工厂仓", toWarehouse: "华东仓" });
    expect(ab.filter((f) => f.hasFee)).toHaveLength(10);
    expect(facts.filter((f) => f.transferType == null)).toHaveLength(5);
  });

  it("线路汇总：数量加权均价/中位数/样本数；留一法把离群单判为 alert；未分类线路样本不足只提醒并零散", async () => {
    const facts = await loadTransferDocFacts(db, { statuses: ["completed"] });
    const m = computeTransferRoutes(facts, PARAMS, AS_OF);
    expect(m.windowStart).toBe("2026-03-08");
    const ab = m.lanes.find((l) => l.laneKey === laneKeyOf(whA, whB, "factory_to_warehouse"))!;
    expect(ab).toBeDefined();
    expect(ab.docCount).toBe(10); // 窗口内完成单（含无费单），窗口外/草稿不计
    expect(ab.samples).toBe(9);
    expect(ab.totalQty).toBe("1000.0000");
    expect(ab.amount).toBe("1050.00");
    expect(ab.avgUnitFee).toBe("1.1667"); // 1050 / 900
    expect(ab.medianUnitFee).toBe("1.0000");
    expect(ab.medianQty).toBe("100.0000");
    expect(ab.docCount30).toBe(4); // 近 30 天 = 08-05..09-03：08-12/08-19/08-26/08-27（08-04 在窗口外）→ 4 ≤ batchMaxDocs，不零散
    expect(ab.recentDocs).toHaveLength(5);
    expect(ab.recentDocs[0].docNo).toBe("DB-TR0010"); // 最近一单（无费用）
    expect(ab.recentDocs[0].unitFee).toBeNull();
    expect(ab.recentDocs[1].unitFee).toBe("2.5000");

    const outlier = m.anomalies.find((a) => a.docNo === "DB-TR0009")!;
    expect(outlier).toBeDefined();
    expect(outlier.feeLevel).toBe("alert");
    expect(outlier.feeSamples).toBe(8);
    expect(outlier.level).toBe("alert");
    expect(outlier.feePctDev).toBe("150.00");
    // 正常单不进异常
    expect(m.anomalies.some((a) => a.docNo === "DB-TR0001")).toBe(false);

    const ac = m.lanes.find((l) => l.laneKey === laneKeyOf(whA, whC, null))!;
    expect(ac.transferType).toBe("unclassified");
    expect(ac.transferTypeLabel).toBe("未分类（存量）");
    expect(ac.samples).toBe(2);
    expect(ac.docCount30).toBe(5);
    expect(ac.scattered).toBe(true);
    // 第二单 6.00 vs 基线 3.00 → 样本不足只 watch
    const acWatch = m.anomalies.find((a) => a.docNo === "DB-TR0014")!;
    expect(acWatch.feeLevel).toBe("watch");
    expect(acWatch.feeInsufficient).toBe(true);
    expect(acWatch.level).toBe("watch");

    const bc = m.lanes.find((l) => l.laneKey === laneKeyOf(whB, whC, "inter_warehouse"))!;
    expect(bc.status).toBe("no_fee");
    expect(bc.samples).toBe(0);
    const qtyAnom = m.anomalies.find((a) => a.laneKey === bc.laneKey)!;
    expect(qtyAnom).toBeDefined();
    expect(qtyAnom.qtyLevel).toBe("watch");
    expect(qtyAnom.qtyMedian).toBe("10.0000");
    expect(qtyAnom.qtyRatio).toBe("10.00");
    expect(qtyAnom.qty).toBe("100.0000");

    expect(m.summary).toMatchObject({ laneCount: 3, feeDocCount: 11, unclassifiedDocCount: 5, alertCount: 1, scatteredLaneCount: 1 });
    expect(m.summary.anomalyCount).toBe(m.anomalies.length);
    expect(m.lanes[0].laneKey).toBe(ac.laneKey); // 按 30 天单数排序
  });

  it("近 30 天单数按 asOf 往前 30 天（含当日）", async () => {
    const facts = await loadTransferDocFacts(db, { statuses: ["completed"] });
    const m = computeTransferRoutes(facts, PARAMS, AS_OF);
    const ab = m.lanes.find((l) => l.laneKey === laneKeyOf(whA, whB, "factory_to_warehouse"))!;
    // 窗口 08-05..09-03（含当日）：08-12、08-19、08-26、08-27；08-04 刚好落在窗口外
    expect(ab.docCount30).toBe(4);
    expect(ab.scattered).toBe(false);
  });

  it("缓存：首读写入 report_read_model_cache，绑定不变命中缓存；新增费用后绑定变化 → 重算", async () => {
    const first = await loadTransferRoutes(db, { asOf: AS_OF });
    expect(first.key).toBe(TRANSFER_ROUTES_CACHE_KEY);
    const cached = await db.execute(sql`SELECT source_binding FROM report_read_model_cache WHERE key = ${TRANSFER_ROUTES_CACHE_KEY}`);
    const rows = (Array.isArray(cached) ? cached : (cached as { rows: unknown[] }).rows) as { source_binding: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source_binding).toContain("asOf:2026-09-03");
    const second = await loadTransferRoutes(db, { asOf: AS_OF });
    expect(second.builtAt).toBe(first.builtAt); // 命中缓存

    const [doc] = await db.select({ id: stockDocs.id }).from(stockDocs).where(sql`${stockDocs.docNo} = 'DB-TR0010'`);
    await db.insert(transferFees).values({ stockDocId: doc.id, feeType: "freight", amount: "100.00", bizDate: "2026-08-27", createdBy: userId });
    const third = await loadTransferRoutes(db, { asOf: AS_OF });
    expect(third.builtAt).not.toBe(first.builtAt);
    const ab = third.lanes.find((l) => l.laneKey === laneKeyOf(whA, whB, "factory_to_warehouse"))!;
    expect(ab.samples).toBe(10);
    const forced = await refreshTransferRoutes(db, { asOf: AS_OF });
    expect(forced.summary.feeDocCount).toBe(12);
  });

  it("金额出口：stripLaneMoney 置空线路/异常/最近批次金额；filterTransferRoutes 按线路裁剪", async () => {
    const m = await loadTransferRoutes(db, { asOf: AS_OF });
    const stripped = stripLaneMoney(m);
    expect(stripped.summary.amount).toBeNull();
    expect(stripped.lanes.every((l) => l.amount == null && l.avgUnitFee == null && l.medianUnitFee == null)).toBe(true);
    expect(stripped.lanes.every((l) => l.recentDocs.every((d) => d.unitFee == null && d.amount == null))).toBe(true);
    expect(stripped.anomalies.every((a) => a.unitFee == null && a.feePctDev == null)).toBe(true);
    // 数量维度保留
    expect(stripped.lanes.map((l) => l.docCount)).toEqual(m.lanes.map((l) => l.docCount));
    const f = filterTransferRoutes(m, { fromWarehouseId: whB, toWarehouseId: whC, transferType: "inter_warehouse" });
    expect(f.lanes).toHaveLength(1);
    expect(f.anomalies.every((a) => a.laneKey === f.lanes[0].laneKey)).toBe(true);
    const onlyAlert = filterTransferRoutes(m, { level: "alert" });
    expect(onlyAlert.anomalies.every((a) => a.level === "alert")).toBe(true);
    expect(onlyAlert.anomalies.length).toBe(1);
  });
});
