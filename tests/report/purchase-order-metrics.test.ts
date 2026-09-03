import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  approvals, brands, poDocs, poLines, reportReadModelCache, shDocs, skus, spus, suppliers, sysParams, users, warehouses,
} from "@/db/schema";
import {
  computePurchaseOrderMetrics, evaluateOtif, loadPurchaseOrderMetrics, purchaseOrderCockpitBlock,
  PURCHASE_ORDER_METRICS_KEY, refreshPurchaseOrderMetrics, stripPurchaseOrderMoney,
} from "@/server/modules/report/purchase-order-metrics";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * D63 采购订单指标读模型：已下单 = 审批通过时点；金额未税为主含税并列；周期 = 审批 → 首批 SH；
 * 降本基线 = 上一年度数量加权未税均价（无则首个）；OTIF 承诺日 + 窗口。
 */
const ASOF = new Date("2026-09-03T02:00:00.000Z");

describe("evaluateOtif（单张 PO 判定）", () => {
  const p = { windowDays: 2, qtyTolerancePct: 0 };
  it("缺承诺日 → 不可评；未到期未收齐 → 待评；到期未收齐 → 未命中", () => {
    expect(evaluateOtif({ promised: null, orderedBaseQty: "10", receivedBaseQty: "0", lastReceiptDay: null, today: "2026-09-03" }, p)).toBe("unevaluable");
    expect(evaluateOtif({ promised: "2026-09-05", orderedBaseQty: "10", receivedBaseQty: "5", lastReceiptDay: "2026-09-01", today: "2026-09-03" }, p)).toBe("pending");
    expect(evaluateOtif({ promised: "2026-08-20", orderedBaseQty: "10", receivedBaseQty: "5", lastReceiptDay: "2026-08-21", today: "2026-09-03" }, p)).toBe("miss");
  });
  it("窗口内收齐 → 命中；窗口外收齐 → 未命中；足量容差生效", () => {
    expect(evaluateOtif({ promised: "2026-08-20", orderedBaseQty: "10", receivedBaseQty: "10", lastReceiptDay: "2026-08-22", today: "2026-09-03" }, p)).toBe("hit");
    expect(evaluateOtif({ promised: "2026-08-20", orderedBaseQty: "10", receivedBaseQty: "10", lastReceiptDay: "2026-08-23", today: "2026-09-03" }, p)).toBe("miss");
    expect(evaluateOtif({ promised: "2026-08-20", orderedBaseQty: "100", receivedBaseQty: "98", lastReceiptDay: "2026-08-21", today: "2026-09-03" }, { windowDays: 2, qtyTolerancePct: 2 })).toBe("hit");
    expect(evaluateOtif({ promised: "2026-08-20", orderedBaseQty: "100", receivedBaseQty: "98", lastReceiptDay: "2026-08-21", today: "2026-09-03" }, p)).toBe("miss");
  });
});

describe("purchase-order-metrics/v1 读模型（PGlite）", () => {
  let db: TestDb;
  let userId = 0;
  let supplierAId = 0;
  let sku1Id = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [user] = await db.insert(users).values({ username: "pom_buyer", name: "采购", roles: ["purchasing"], isApprover: true }).returning();
    userId = user.id;
    const [approver] = await db.insert(users).values({ username: "pom_appr", name: "审批", roles: ["purchasing"], isApprover: true }).returning();
    const [supA, supB] = await db.insert(suppliers).values([
      { code: "POM-A", name: "指标供应商A", kinds: ["raw"], status: "qualified" },
      { code: "POM-B", name: "指标供应商B", kinds: ["packaging"], status: "qualified" },
    ]).returning();
    supplierAId = supA.id;
    const [brand] = await db.insert(brands).values({ code: "POMB", nameCn: "指标品牌" }).returning();
    const [spu] = await db.insert(spus).values({ code: "POM-SPU", nameCn: "指标产品" }).returning();
    const [sku1, sku2] = await db.insert(skus).values([
      { code: "POM-SKU1", name: "原料1", spuId: spu.id, baseUom: "支", skuType: "raw", brandId: brand.id },
      { code: "POM-SKU2", name: "包材2", spuId: spu.id, baseUom: "个", skuType: "packaging" },
    ]).returning();
    sku1Id = sku1.id;
    const [wh] = await db.insert(warehouses).values({ code: "POM-WH", name: "原料仓", kind: "raw" }).returning();

    const insertPo = async (docNo: string, supplierId: number, status: "approved" | "in_progress" | "completed" | "draft" | "void", createdAt: string, expectedDate: string | null) => {
      const [po] = await db.insert(poDocs).values({ docNo, status, supplierId, createdBy: userId, createdAt: new Date(createdAt), expectedDate }).returning();
      return po.id;
    };
    const approve = (docId: number, at: string) => db.insert(approvals).values({ docType: "po", docId, approverId: approver.id, action: "approve", cycle: 1, createdAt: new Date(at) });

    // 上一年度基线：sku1 20×10=200 支，含税 124.30/箱(10支) → 基础未税 11.00
    const poPrev = await insertPo("POM-PREV", supA.id, "completed", "2025-06-01T02:00:00Z", "2025-06-20");
    await approve(poPrev, "2025-06-02T02:00:00Z");
    await db.insert(poLines).values({ poId: poPrev, skuId: sku1.id, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "20", price: "124.30", taxIncluded: true, taxRatePct: "13", receivedQty: "200" });

    // 当年 PO-A（3 月审批）：sku1 10 箱 × 10 = 100 支 @113.00 含税 → 未税 1000.00 / 含税 1130.00，基础未税 10.00（降本 (11−10)×100=100）
    //   sku2 5 个 @20.00 未税 13% → 未税 100.00 / 含税 113.00，无上年基线 → 首个=自身 → 可比、降本 0
    const poA = await insertPo("POM-A", supA.id, "completed", "2026-03-01T02:00:00Z", "2026-03-20");
    await approve(poA, "2026-03-05T02:00:00Z");
    await db.insert(poLines).values([
      { poId: poA, skuId: sku1.id, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "10", price: "113.00", taxIncluded: true, taxRatePct: "13", receivedQty: "100" },
      { poId: poA, skuId: sku2.id, lineType: "packaging", purchaseUom: "个", uomFactor: "1", qty: "5", price: "20.00", taxIncluded: false, taxRatePct: "13", receivedQty: "5" },
    ]);
    // 首批 3-15 收货（全收同日）→ 首批 10 天；承诺 3-20 + 2 天窗口 → 命中
    await db.insert(shDocs).values({ docNo: "SH-POM-A1", status: "approved", sourceType: "po", sourceId: poA, warehouseId: wh.id, createdBy: userId, createdAt: new Date("2026-03-15T02:00:00Z") });

    // 当年 PO-B（4 月审批）：sku1 10 箱 @101.70 含税 → 未税 900.00 / 含税 1017.00，基础未税 9.00（降本 (11−9)×100=200）；无承诺日、未收货 → 不可评
    // 当年合计：未税 1000+100+900=2000.00，含税 1130+113+1017=2260.00；品牌 POMB（sku1）未税 1900.00
    const poB = await insertPo("POM-B", supA.id, "approved", "2026-04-01T02:00:00Z", null);
    await approve(poB, "2026-04-01T06:00:00Z");
    await db.insert(poLines).values({ poId: poB, skuId: sku1.id, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "10", price: "101.70", taxIncluded: true, taxRatePct: "13" });

    // 草稿 / 作废：不计
    const poDraft = await insertPo("POM-DRAFT", supB.id, "draft", "2026-05-01T02:00:00Z", null);
    await db.insert(poLines).values({ poId: poDraft, skuId: sku2.id, lineType: "packaging", purchaseUom: "个", qty: "999", price: "1.00" });
    const poVoid = await insertPo("POM-VOID", supB.id, "void", "2026-05-01T02:00:00Z", null);
    await approve(poVoid, "2026-05-02T02:00:00Z");
    await db.insert(poLines).values({ poId: poVoid, skuId: sku2.id, lineType: "packaging", purchaseUom: "个", qty: "999", price: "1.00" });
  });

  it("已下单按审批通过时点归期；金额未税为主含税并列；数量为基础单位", async () => {
    const m = await computePurchaseOrderMetrics(db, { asOf: ASOF });
    expect(m.year).toBe(2026);
    expect(m.month).toBe("2026-09");
    expect(m.baselineYear).toBe(2025);
    expect(m.summary.ytd).toEqual({ poCount: 2, lineCount: 3, orderedBaseQty: "205.0000", netAmount: "2000.00", grossAmount: "2260.00" });
    expect(m.summary.thisMonth.poCount).toBe(0);
    expect(m.summary.orderedPoAllTime).toBe(3);
    const march = m.byMonth.find((r) => r.month === "2026-03")!;
    expect(march).toMatchObject({ poCount: 1, lineCount: 2, orderedBaseQty: "105.0000", netAmount: "1100.00", grossAmount: "1243.00" });
    expect(m.byMonth).toHaveLength(12);
    expect(m.byMonth.at(-1)!.month).toBe("2026-09");
  });

  it("订单至交付 = 审批 → 首批 SH（样本不足不出分位）；OTIF 承诺日 + 窗口；缺承诺日不可评", async () => {
    const m = await computePurchaseOrderMetrics(db, { asOf: ASOF });
    expect(m.summary.cycle).toMatchObject({ n: 1, nFull: 1, insufficient: true, firstP50: null, fullP50: null });
    expect(m.summary.otif).toEqual({ evaluable: 1, hit: 1, miss: 0, pending: 0, unevaluable: 1, rate: 1 });
    const supA = m.bySupplier.find((r) => r.code === "POM-A")!;
    expect(supA.poCount).toBe(2);
    expect(supA.otif.hit).toBe(1);
    expect(m.bySupplier.find((r) => r.code === "POM-B")).toBeUndefined();
  });

  it("降本 = Σ(上年基线 − 当前) × 当年数量，只计降价；无上年基线取首个", async () => {
    const m = await computePurchaseOrderMetrics(db, { asOf: ASOF });
    expect(m.summary.costSaving).toEqual({ savingYtd: "300.00", increaseYtd: "0.00", comparableLines: 3, nonComparableLines: 0 });
    const block = purchaseOrderCockpitBlock(m);
    expect(block.costDown.savingYtd).toBe("300.00");
    expect(block.orderSystem.cycleInsufficient).toBe(true);
  });

  it("按品牌拆分（未归属品牌单列）", async () => {
    const m = await computePurchaseOrderMetrics(db, { asOf: ASOF });
    const branded = m.byBrand.find((r) => r.brandCode === "POMB")!;
    expect(branded).toMatchObject({ poCount: 2, lineCount: 2, orderedBaseQty: "200.0000", netAmount: "1900.00" });
    const none = m.byBrand.find((r) => r.brandId == null)!;
    expect(none).toMatchObject({ brandName: "未归属品牌", poCount: 1, orderedBaseQty: "5.0000" });
  });

  it("金额出口：非价格角色剥掉全部金额键，单数/数量保留", async () => {
    const m = await computePurchaseOrderMetrics(db, { asOf: ASOF });
    const stripped = stripPurchaseOrderMoney(m, ["ops"]);
    expect(stripped.moneyVisible).toBe(false);
    expect(stripped.summary.ytd).toMatchObject({ poCount: 2, orderedBaseQty: "205.0000", netAmount: null, grossAmount: null });
    expect(stripped.summary.costSaving.savingYtd).toBeNull();
    expect(stripped.bySupplier[0].netAmount).toBeNull();
    expect(stripped.bySupplier[0].costSaving.increaseYtd).toBeNull();
    expect(stripped.byBrand.every((r) => r.netAmount == null)).toBe(true);
    expect(JSON.stringify(stripped)).not.toContain("2000.00");
    expect(JSON.stringify(stripped)).not.toContain("1900.00");
    expect(stripPurchaseOrderMoney(m, ["finance"]).summary.ytd.netAmount).toBe("2000.00");
  });

  it("OTIF 参数可改：足量容差与窗口来自 sys_params", async () => {
    await db.insert(sysParams).values({ scope: "global", key: "otif_window_days", value: "0" });
    const m = await computePurchaseOrderMetrics(db, { asOf: ASOF });
    expect(m.params.otifWindowDays).toBe(0);
    expect(m.summary.otif.hit).toBe(1); // 3-15 收齐早于承诺 3-20，窗口 0 仍命中
    await db.delete(sysParams).where(eq(sysParams.key, "otif_window_days"));
  });

  it("缓存：绑定一致复用，新审批改变绑定后重算", async () => {
    const built = await refreshPurchaseOrderMetrics(db);
    const [row] = await db.select().from(reportReadModelCache).where(eq(reportReadModelCache.key, PURCHASE_ORDER_METRICS_KEY));
    expect(row.sourceBinding).toBe(built.sourceBinding);
    const cached = await loadPurchaseOrderMetrics({}, db);
    expect(cached.builtAt).toBe(built.builtAt);

    const [poC] = await db.insert(poDocs).values({ docNo: "POM-C", status: "approved", supplierId: supplierAId, createdBy: userId }).returning();
    await db.insert(approvals).values({ docType: "po", docId: poC.id, approverId: userId, action: "approve", cycle: 1 });
    await db.insert(poLines).values({ poId: poC.id, skuId: sku1Id, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "1", price: "113.00" });
    const fresh = await loadPurchaseOrderMetrics({}, db);
    expect(fresh.sourceBinding).not.toBe(built.sourceBinding);
    expect(fresh.summary.ytd.poCount).toBe(3);
  });
});
