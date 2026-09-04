/**
 * W2 审计 1 回归：**OTIF 不得被供应商自己的改期洗白**。
 *
 * 事故形态：`purchase-order-metrics` 与 `supplier-scorecard` 都按 `coalesce(行交期, 表头交期)`
 * 判准时——而这个日期正是供应商经确认门户能改的那个。供应商把 3-10 的承诺改到 4-30，
 * 4-20 才到货，两处读数都记「准时」。改期越勤，分数越高。
 *
 * 本测试构造的就是这一幕：原始承诺 2026-03-10（供应商第一次确认），
 * 供应商改期到 2026-04-30，实际 2026-04-20 收齐。
 *   - 原始承诺口径（主）→ miss；
 *   - 当前承诺口径（副）→ hit。
 * 修复前两个数字都是 hit（只有一个口径），因此本文件在修复前必红。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  approvals, poDocs, poLines, poPromiseRevisions, shDocs, shLines, skus, spus, suppliers, users, warehouses,
} from "@/db/schema";
import { computePurchaseOrderMetrics } from "@/server/modules/report/purchase-order-metrics";
import { getSupplierScorecard } from "@/server/modules/report/supplier-scorecard";
import { PROMISE_BASIS_LABELS, resolvePromiseBasis } from "@/server/rules/promise-basis";
import { createTestDb, type TestDb } from "../helpers/db";

const ASOF = new Date("2026-09-03T02:00:00.000Z");

describe("rules/promise-basis（原始承诺口径唯一权威）", () => {
  it("第一条可信修订即原始承诺；它算「承诺建立」不算改期", () => {
    const fact = resolvePromiseBasis([
      { sequence: 1, promisedDate: "2026-03-10", source: "supplier_confirm" },
      { sequence: 2, promisedDate: "2026-04-30", source: "supplier_confirm" },
    ]);
    expect(fact).toEqual({ originalPromisedDate: "2026-03-10", historyState: "trusted", revisionCount: 1 });
  });

  it("迁移快照打头 → backfilled，绝不冒充原始承诺；无版本链 → missing", () => {
    expect(resolvePromiseBasis([
      { sequence: 1, promisedDate: "2026-03-10", source: "legacy_backfill" },
      { sequence: 2, promisedDate: "2026-04-30", source: "supplier_confirm" },
    ])).toEqual({ originalPromisedDate: null, historyState: "backfilled", revisionCount: 1 });
    expect(resolvePromiseBasis([])).toEqual({ originalPromisedDate: null, historyState: "missing", revisionCount: 0 });
  });
});

describe("OTIF 反洗白：改期后原始承诺记未达、当前承诺记准时（两个口径并列）", () => {
  let db: TestDb;
  let supplierId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [buyer] = await db.insert(users).values({ username: "otif_buyer", name: "采购", roles: ["purchasing"], isApprover: true }).returning();
    const [approver] = await db.insert(users).values({ username: "otif_appr", name: "审批", roles: ["purchasing"], isApprover: true }).returning();
    const [sup] = await db.insert(suppliers).values({ code: "OTIF-A", name: "改期供应商", kinds: ["raw"], status: "qualified" }).returning();
    supplierId = sup.id;
    const [spu] = await db.insert(spus).values({ code: "OTIF-SPU", nameCn: "口径产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "OTIF-SKU", name: "原料", spuId: spu.id, baseUom: "支", skuType: "raw" }).returning();
    const [wh] = await db.insert(warehouses).values({ code: "OTIF-WH", name: "原料仓", kind: "raw" }).returning();

    // 表头/行交期 = **改期后**的当前承诺（确认门户回填的就是这个值）
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-OTIF-1", status: "completed", supplierId: sup.id, createdBy: buyer.id,
      createdAt: new Date("2026-02-01T02:00:00Z"), expectedDate: "2026-04-30",
    }).returning();
    await db.insert(approvals).values({
      docType: "po", docId: po.id, approverId: approver.id, action: "approve", cycle: 1,
      createdAt: new Date("2026-02-02T02:00:00Z"),
    });
    const [line] = await db.insert(poLines).values({
      poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "支", uomFactor: "1",
      qty: "100", price: "10.00", taxIncluded: false, taxRatePct: "13",
      receivedQty: "100", expectedDate: "2026-04-30",
    }).returning();

    // 不可变版本链：第一次确认 3-10（原始承诺），随后自行改期到 4-30
    await db.insert(poPromiseRevisions).values([
      {
        poId: po.id, poLineId: line.id, sequence: 1, previousDate: "2026-03-01", promisedDate: "2026-03-10",
        source: "supplier_confirm", actorType: "supplier_token", idempotencyKey: `po:${po.id}:line:${line.id}:promise-seq:1`,
        occurredAt: new Date("2026-02-03T02:00:00Z"),
      },
      {
        poId: po.id, poLineId: line.id, sequence: 2, previousDate: "2026-03-10", promisedDate: "2026-04-30",
        source: "supplier_confirm", actorType: "supplier_token", idempotencyKey: `po:${po.id}:line:${line.id}:promise-seq:2`,
        occurredAt: new Date("2026-03-08T02:00:00Z"),
      },
    ]);

    // 4-20 一次收齐：早于改期后的 4-30，晚于原始承诺 3-10
    const [sh] = await db.insert(shDocs).values({
      docNo: "SH-OTIF-1", status: "completed", sourceType: "po", sourceId: po.id,
      warehouseId: wh.id, createdBy: buyer.id, createdAt: new Date("2026-04-20T02:00:00Z"),
    }).returning();
    await db.insert(shLines).values({ shId: sh.id, skuId: sku.id, lineType: "normal", actualQty: "100" });
  });

  it("读模型主口径 = 原始承诺（miss），副口径 = 当前承诺（hit），两者都下发且都带标签", async () => {
    const m = await computePurchaseOrderMetrics(db, { asOf: ASOF });
    expect(m.key).toBe("purchase-order-metrics/v3");
    expect(m.otifBasis).toBe("original");
    expect(m.otifBasisLabel).toBe(PROMISE_BASIS_LABELS.original);
    expect(m.otifSecondaryBasisLabel).toBe(PROMISE_BASIS_LABELS.current);

    // 主口径：原始承诺 3-10 + 2 天窗口 < 实收 4-20 → 未达
    expect(m.summary.otif).toMatchObject({ evaluable: 1, hit: 0, miss: 1, rate: 0 });
    // 副口径：当前承诺 4-30 → 命中（这正是修复前唯一存在的那个数）
    expect(m.summary.otifCurrent).toMatchObject({ evaluable: 1, hit: 1, miss: 0, rate: 1 });

    const sup = m.bySupplier.find((r) => r.supplierId === supplierId)!;
    expect(sup.otif.hit).toBe(0);
    expect(sup.otifCurrent.hit).toBe(1);

    // 版本链覆盖必须下发：读者要知道有多少行真的按原始承诺判过
    expect(m.promiseHistory).toEqual({ trusted: 1, backfilled: 0, missing: 0 });
  });

  it("source_binding 绑住承诺版本链：供应商再改一次期，缓存必须失效", async () => {
    const before = (await computePurchaseOrderMetrics(db, { asOf: ASOF })).sourceBinding;
    expect(before).toContain("promise:");
    const [line] = await db.select().from(poLines);
    await db.insert(poPromiseRevisions).values({
      poId: line.poId, poLineId: line.id, sequence: 3, previousDate: "2026-04-30", promisedDate: "2026-05-31",
      source: "supplier_confirm", actorType: "supplier_token", idempotencyKey: `po:${line.poId}:line:${line.id}:promise-seq:3`,
      occurredAt: new Date("2026-04-01T02:00:00Z"),
    });
    const after = (await computePurchaseOrderMetrics(db, { asOf: ASOF })).sourceBinding;
    expect(after).not.toBe(before);
  });

  it("记分卡准时率同样按原始承诺计分，当前承诺只作并列展示", async () => {
    const card = await getSupplierScorecard({ windowDays: 1095 }, db);
    expect(card.onTimeBasisLabel).toBe(PROMISE_BASIS_LABELS.original);
    expect(card.onTimeSecondaryBasisLabel).toBe(PROMISE_BASIS_LABELS.current);
    const row = card.rows.find((r) => r.supplierId === supplierId)!;
    // 原始承诺 3-10（下单 2-01 起算 37 天）vs 实际 78 天 → 迟到；
    // 当前承诺 4-30（88 天）vs 实际 78 天 → 准时。修复前两列同值。
    expect(row.onTimeRate).toBe(0);
    expect(row.onTimeRateCurrent).toBe(1);
    expect(card.promiseHistory.trusted).toBeGreaterThan(0);
  });
});
