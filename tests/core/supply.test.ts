/**
 * E8-03 统一未结供给行视图（core/supply.ts）。
 * 覆盖四种口径：po 未收量（逐行下限 0、行级交期优先）、wo 在制（暂停不计）、
 * legacy_fg 存量单（扣 inbound+closed）、on_order 在订未出（默认不返回）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { boms, poDocs, poLines, skus, spus, suppliers, transitRefs, woDocs } from "@/db/schema";
import { getOpenSupplyLines, summarizeSupply } from "@/server/core/supply";
import { createTestDb, type TestDb } from "../helpers/db";

describe("未结供给行视图 getOpenSupplyLines", () => {
  let db: TestDb;
  let skuA = 0;
  let skuB = 0;
  const uid = 1;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const [a] = await db
      .insert(skus)
      .values({ code: "CP00001", name: "成品A", spuId: spu.id, skuType: "finished", baseUom: "盒" })
      .returning();
    const [b] = await db
      .insert(skus)
      .values({ code: "CP00002", name: "成品B", spuId: spu.id, skuType: "finished", baseUom: "盒" })
      .returning();
    skuA = a.id;
    skuB = b.id;
    const [sup] = await db.insert(suppliers).values({ code: "S001", name: "供应商甲" }).returning();

    /* ── PO：头交期 2026-08-01 的已审批单 ── */
    const [po1] = await db
      .insert(poDocs)
      .values({ docNo: "PO-S-1", status: "approved", supplierId: sup.id, expectedDate: "2026-08-01", createdBy: uid })
      .returning();
    // in_progress 且头/行皆无交期 → 无日期行
    const [po2] = await db
      .insert(poDocs)
      .values({ docNo: "PO-S-2", status: "in_progress", supplierId: sup.id, createdBy: uid })
      .returning();
    const [po3] = await db
      .insert(poDocs)
      .values({ docNo: "PO-S-3", status: "draft", supplierId: sup.id, expectedDate: "2026-08-02", createdBy: uid })
      .returning();
    await db.insert(poLines).values([
      // 部分收货：10×12−20=100；行级交期覆盖头交期
      { poId: po1.id, skuId: skuA, lineType: "raw", purchaseUom: "箱", uomFactor: "12", qty: "10", price: "5.00", receivedQty: "20", expectedDate: "2026-08-15" },
      // 无行级交期 → 回退头交期：5×10=50
      { poId: po1.id, skuId: skuA, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "5", price: "5.00" },
      // 已收满 → 不出现
      { poId: po1.id, skuId: skuA, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "1", price: "5.00", receivedQty: "10" },
      // 超收 → 下限 0，且不倒扣其他行
      { poId: po1.id, skuId: skuA, lineType: "raw", purchaseUom: "箱", uomFactor: "10", qty: "1", price: "5.00", receivedQty: "20" },
      // 另一 SKU（分组用）
      { poId: po1.id, skuId: skuB, lineType: "raw", purchaseUom: "个", uomFactor: "1", qty: "3", price: "1.00" },
      // 无任何交期 → expectDate=null
      { poId: po2.id, skuId: skuA, lineType: "raw", purchaseUom: "个", uomFactor: "1", qty: "2", price: "1.00" },
      // draft 单不计
      { poId: po3.id, skuId: skuA, lineType: "raw", purchaseUom: "个", uomFactor: "1", qty: "999", price: "1.00" },
    ]);

    /* ── WO：在制产出 ── */
    const [bom] = await db.insert(boms).values({ productSkuId: skuA, versionNo: "V1", status: "active" }).returning();
    const wo = (docNo: string, status: "approved" | "in_progress" | "completed" | "draft", qty: string, dueDate: string | null, isPaused = false) => ({
      docNo, status, productSkuId: skuA, qty, supplierId: sup.id, feeRatePlan: "2.00", bomId: bom.id, createdBy: uid, dueDate, isPaused,
    });
    await db.insert(woDocs).values([
      wo("WO-S-1", "approved", "300", "2026-09-01"),
      wo("WO-S-2", "in_progress", "400", "2026-09-05", true), // 暂停不计
      wo("WO-S-3", "approved", "60", null), // 无交期
      wo("WO-S-4", "completed", "900", "2026-09-09"), // 已完成不计
      wo("WO-S-5", "draft", "800", "2026-09-10"), // 草稿不计
    ]);

    /* ── 参考层 transit_refs ── */
    await db.insert(transitRefs).values([
      // 存量单在途：100−30−20=50
      { kind: "fg_order", skuId: skuA, qty: "100", inboundQty: "30", closedQty: "20", expectDate: "2026-08-20", externalNo: "FG-1", sourceJobId: 1 },
      // 已入库满 → 不计
      { kind: "fg_order", skuId: skuA, qty: "40", inboundQty: "40", closedQty: "0", expectDate: "2026-08-21", externalNo: "FG-2", sourceJobId: 1 },
      // inbound+closed 恰好抵完 → 不计
      { kind: "fg_order", skuId: skuA, qty: "30", inboundQty: "10", closedQty: "20", expectDate: "2026-08-22", externalNo: "FG-3", sourceJobId: 1 },
      // 未解析 SKU 的登记行 → 不进供给
      { kind: "fg_order", skuId: null, skuCode: "UNKNOWN", qty: "500", sourceJobId: 1 },
      // 在订未出（参考层最弱档，默认不返回）
      { kind: "stock_summary", skuId: skuA, qty: "1000", inboundQty: "77", progress: "2026-07-21", sourceJobId: 1 },
      { kind: "stock_summary", skuId: skuB, qty: "20", inboundQty: "0", sourceJobId: 1 },
    ]);
  });

  it("PO：部分收货只算余量、收满/超收行跳过且不倒扣、行级交期优先于头交期、draft 不计", async () => {
    const lines = (await getOpenSupplyLines(db, [skuA])).filter((l) => l.source === "po");
    expect(lines.map((l) => ({ qty: l.qty, expectDate: l.expectDate, ref: l.ref }))).toEqual([
      { qty: 50, expectDate: "2026-08-01", ref: "PO-S-1" }, // 头交期回退
      { qty: 100, expectDate: "2026-08-15", ref: "PO-S-1" }, // 行级交期优先
      { qty: 2, expectDate: null, ref: "PO-S-2" }, // 无交期
    ]);
    // 超收行未与其他行轧差：合计仍是 100+50+2
    expect(lines.reduce((s, l) => s + l.qty, 0)).toBe(152);
  });

  it("WO：已审批/执行中且未暂停才算；暂停/完成/草稿不计；无 dueDate → expectDate=null", async () => {
    const lines = (await getOpenSupplyLines(db, [skuA])).filter((l) => l.source === "wo");
    expect(lines.map((l) => ({ qty: l.qty, expectDate: l.expectDate, ref: l.ref }))).toEqual([
      { qty: 300, expectDate: "2026-09-01", ref: "WO-S-1" },
      { qty: 60, expectDate: null, ref: "WO-S-3" },
    ]);
  });

  it("legacy_fg：扣减 inbound+closed，抵完/未解析 SKU 的行不出现", async () => {
    const lines = (await getOpenSupplyLines(db, [skuA])).filter((l) => l.source === "legacy_fg");
    expect(lines.map(({ skuId, qty, expectDate, source, ref }) => ({ skuId, qty, expectDate, source, ref })))
      .toEqual([{ skuId: skuA, qty: 50, expectDate: "2026-08-20", source: "legacy_fg", ref: "FG-1" }]);
    expect(lines[0]).toMatchObject({ sourceDocId: expect.any(Number), sourceLineId: null });
  });

  it("on_order：默认不返回；includeOnOrder=true 时返回且无到货日", async () => {
    const off = await getOpenSupplyLines(db, [skuA, skuB]);
    expect(off.some((l) => l.source === "on_order")).toBe(false);

    const on = await getOpenSupplyLines(db, [skuA, skuB], { includeOnOrder: true });
    const onOrder = on.filter((l) => l.source === "on_order");
    expect(onOrder.map(({ skuId, qty, expectDate, source, ref }) => ({ skuId, qty, expectDate, source, ref })))
      .toEqual([{ skuId: skuA, qty: 77, expectDate: null, source: "on_order", ref: null }]); // B 的 0 量不出现
  });

  it("summarizeSupply：逐 SKU 分组，dated/undated 与 bySource 正确", async () => {
    const sum = summarizeSupply(await getOpenSupplyLines(db, [skuA, skuB]));
    const a = sum.get(skuA)!;
    expect(a.total).toBe(562); // PO 152 + WO 360 + 存量单 50
    expect(a.dated).toBe(500); // 100+50+300+50
    expect(a.undated).toBe(62); // PO 无交期 2 + WO 无交期 60
    expect(a.bySource).toEqual({ po: 152, wo: 360, legacy_fg: 50 });

    const b = sum.get(skuB)!;
    expect(b).toEqual({ total: 3, dated: 3, undated: 0, bySource: { po: 3 } });

    // 开启在订未出后进入 undated 与 bySource
    const sum2 = summarizeSupply(await getOpenSupplyLines(db, [skuA], { includeOnOrder: true }));
    const a2 = sum2.get(skuA)!;
    expect(a2.total).toBe(639);
    expect(a2.undated).toBe(139);
    expect(a2.bySource.on_order).toBe(77);
  });

  it("空 SKU 集合直接返回空（不触发查询）", async () => {
    expect(await getOpenSupplyLines(db, [])).toEqual([]);
    expect(summarizeSupply([]).size).toBe(0);
  });
});
