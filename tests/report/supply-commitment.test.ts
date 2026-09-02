import { beforeAll, describe, expect, it } from "vitest";

import {
  poDocs,
  poLines,
  poPromiseRevisions,
  qcLines,
  qcRecords,
  shDocs,
  shLines,
  skus,
  spus,
  suppliers,
  warehouses,
} from "@/db/schema";
import {
  buildPromiseReliability,
  loadPromiseReliability,
  type PromiseLineFact,
} from "@/server/modules/report/supply-commitment";
import { createTestDb, type TestDb } from "../helpers/db";

function line(seed: Partial<PromiseLineFact> & Pick<PromiseLineFact, "lineId" | "poId" | "skuId">): PromiseLineFact {
  return {
    lineId: seed.lineId,
    poId: seed.poId,
    docNo: seed.docNo ?? `PO-${seed.poId}`,
    supplierCode: seed.supplierCode ?? "SUP001",
    supplierName: seed.supplierName ?? "供应商甲",
    skuId: seed.skuId,
    skuCode: seed.skuCode ?? `SKU-${seed.skuId}`,
    skuName: seed.skuName ?? "测试物料",
    baseUom: seed.baseUom ?? "件",
    orderQty: seed.orderQty ?? "10",
    uomFactor: seed.uomFactor ?? "1",
    currentReceivedQty: seed.currentReceivedQty ?? "0",
    promisedDate: seed.promisedDate === undefined ? "2026-08-05" : seed.promisedDate,
    originalPromisedDate: seed.originalPromisedDate ?? null,
    promiseHistoryState: seed.promiseHistoryState ?? "missing",
    revisionCount: seed.revisionCount ?? 0,
  };
}

describe("供给承诺可信度纯计算", () => {
  it("分开按期足量、迟到补齐、逾期未齐，并排除未知、未来、重复归属和控制量不一致", () => {
    const lines = [
      line({ lineId: 1, poId: 1, skuId: 1, currentReceivedQty: "10" }),
      line({ lineId: 2, poId: 2, skuId: 2, promisedDate: "2026-08-03", currentReceivedQty: "10" }),
      line({ lineId: 3, poId: 3, skuId: 3, promisedDate: "2026-08-01", currentReceivedQty: "3" }),
      line({ lineId: 4, poId: 4, skuId: 4, promisedDate: null }),
      line({ lineId: 5, poId: 5, skuId: 5, promisedDate: "2026-08-20" }),
      line({ lineId: 6, poId: 6, skuId: 6, promisedDate: "2026-08-02" }),
      line({ lineId: 7, poId: 6, skuId: 6, promisedDate: "2026-08-02" }),
      line({ lineId: 8, poId: 8, skuId: 8, promisedDate: "2026-08-02", currentReceivedQty: "2" }),
      line({ lineId: 9, poId: 9, skuId: 9, promisedDate: "2026-06-01" }),
    ];
    const result = buildPromiseReliability(
      lines,
      [
        { poId: 1, skuId: 1, acceptedQty: "10", acceptedDate: "2026-08-05" },
        { poId: 2, skuId: 2, acceptedQty: "10", acceptedDate: "2026-08-06" },
        { poId: 3, skuId: 3, acceptedQty: "5", acceptedDate: "2026-08-01" },
      ],
      [{ poLineId: 3, qty: "2", returnedDate: "2026-08-04" }],
      { asOf: "2026-08-10", windowDays: 30 },
    );

    expect(result.state).toBe("ready");
    expect(result.rate).toBe(33.33);
    expect(result.totals).toEqual({
      effectiveLines: 9,
      promisedLines: 8,
      eligibleLines: 3,
      onTimeInFull: 1,
      lateFull: 1,
      overdueShort: 1,
      undated: 1,
      future: 1,
      outsideWindow: 1,
      ambiguous: 2,
      controlMismatch: 1,
    });
    expect(result.coverage).toEqual({ promisePct: 88.89, calculablePct: 50, historyPct: 0 });
    expect(result.originalRate).toBeNull();
    expect(result.promiseVersionState).toBe("current_only");
    expect(result.exceptions.map((item) => ({
      lineId: item.lineId,
      status: item.status,
      daysLate: item.daysLate,
      shortQty: item.shortQty,
    }))).toEqual([
      { lineId: 3, status: "overdue_short", daysLate: 9, shortQty: 7 },
      { lineId: 2, status: "late_full", daysLate: 3, shortQty: 0 },
    ]);
    expect(result.externalEdges.map((item) => item.source)).toEqual(["JIANDAOYUN", "JST", "YONYOU"]);
  });

  it("没有可计算行时保持证据不足，而不是返回 0%", () => {
    const result = buildPromiseReliability(
      [line({ lineId: 1, poId: 1, skuId: 1, promisedDate: null })],
      [],
      [],
      { asOf: "2026-08-10" },
    );
    expect(result.state).toBe("insufficient");
    expect(result.rate).toBeNull();
    expect(result.gate).toContain("不会被当作零");
  });

  it("原始承诺与当前承诺分列，改期不能覆盖掉原始迟延", () => {
    const result = buildPromiseReliability(
      [line({
        lineId: 1,
        poId: 1,
        skuId: 1,
        promisedDate: "2026-08-08",
        originalPromisedDate: "2026-08-05",
        promiseHistoryState: "trusted",
        revisionCount: 1,
        currentReceivedQty: "10",
      })],
      [{ poId: 1, skuId: 1, acceptedQty: "10", acceptedDate: "2026-08-07" }],
      [],
      { asOf: "2026-08-10", windowDays: 30 },
    );
    expect(result.rate).toBe(100);
    expect(result.originalRate).toBe(0);
    expect(result.promiseVersionState).toBe("immutable_history");
    expect(result.originalTotals).toMatchObject({ eligibleLines: 1, lateFull: 1, historyTrusted: 1 });
    expect(result.exceptions).toEqual([
      expect.objectContaining({ basis: "original", status: "late_full", promisedDate: "2026-08-05", revisionCount: 1 }),
    ]);
  });
});

describe("供给承诺可信度数据库加载", () => {
  let db: TestDb;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "P-PROMISE", nameCn: "承诺测试" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "YL-PROMISE",
      name: "承诺物料",
      spuId: spu.id,
      skuType: "raw",
      baseUom: "kg",
    }).returning();
    const [supplier] = await db.insert(suppliers).values({ code: "SUP-PROMISE", name: "承诺供应商" }).returning();
    const [warehouse] = await db.insert(warehouses).values({
      code: "WH-PROMISE",
      name: "承诺仓",
      kind: "raw",
      accountingMode: "realtime",
    }).returning();
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-PROMISE-1",
      status: "completed",
      supplierId: supplier.id,
      expectedDate: "2026-08-05",
      createdBy: 1,
    }).returning();
    const [poLine] = await db.insert(poLines).values({
      poId: po.id,
      skuId: sku.id,
      lineType: "raw",
      purchaseUom: "袋",
      uomFactor: "5",
      qty: "2",
      price: "100",
      receivedQty: "10",
    }).returning();
    await db.insert(poPromiseRevisions).values({
      poId: po.id,
      poLineId: poLine.id,
      sequence: 1,
      previousDate: null,
      promisedDate: "2026-08-05",
      source: "supplier_confirm",
      actorType: "supplier_token",
      reason: "首次承诺",
      idempotencyKey: `test:promise:${poLine.id}:1`,
    });
    const [sh] = await db.insert(shDocs).values({
      docNo: "SH-PROMISE-1",
      status: "completed",
      sourceType: "po",
      sourceId: po.id,
      warehouseId: warehouse.id,
      createdBy: 1,
      createdAt: new Date("2026-08-05T08:00:00+08:00"),
    }).returning();
    const [shLine] = await db.insert(shLines).values({
      shId: sh.id,
      skuId: sku.id,
      actualQty: "10",
    }).returning();
    const [qc] = await db.insert(qcRecords).values({
      shId: sh.id,
      conclusion: "pass",
      createdBy: 1,
      createdAt: new Date("2026-08-06T00:30:00+08:00"),
    }).returning();
    await db.insert(qcLines).values({
      qcId: qc.id,
      shLineId: shLine.id,
      passQty: "8",
      failQty: "0",
      concessionQty: "2",
    });
  });

  it("按基础单位读取 PO、合格加让步接收、质检确认日和当前已收控制量", async () => {
    const result = await loadPromiseReliability({ asOf: "2026-08-10", windowDays: 30 }, db);
    expect(result.totals.eligibleLines).toBe(1);
    expect(result.totals.lateFull).toBe(1);
    expect(result.rate).toBe(0);
    expect(result.originalRate).toBe(0);
    expect(result.originalTotals.lateFull).toBe(1);
    expect(result.promiseVersionState).toBe("immutable_history");
    expect(result.totals.controlMismatch).toBe(0);
    expect(result.exceptions[0]).toMatchObject({
      status: "late_full",
      receivedAsOf: 10,
      fulfilledDate: "2026-08-06",
      daysLate: 1,
    });
  });
});
