import { count, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  auditLogs,
  channels,
  projectionScenarios,
  salesMonthly,
  skus,
  spus,
  stockBalances,
  users,
  warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  listProjectionScenarios,
  saveProjectionScenario,
} from "@/server/modules/replenish/scenarios";
import { createTestDb, type TestDb } from "../helpers/db";

describe("C123 saved projection scenarios", () => {
  let db: TestDb;
  let pmc: SessionUser;
  let purchasing: SessionUser;
  let warehouse: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const people = await db.insert(users).values([
      { name: "情景计划员", roles: ["pmc"] },
      { name: "情景采购员", roles: ["purchasing"] },
      { name: "情景仓管员", roles: ["warehouse"] },
    ]).returning();
    pmc = { id: people[0].id, name: people[0].name, roles: ["pmc"], isApprover: false };
    purchasing = { id: people[1].id, name: people[1].name, roles: ["purchasing"], isApprover: false };
    warehouse = { id: people[2].id, name: people[2].name, roles: ["warehouse"], isApprover: false };

    const [spu] = await db.insert(spus).values({ code: "SCN-SPU", nameCn: "情景产品" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "SCN-001",
      name: "情景测试品",
      skuType: "finished",
      baseUom: "件",
      spuId: spu.id,
    }).returning();
    const [channel] = await db.insert(channels).values({
      code: "SCN-CH",
      name: "情景渠道",
      kind: "platform",
    }).returning();
    await db.insert(salesMonthly).values([
      { skuId: sku.id, channelId: channel.id, yearMonth: "2026-04", qty: "300" },
      { skuId: sku.id, channelId: channel.id, yearMonth: "2026-05", qty: "300" },
      { skuId: sku.id, channelId: channel.id, yearMonth: "2026-06", qty: "310" },
    ]);
    const [wh] = await db.insert(warehouses).values({
      code: "SCN-WH",
      name: "情景仓",
      kind: "finished",
      accountingMode: "realtime",
    }).returning();
    await db.insert(stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "100" });
  });

  it("saves baseline and scenario as immutable comparison evidence and replays idempotently", async () => {
    const payload = {
      sku: "SCN-001",
      name: "加急到货",
      horizonDays: 120,
      extraInboundQty: 500,
      extraInboundDate: "2026-08-10",
      idempotencyKey: "64b33021-65e9-4d6f-8756-e0def71dcff0",
    };
    const first = await saveProjectionScenario(pmc, payload, db);
    const replay = await saveProjectionScenario(pmc, { ...payload, name: "不得覆盖" }, db);
    expect(replay.id).toBe(first.id);
    expect(replay.name).toBe("加急到货");
    expect(first.baseline.points).toHaveLength(120);
    expect(first.scenario.points).toHaveLength(120);
    expect(first.scenario.points).not.toEqual(first.baseline.points);
    expect(first.inputs).toMatchObject({ extraInboundQty: 500, extraInboundDate: "2026-08-10" });

    const [stored] = await db.select().from(projectionScenarios).where(eq(projectionScenarios.id, first.id));
    expect(stored.name).toBe("加急到货");
    const [scenarioCount] = await db.select({ value: count() }).from(projectionScenarios);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "projection_scenario"));
    expect(Number(scenarioCount.value)).toBe(1);
    expect(audits).toHaveLength(1);
    await expect(
      db.execute(sql`update projection_scenarios set name = '篡改' where id = ${first.id}`),
    ).rejects.toThrow();
    const [unchanged] = await db
      .select({ name: projectionScenarios.name })
      .from(projectionScenarios)
      .where(eq(projectionScenarios.id, first.id));
    expect(unchanged.name).toBe("加急到货");
  });

  it("allows authenticated readers but only PMC/admin can save, and rejects incomplete scenarios", async () => {
    expect(await listProjectionScenarios("SCN-001", db)).toHaveLength(1);
    await expect(saveProjectionScenario(purchasing, {
      sku: "SCN-001",
      name: "越权",
      dailyOverride: 20,
      idempotencyKey: "05ccff13-b387-4247-906f-8315230fa546",
    }, db)).rejects.toMatchObject({ status: 403 });
    await expect(saveProjectionScenario(pmc, {
      sku: "SCN-001",
      name: "缺日期",
      extraInboundQty: 20,
      idempotencyKey: "8b0a3516-a3ea-487b-9ed2-505f88db4e87",
    }, db)).rejects.toBeTruthy();
    expect(warehouse.roles).toEqual(["warehouse"]);
  });
});
