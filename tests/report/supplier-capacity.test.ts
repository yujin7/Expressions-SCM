import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  boms,
  jgDocs,
  shDocs,
  shLines,
  skus,
  spus,
  suppliers,
  users,
  warehouses,
  woDocs,
} from "@/db/schema";
import { capacityAuditSnapshot, getSupplierCapacitySignal } from "@/server/modules/report/supplier-capacity";
import { createTestDb, type TestDb } from "../helpers/db";

describe("supplier capacity learning", () => {
  let db: TestDb;
  let supplierId = 0;
  let otherSupplierId = 0;
  let boxSkuId = 0;
  let kgSkuId = 0;
  let userId = 0;
  let warehouseId = 0;
  let woId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [user] = await db.insert(users).values({ name: "PMC", roles: ["pmc"] }).returning();
    userId = user.id;
    const [supplier, otherSupplier] = await db.insert(suppliers).values([
      { code: "CAP-001", name: "学习工厂", kinds: ["processor"], status: "qualified" },
      { code: "CAP-002", name: "无历史工厂", kinds: ["processor"], status: "qualified",
        declaredMonthlyCapacity: "1000", capacityUom: "盒", surgeCapacityPct: 25,
        capacityValidFrom: "2026-01-01", capacityValidUntil: "2026-12-31", capacityEvidence: "供应商合成申报 CAP002" },
    ]).returning();
    supplierId = supplier.id;
    otherSupplierId = otherSupplier.id;
    const [spu] = await db.insert(spus).values({ code: "PCAP01", nameCn: "产能测试" }).returning();
    const [boxSku, kgSku] = await db.insert(skus).values([
      { code: "FG-CAP-BOX", name: "盒装成品", spuId: spu.id, baseUom: "盒", skuType: "finished" },
      { code: "FG-CAP-KG", name: "公斤成品", spuId: spu.id, baseUom: "kg", skuType: "finished" },
    ]).returning();
    boxSkuId = boxSku.id;
    kgSkuId = kgSku.id;
    const [bom] = await db.insert(boms).values({
      productSkuId: boxSkuId,
      versionNo: "CAP-V1",
      status: "active",
      effectiveDate: "2026-01-01",
    }).returning();
    const [wo] = await db.insert(woDocs).values({
      docNo: "WO-CAP-001",
      status: "approved",
      productSkuId: boxSkuId,
      qty: "10000",
      supplierId,
      feeRatePlan: "1",
      bomId: bom.id,
      createdBy: userId,
    }).returning();
    woId = wo.id;
    const [warehouse] = await db.insert(warehouses).values({
      code: "WH-CAP",
      name: "成品仓",
      kind: "finished",
      accountingMode: "realtime",
    }).returning();
    warehouseId = warehouse.id;

    for (let i = 0; i < 6; i += 1) {
      const [jg] = await db.insert(jgDocs).values({
        docNo: `JG-CAP-${i + 1}`,
        status: "completed",
        woId,
        batchSeq: i + 1,
        supplierId,
        productSkuId: boxSkuId,
        qty: String((i + 1) * 100),
        feeRateCurrent: "1",
        createdBy: userId,
      }).returning();
      const [sh] = await db.insert(shDocs).values({
        docNo: `SH-CAP-${i + 1}`,
        status: "completed",
        sourceType: "jg",
        sourceId: jg.id,
        warehouseId,
        createdBy: userId,
        createdAt: new Date(`2026-${String(i + 1).padStart(2, "0")}-15T04:00:00.000Z`),
      }).returning();
      await db.insert(shLines).values({
        shId: sh.id,
        skuId: boxSkuId,
        lineType: "normal",
        actualQty: String((i + 1) * 100),
      });
    }

    // Same supplier but a different base UOM: must never inflate box capacity.
    const [kgJg] = await db.insert(jgDocs).values({
      docNo: "JG-CAP-KG",
      status: "completed",
      woId,
      batchSeq: 7,
      supplierId,
      productSkuId: kgSkuId,
      qty: "99999",
      feeRateCurrent: "1",
      createdBy: userId,
    }).returning();
    const [kgSh] = await db.insert(shDocs).values({
      docNo: "SH-CAP-KG",
      status: "completed",
      sourceType: "jg",
      sourceId: kgJg.id,
      warehouseId,
      createdBy: userId,
      createdAt: new Date("2026-06-20T04:00:00.000Z"),
    }).returning();
    await db.insert(shLines).values({
      shId: kgSh.id,
      skuId: kgSkuId,
      lineType: "normal",
      actualQty: "99999",
    });

    // Current incomplete month receipt must not enter historical P90.
    const [currentJg] = await db.insert(jgDocs).values({
      docNo: "JG-CAP-CURRENT",
      status: "approved",
      woId,
      batchSeq: 8,
      supplierId,
      productSkuId: boxSkuId,
      qty: "750",
      dueDate: "2026-07-20",
      feeRateCurrent: "1",
      createdBy: userId,
    }).returning();
    const [currentSh] = await db.insert(shDocs).values({
      docNo: "SH-CAP-CURRENT",
      status: "approved",
      sourceType: "jg",
      sourceId: currentJg.id,
      warehouseId,
      createdBy: userId,
      createdAt: new Date("2026-07-10T04:00:00.000Z"),
    }).returning();
    await db.insert(shLines).values({
      shId: currentSh.id,
      skuId: boxSkuId,
      lineType: "normal",
      actualQty: "50000",
    });
  });

  it("separates UOMs, excludes the partial month, and warns without blocking", async () => {
    const signal = await getSupplierCapacitySignal({
      supplierId,
      baseUom: "盒",
      dueDate: "2026-07-28",
      candidateQty: "300",
      asOf: new Date("2026-07-27T04:00:00.000Z"),
    }, db);
    expect(signal).toMatchObject({
      advisoryOnly: true,
      dueMonth: "2026-07",
      scheduledQty: "750.0000",
      candidateQty: "300.0000",
      projectedQty: "1050.0000",
      utilizationPct: "190.91",
      overP90: true,
      excessQty: "500.0000",
      stats: {
        sampleMonths: 6,
        reliable: true,
        p50: "350.0000",
        p90: "550.0000",
      },
    });
  });

  it("auto-unlocks and remains non-blocking when history is insufficient", async () => {
    const signal = await getSupplierCapacitySignal({
      supplierId: otherSupplierId,
      baseUom: "盒",
      dueDate: "2026-07-28",
      candidateQty: "99999",
      asOf: new Date("2026-07-27T04:00:00.000Z"),
    }, db);
    expect(signal.stats).toMatchObject({ sampleMonths: 0, reliable: false, p90: null });
    expect(signal).toMatchObject({ advisoryOnly: true, overP90: false, utilizationPct: null });
    expect(signal.declared).toMatchObject({ state: "comparable", normalLimitQty: "1000.0000", surgeLimitQty: "1250.0000", overSurge: true });
    expect(capacityAuditSnapshot(signal).declared).toEqual(signal.declared);
  });

  it("主档申报独立被消费；不需要伪造历史P90，不跨单位", async () => {
    const input = { supplierId: otherSupplierId, baseUom: "盒", dueDate: "2026-07-28", candidateQty: "1100", asOf: new Date("2026-07-27T04:00:00Z") };
    const signal = await getSupplierCapacitySignal(input, db);
    expect(signal).toMatchObject({ scheduledQty: "0.0000", projectedQty: "1100.0000", stats: { p90: null, reliable: false },
      declared: { state: "comparable", normalHeadroomQty: "-100.0000", surgeHeadroomQty: "150.0000", capacityEvidence: "供应商合成申报 CAP002" } });
    expect((await getSupplierCapacitySignal({ ...input, baseUom: "kg" }, db)).declared.state).toBe("unit_mismatch");
    expect((await getSupplierCapacitySignal({ ...input, dueDate: null }, db)).declared.state).toBe("missing_due_date");
  });

  it("缺交期的未结JG使申报比较弃权；已结/排除自身不造成假缺口", async () => {
    const [jg] = await db.insert(jgDocs).values({ docNo: "JG-CAP-UNDATED", status: "draft", woId, batchSeq: 9,
      supplierId: otherSupplierId, productSkuId: boxSkuId, qty: "200", feeRateCurrent: "1", createdBy: userId }).returning();
    const input = { supplierId: otherSupplierId, baseUom: "盒", dueDate: "2026-07-28", candidateQty: "1100", asOf: new Date("2026-07-27T04:00:00Z") };
    try {
      expect(await getSupplierCapacitySignal(input, db)).toMatchObject({ undatedOrders: 1, declared: { state: "incomplete_schedule", normalHeadroomQty: null } });
      expect((await getSupplierCapacitySignal({ ...input, excludeJgId: jg.id }, db)).declared.state).toBe("comparable");
      await db.update(jgDocs).set({ status: "completed" }).where(eq(jgDocs.id, jg.id));
      expect((await getSupplierCapacitySignal(input, db)).declared.state).toBe("comparable");
    } finally {
      await db.update(jgDocs).set({ status: "completed" }).where(eq(jgDocs.id, jg.id));
    }
  });
});
