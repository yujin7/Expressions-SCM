import { count, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  auditLogs,
  channels,
  planningVersionLines,
  planningVersions,
  poDocs,
  poLines,
  salesMonthly,
  skus,
  spus,
  stockBalances,
  suppliers,
  supplyDemandLinks,
  users,
  warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  capturePlanningVersion,
  comparePlanningVersions,
  getPlanningPegging,
  listPlanningVersions,
} from "@/server/modules/replenish/plan-versions";
import { createTestDb, type TestDb } from "../helpers/db";

describe("C122 planning version write/read loop", () => {
  let db: TestDb;
  let pmc: SessionUser;
  let purchasing: SessionUser;
  let warehouse: SessionUser;
  let skuId = 0;
  let warehouseId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const insertedUsers = await db.insert(users).values([
      { name: "计划员", roles: ["pmc"] },
      { name: "采购员", roles: ["purchasing"] },
      { name: "仓管员", roles: ["warehouse"] },
    ]).returning();
    pmc = { id: insertedUsers[0].id, name: insertedUsers[0].name, roles: ["pmc"], isApprover: false };
    purchasing = { id: insertedUsers[1].id, name: insertedUsers[1].name, roles: ["purchasing"], isApprover: false };
    warehouse = { id: insertedUsers[2].id, name: insertedUsers[2].name, roles: ["warehouse"], isApprover: false };

    const [spu] = await db.insert(spus).values({ code: "PLAN-SPU", nameCn: "计划测试产品" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "PLAN-001",
      name: "计划版本测试品",
      skuType: "finished",
      baseUom: "件",
      spuId: spu.id,
    }).returning();
    skuId = sku.id;
    const [channel] = await db.insert(channels).values({
      code: "PLAN-CH",
      name: "计划测试渠道",
      kind: "platform",
    }).returning();
    await db.insert(salesMonthly).values([
      { skuId, channelId: channel.id, yearMonth: "2026-04", qty: "300" },
      { skuId, channelId: channel.id, yearMonth: "2026-05", qty: "300" },
      { skuId, channelId: channel.id, yearMonth: "2026-06", qty: "310" },
    ]);
    const [warehouseRow] = await db.insert(warehouses).values({
      code: "PLAN-WH",
      name: "计划测试仓",
      kind: "finished",
      accountingMode: "realtime",
    }).returning();
    warehouseId = warehouseRow.id;
    const [supplier] = await db.insert(suppliers).values({
      code: "PLAN-SUP",
      name: "计划测试供应商",
    }).returning();
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-PLAN-1",
      status: "approved",
      supplierId: supplier.id,
      expectedDate: "2026-07-28",
      createdBy: pmc.id,
    }).returning();
    await db.insert(poLines).values({
      poId: po.id,
      skuId,
      lineType: "raw",
      purchaseUom: "件",
      uomFactor: "1",
      qty: "1",
      price: "1",
    });
  });

  it("captures an immutable all-SKU version atomically and replays idempotently", async () => {
    const key = "3f62dd2c-2307-4da4-a81f-e950346de670";
    const first = await capturePlanningVersion(pmc, { name: "第 31 周", idempotencyKey: key }, db);
    const replay = await capturePlanningVersion(pmc, { name: "不应覆盖", idempotencyKey: key }, db);
    expect(replay.id).toBe(first.id);
    expect(replay.name).toBe("第 31 周");
    expect(first.lineCount).toBe(1);
    expect(first.suggestedCount).toBe(1);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);

    const [versionCount] = await db.select({ value: count() }).from(planningVersions);
    const lines = await db.select().from(planningVersionLines).where(eq(planningVersionLines.versionId, first.id));
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "planning_version"));
    expect(Number(versionCount.value)).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      skuId,
      skuCode: "PLAN-001",
      suggestedQty: expect.any(String),
      suppressed: false,
      envelopeVersion: "decision-envelope/v1",
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(lines[0].decisionEnvelope).toMatchObject({
      schemaVersion: "decision-envelope/v1",
      decisionKind: "replenishment_recommendation",
      engine: { key: "time_phased_replenishment", version: "time-phased-v2" },
      inputs: { sku: { id: skuId, code: "PLAN-001" } },
      outputs: { suggestedQty: expect.any(String), suppressed: false },
    });
    const links = await db
      .select()
      .from(supplyDemandLinks)
      .where(eq(supplyDemandLinks.versionId, first.id));
    expect(links).toHaveLength(2);
    expect(links.find((link) => link.sourceType === "recommended_replenishment")).toMatchObject({
      skuId,
      sourceType: "recommended_replenishment",
      confidence: "proposed",
      status: expect.stringMatching(/^(pegged|partial)$/),
    });
    expect(links.find((link) => link.sourceType === "po")).toMatchObject({
      sourceRef: "PO-PLAN-1",
      confidence: "booked",
      peggedQty: "0.0000",
      status: "excluded_late",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityId: first.id, action: "capture", userId: pmc.id });
  });

  it("compares stored evidence and detects a resolved recommendation without recalculating history", async () => {
    const [first] = await db.select().from(planningVersions).orderBy(planningVersions.id).limit(1);
    await db.insert(stockBalances).values({ skuId, warehouseId, qty: "5000" });
    const second = await capturePlanningVersion(pmc, {
      name: "第 32 周",
      idempotencyKey: "c1783b78-60ad-44fc-b951-8fabf2573670",
    }, db);
    expect(second.lineCount).toBe(0);

    const diff = await comparePlanningVersions(purchasing, second.id, first.id, db);
    expect(diff.base?.id).toBe(first.id);
    expect(diff.current.id).toBe(second.id);
    expect(diff.summary.resolved).toBe(1);
    expect(diff.rows[0]).toMatchObject({
      skuId,
      category: "resolved",
      base: { skuCode: "PLAN-001" },
      current: null,
    });
  });

  it("enforces capture/read roles and validates comparison ids", async () => {
    await expect(capturePlanningVersion(purchasing, {
      idempotencyKey: "f5ce6223-acde-45f0-95a2-c064031b21f2",
    }, db)).rejects.toMatchObject({ status: 403 });
    await expect(listPlanningVersions(warehouse, db)).rejects.toMatchObject({ status: 403 });
    await expect(comparePlanningVersions(warehouse, 1, undefined, db)).rejects.toMatchObject({ status: 403 });
    await expect(comparePlanningVersions(pmc, 0, undefined, db)).rejects.toMatchObject({ status: 400 });
    const listed = await listPlanningVersions(purchasing, db);
    expect(listed.versions).toHaveLength(2);
  });

  it("traces frozen demand to supply and the exact supply back to demand", async () => {
    const [version] = await db.select().from(planningVersions).orderBy(planningVersions.id).limit(1);
    const forward = await getPlanningPegging(pmc, { versionId: version.id, skuId }, db);
    expect(forward.mode).toBe("demand_to_supply");
    expect(forward.summary).toMatchObject({
      demandCount: 1,
      linkCount: 2,
      proposedQty: expect.any(String),
    });
    expect(forward.rows.find((row: { sourceType: string }) => row.sourceType === "recommended_replenishment")).toMatchObject({
      skuCode: "PLAN-001",
      sourceType: "recommended_replenishment",
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const reverse = await getPlanningPegging(purchasing, {
      versionId: version.id,
      sourceType: "po",
      sourceRef: "PO-PLAN-1",
    }, db);
    expect(reverse.mode).toBe("supply_to_demand");
    expect(reverse.rows).toHaveLength(1);
    expect(reverse.rows[0]).toMatchObject({ skuId, sourceType: "po", sourceRef: "PO-PLAN-1" });

    await expect(getPlanningPegging(warehouse, { versionId: version.id, skuId }, db))
      .rejects.toMatchObject({ status: 403 });
    await expect(getPlanningPegging(pmc, {
      versionId: version.id,
      sourceType: "po",
    }, db)).rejects.toMatchObject({ status: 400 });
  });
});
