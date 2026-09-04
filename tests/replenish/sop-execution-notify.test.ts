/**
 * W2-#4 冻结的 S&OP 计划必须有执行通道；W2-#5 三方共识流程必须会说话。
 *
 * 事故形状（两条同源，都是"闸门有了、通路没有"）：
 *  #4 `assertLiveSuggestionsWritable` 让冻结期的实时建议 409，但冻结的那个版本**没有任何出口**——
 *     于是执行发生在系统外（微信/电话/手工表），冻结计划变成一张与执行无关的纸；
 *     409 的文案也只说"只读"，不告诉人该去哪。
 *  #5 整条三方共识流程**一次通知都没有**：周期停在"等财务签认"，财务根本不知道有这件事。
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  assertLiveSuggestionsWritable,
  createSopCycle,
  decideSopCycle,
  executeFrozenPlan,
  getFrozenPlanExecution,
  transitionSopCycle,
} from "@/server/modules/replenish/sop-cycle";
import { createReplenishDraft } from "@/server/modules/replenish/service";
import { createTestDb, type TestDb } from "../helpers/db";

const MONTH = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
  .format(new Date())
  .slice(0, 7);

async function seed(db: TestDb) {
  const people = await db.insert(schema.users).values([
    { name: "SOP-PMC", roles: ["pmc"] },
    { name: "SOP-运营", roles: ["ops"] },
    { name: "SOP-财务", roles: ["finance"] },
  ]).returning();
  const pmc: SessionUser = { id: people[0].id, name: people[0].name, roles: ["pmc"], isApprover: false };
  const ops: SessionUser = { id: people[1].id, name: people[1].name, roles: ["ops"], isApprover: false };
  const finance: SessionUser = { id: people[2].id, name: people[2].name, roles: ["finance"], isApprover: false };

  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
  const skus = await db.insert(schema.skus).values([
    { code: "CP00001", name: "面霜", spuId: spu.id, skuType: "finished", baseUom: "支" },
    { code: "CP00002", name: "水乳", spuId: spu.id, skuType: "finished", baseUom: "支" },
  ]).returning();

  const [plan] = await db.insert(schema.planningVersions).values({
    name: `${MONTH} 冻结基线`,
    weekStart: "2026-09-01",
    engineVersion: "test",
    parameters: {},
    sourceMeta: {},
    lineCount: 2,
    suggestedCount: 1,
    suppressedCount: 1,
    digest: "a".repeat(64),
    idempotencyKey: "sop-exec-plan",
    createdBy: pmc.id,
  }).returning();
  await db.insert(schema.planningVersionLines).values([
    {
      versionId: plan.id, skuId: skus[0].id, skuCode: "CP00001", skuName: "面霜", baseUom: "支",
      suggestedQty: "1200.0000", suppressed: false, shortageDate: "2026-10-10", orderByDate: "2026-09-10",
      orderWindowMissed: false, onHand: "100.0000", inTransit: "0.0000", daily: "10.0000", safetyQty: "50.0000",
      leadDays: 30, explanation: [],
    },
    {
      versionId: plan.id, skuId: skus[1].id, skuCode: "CP00002", skuName: "水乳", baseUom: "支",
      suggestedQty: "800.0000", suppressed: true, shortageDate: "2026-10-20", orderByDate: "2026-09-20",
      orderWindowMissed: false, onHand: "50.0000", inTransit: "0.0000", daily: "8.0000", safetyQty: "40.0000",
      leadDays: 30, explanation: [],
    },
  ]);
  return { pmc, ops, finance, plan, skus };
}

async function freeze(db: TestDb, people: { pmc: SessionUser; ops: SessionUser; finance: SessionUser }, planId: number) {
  const cycle = await createSopCycle(people.pmc, {
    month: MONTH, name: `${MONTH} 数量供需计划`, planningVersionId: planId, idempotencyKey: crypto.randomUUID(),
  }, db);
  for (const [role, user] of [["ops", people.ops], ["pmc", people.pmc], ["finance", people.finance]] as const) {
    await decideSopCycle(user, { cycleId: cycle.id, version: cycle.version, role, decision: "agree" }, db);
  }
  await transitionSopCycle(people.pmc, { cycleId: cycle.id, version: cycle.version, target: "frozen" }, db);
  return cycle;
}

describe("冻结计划的执行通道（W2-#4）", () => {
  it("冻结后实时建议 409，且报错直接指向替代路径", async () => {
    const { db, client } = await createTestDb();
    try {
      const { pmc, ops, finance, plan, skus } = await seed(db);
      await freeze(db, { pmc, ops, finance }, plan.id);

      await expect(assertLiveSuggestionsWritable(db)).rejects.toMatchObject({ status: 409 });
      await expect(assertLiveSuggestionsWritable(db)).rejects.toThrow(/按冻结计划开单/);
      await expect(createReplenishDraft(pmc, { items: [{ skuId: skus[0].id, qty: "10" }] }, db))
        .rejects.toThrow(/S&OP 计划周期/);
    } finally {
      await client.close();
    }
  });

  it("冻结版本的行可以直接开成 BH 草稿：数量取冻结值、抑制行默认不开、审计可回溯到周期", async () => {
    const { db, client } = await createTestDb();
    try {
      const { pmc, ops, finance, plan, skus } = await seed(db);
      const cycle = await freeze(db, { pmc, ops, finance }, plan.id);

      const view = await getFrozenPlanExecution(pmc, cycle.id, db);
      expect(view.cycle.status).toBe("frozen");
      expect(view.lines.map((l) => l.skuCode)).toEqual(["CP00001", "CP00002"]); // 按最晚下单日排序
      expect(view.drafts).toHaveLength(0);

      const draft = await executeFrozenPlan(pmc, { cycleId: cycle.id, idempotencyKey: crypto.randomUUID() }, db);
      expect(draft.lineCount, "被抑制的行默认不开——那部分要人工核实过才放行").toBe(1);
      expect(draft.docNo).toMatch(/^BH/);

      const [bhLine] = await db.select().from(schema.bhLines).where(eq(schema.bhLines.bhId, draft.id));
      expect(bhLine.skuId).toBe(skus[0].id);
      expect(bhLine.qty, "数量必须来自冻结版本，绝不回算实时建议").toBe("1200.0000");

      const [audit] = await db.select().from(schema.auditLogs).where(and(
        eq(schema.auditLogs.entity, "sop_cycle"),
        eq(schema.auditLogs.action, "execute_draft"),
      ));
      expect(audit.entityId).toBe(cycle.id);
      expect((audit.after as { planDigest?: string }).planDigest).toBe("a".repeat(64));

      const after = await getFrozenPlanExecution(pmc, cycle.id, db);
      expect(after.drafts).toHaveLength(1);
      expect(after.lines.find((l) => l.skuCode === "CP00001")!.drafted).toBe(true);

      // 显式放行被抑制的行
      const held = await executeFrozenPlan(pmc, { cycleId: cycle.id, idempotencyKey: crypto.randomUUID(), skuIds: [skus[1].id], includeSuppressed: true }, db);
      expect(held.lineCount).toBe(1);
      await expect(executeFrozenPlan(pmc, { cycleId: cycle.id, idempotencyKey: crypto.randomUUID(), skuIds: [skus[1].id] }, db))
        .rejects.toMatchObject({ status: 400 });
    } finally {
      await client.close();
    }
  });

  it("共识阶段的周期没有执行通道（不能绕过共识开单）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { pmc, plan } = await seed(db);
      const cycle = await createSopCycle(pmc, {
        month: MONTH, name: "未冻结周期", planningVersionId: plan.id, idempotencyKey: crypto.randomUUID(),
      }, db);
      await expect(getFrozenPlanExecution(pmc, cycle.id, db)).rejects.toMatchObject({ status: 409 });
      await expect(executeFrozenPlan(pmc, { cycleId: cycle.id, idempotencyKey: crypto.randomUUID() }, db)).rejects.toMatchObject({ status: 409 });
    } finally {
      await client.close();
    }
  });
});

describe("三方共识的通知（W2-#5）", () => {
  it("建周期即通知三方待签；同意后只叫还没签的人；驳回通知发起人并带原因；冻结通知全体", async () => {
    const { db, client } = await createTestDb();
    try {
      const { pmc, ops, finance, plan } = await seed(db);
      const cycle = await createSopCycle(pmc, {
        month: MONTH, name: `${MONTH} 数量供需计划`, planningVersionId: plan.id, idempotencyKey: crypto.randomUUID(),
      }, db);

      const notes = async () => db.select().from(schema.notifications);
      const created = await notes();
      expect(created.map((n) => n.targetRole).sort(), "一开就得让三方知道").toEqual(["finance", "ops", "pmc"]);
      expect(created.every((n) => n.dedupeKey?.includes(`:v${cycle.version}:await:`))).toBe(true);
      expect(created[0].href).toBe("/replenish/sop");

      // 运营同意：只该再叫还没签的两个角色，且已发过的 await 键不重复入队
      await decideSopCycle(ops, { cycleId: cycle.id, version: cycle.version, role: "ops", decision: "agree" }, db);
      expect(await notes().then((n) => n.length), "去重键幂等：同一轮同一角色不重复推送").toBe(3);

      // 财务驳回：通知发起人，且必须带上原因
      await decideSopCycle(finance, {
        cycleId: cycle.id, version: cycle.version, role: "finance", decision: "reject", note: "资金排期不支持该量级",
      }, db);
      const rejects = (await notes()).filter((n) => n.dedupeKey?.includes(":reject:"));
      expect(rejects).toHaveLength(1);
      expect(rejects[0].userId, "驳回要通知周期发起人——他是唯一有义务改计划的人").toBe(pmc.id);
      expect(rejects[0].body).toContain("资金排期不支持该量级");
      expect(rejects[0].severity).toBe("high");

      // 三方同意后冻结：全体收到，并被告知替代执行路径
      await decideSopCycle(finance, { cycleId: cycle.id, version: cycle.version, role: "finance", decision: "agree" }, db);
      await decideSopCycle(pmc, { cycleId: cycle.id, version: cycle.version, role: "pmc", decision: "agree" }, db);
      await transitionSopCycle(pmc, { cycleId: cycle.id, version: cycle.version, target: "frozen" }, db);
      const frozen = (await notes()).filter((n) => n.dedupeKey?.includes(":frozen:"));
      expect(frozen.map((n) => n.targetRole).sort()).toEqual(["finance", "ops", "pmc"]);
      expect(frozen[0].body).toContain("按冻结计划开单");
    } finally {
      await client.close();
    }
  });
});
