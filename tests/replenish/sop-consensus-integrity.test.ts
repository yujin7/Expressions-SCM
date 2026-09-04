/**
 * S&OP 三方共识与执行通道的完整性（2026-09-04 安全审计 S1 / S2 / S7）。
 *
 * 三个此前都成立的攻击/事故路径：
 *  S1 一个人可以独自达成「三方共识」。`decideSopCycle` 拒绝管理员代签，但共识判定只看
 *     「每个角色最新决定是 agree 且摘要一致」，从没要求签认人互不相同；而角色是叠加的，
 *     一个同时挂 pmc/ops/finance 的账号（小组织的常见配置）能自己签满三个角色并冻结当月——
 *     冻结之后全系统实时补货建议转只读，所有下单都改走他冻结的那个版本。
 *  S2 `executeFrozenPlan` 的审计写在 createBh 的事务**之外**，而执行页的「本行已开过单」
 *     正是靠读那条审计算出来的：审计写失败 → BH 已经建成、页面却显示未开单 → 同样的量再开一张。
 *     并且没有幂等键，双击就是两张内容相同的草稿一起进审批链。
 *  S7 驳回可以无限重复：状态与轮次都不变，去重键里却带着自增的 decision.id，
 *     于是每点一次就多一条决定、一条审计和一条 severity=high 的新通知给发起人（配了飞书就是一条飞书消息）。
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";

vi.mock("@/server/core/audit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/core/audit")>();
  return {
    ...original,
    writeAudit: vi.fn((db: unknown, entry: { entity: string; action: string }) => {
      // 只让「按冻结计划开单」那一条审计可控地失败，其余（含 createBh 自己的 create）照常
      if (failExecuteAudit && entry.entity === "sop_cycle" && entry.action === "execute_draft") {
        throw new Error("审计库写失败（模拟）");
      }
      return original.writeAudit(db as never, entry as never);
    }),
  };
});
let failExecuteAudit = false;

const {
  createSopCycle,
  decideSopCycle,
  executeFrozenPlan,
  getFrozenPlanExecution,
  getSopWorkspace,
  transitionSopCycle,
} = await import("@/server/modules/replenish/sop-cycle");
const { createTestDb } = await import("../helpers/db");
type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

const MONTH = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
  .format(new Date())
  .slice(0, 7);

const DIGEST = "b".repeat(64);

async function seed(db: TestDb) {
  const people = await db.insert(schema.users).values([
    // 现实里完全可能出现的一个人：小组织里计划、运营、财务三顶帽子都戴
    { name: "全能选手", roles: ["pmc", "ops", "finance"] },
    { name: "运营甲", roles: ["ops"] },
    { name: "财务乙", roles: ["finance"] },
  ]).returning();
  const omni: SessionUser = { id: people[0].id, name: people[0].name, roles: ["pmc", "ops", "finance"], isApprover: false };
  const ops: SessionUser = { id: people[1].id, name: people[1].name, roles: ["ops"], isApprover: false };
  const finance: SessionUser = { id: people[2].id, name: people[2].name, roles: ["finance"], isApprover: false };

  const [spu] = await db.insert(schema.spus).values({ code: "SP1", nameCn: "测试" }).returning();
  const skus = await db.insert(schema.skus).values([
    { code: "CP10001", name: "面霜", spuId: spu.id, skuType: "finished", baseUom: "支" },
    { code: "CP10002", name: "水乳", spuId: spu.id, skuType: "finished", baseUom: "支" },
  ]).returning();
  const [plan] = await db.insert(schema.planningVersions).values({
    name: `${MONTH} 基线`, weekStart: "2026-09-01", engineVersion: "test",
    parameters: {}, sourceMeta: {}, lineCount: 2, suggestedCount: 2, suppressedCount: 0,
    digest: DIGEST, idempotencyKey: `sop-int-${crypto.randomUUID()}`, createdBy: omni.id,
  }).returning();
  await db.insert(schema.planningVersionLines).values([
    {
      versionId: plan.id, skuId: skus[0].id, skuCode: "CP10001", skuName: "面霜", baseUom: "支",
      suggestedQty: "600.0000", suppressed: false, shortageDate: "2026-10-10", orderByDate: "2026-09-10",
      orderWindowMissed: false, onHand: "10.0000", inTransit: "0.0000", daily: "5.0000", safetyQty: "20.0000",
      leadDays: 30, explanation: [],
    },
    {
      versionId: plan.id, skuId: skus[1].id, skuCode: "CP10002", skuName: "水乳", baseUom: "支",
      suggestedQty: "400.0000", suppressed: false, shortageDate: "2026-10-20", orderByDate: "2026-09-20",
      orderWindowMissed: false, onHand: "10.0000", inTransit: "0.0000", daily: "4.0000", safetyQty: "20.0000",
      leadDays: 30, explanation: [],
    },
  ]);
  return { omni, ops, finance, plan, skus };
}

const newCycle = (db: TestDb, user: SessionUser, planId: number) =>
  createSopCycle(user, {
    month: MONTH, name: `${MONTH} 数量供需计划`, planningVersionId: planId, idempotencyKey: crypto.randomUUID(),
  }, db);

describe("S1：三方共识必须是三个人", () => {
  it("一人身兼三角时，签完第一个角色就不能再签第二个（明说原因，不是静默接受）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { omni, plan } = await seed(db);
      const cycle = await newCycle(db, omni, plan.id);

      await decideSopCycle(omni, { cycleId: cycle.id, version: cycle.version, role: "pmc", decision: "agree" }, db);
      await expect(
        decideSopCycle(omni, { cycleId: cycle.id, version: cycle.version, role: "ops", decision: "agree" }, db),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        decideSopCycle(omni, { cycleId: cycle.id, version: cycle.version, role: "ops", decision: "agree" }, db),
      ).rejects.toThrow(/三个不同的人/);
      // 同角色重复签也拦（本轮没有新信息）
      await expect(
        decideSopCycle(omni, { cycleId: cycle.id, version: cycle.version, role: "pmc", decision: "agree" }, db),
      ).rejects.toThrow(/无需重复签认/);

      const rows = await db.select().from(schema.sopDecisions);
      expect(rows, "被拒的签认不得留下决定行").toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("一个人签不满三个角色，冻结门自然过不去；换成三个人就能冻结", async () => {
    const { db, client } = await createTestDb();
    try {
      const { omni, ops, finance, plan } = await seed(db);
      const cycle = await newCycle(db, omni, plan.id);
      await decideSopCycle(omni, { cycleId: cycle.id, version: cycle.version, role: "pmc", decision: "agree" }, db);
      await expect(
        transitionSopCycle(omni, { cycleId: cycle.id, version: cycle.version, target: "frozen" }, db),
      ).rejects.toMatchObject({ status: 409 });

      await decideSopCycle(ops, { cycleId: cycle.id, version: cycle.version, role: "ops", decision: "agree" }, db);
      await decideSopCycle(finance, { cycleId: cycle.id, version: cycle.version, role: "finance", decision: "agree" }, db);
      const ws = await getSopWorkspace(omni, db);
      expect(ws.cycles.find((c) => c.id === cycle.id)!.consensusReady, "三个不同的人签齐 = 可冻结").toBe(true);
      await transitionSopCycle(omni, { cycleId: cycle.id, version: cycle.version, target: "frozen" }, db);
      const [after] = await db.select().from(schema.sopCycles).where(eq(schema.sopCycles.id, cycle.id));
      expect(after.status).toBe("frozen");
    } finally {
      await client.close();
    }
  });

  it("护栏上线前签下的历史数据同样冻不了：冻结门自己再查一次签认人是否互不相同", async () => {
    const { db, client } = await createTestDb();
    try {
      const { omni, plan } = await seed(db);
      const cycle = await newCycle(db, omni, plan.id);
      /* 摘掉数据库背书，模拟「唯一索引存在之前落下的行」——三条 agree 全是同一个人签的。
         如果冻结门只信写路径上的那道闸，这些历史数据就能直接冻结当月。 */
      await client.exec('DROP INDEX "uq_sop_agree_one_per_signer"');
      for (const role of ["ops", "pmc", "finance"] as const) {
        await db.insert(schema.sopDecisions).values({
          cycleId: cycle.id, cycleVersion: cycle.version, role, decision: "agree",
          planDigest: DIGEST, decidedBy: omni.id,
        });
      }
      const ws = await getSopWorkspace(omni, db);
      expect(ws.cycles.find((c) => c.id === cycle.id)!.consensusReady, "界面也不得点亮冻结按钮").toBe(false);
      await expect(
        transitionSopCycle(omni, { cycleId: cycle.id, version: cycle.version, target: "frozen" }, db),
      ).rejects.toThrow(/三个不同的人/);
    } finally {
      await client.close();
    }
  });
});

describe("S7：驳回一轮一次，不是一个通知放大器", () => {
  it("同一轮同一角色第二次驳回被拒；决定/审计/通知都只有一条", async () => {
    const { db, client } = await createTestDb();
    try {
      const { omni, finance, plan } = await seed(db);
      const cycle = await newCycle(db, omni, plan.id);

      await decideSopCycle(finance, {
        cycleId: cycle.id, version: cycle.version, role: "finance", decision: "reject", note: "资金排期不支持",
      }, db);
      for (let i = 0; i < 3; i++) {
        await expect(decideSopCycle(finance, {
          cycleId: cycle.id, version: cycle.version, role: "finance", decision: "reject", note: "资金排期不支持",
        }, db)).rejects.toMatchObject({ status: 409 });
      }

      expect(await db.select().from(schema.sopDecisions)).toHaveLength(1);
      const audits = await db.select().from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.entity, "sop_decision"), eq(schema.auditLogs.action, "reject")));
      expect(audits).toHaveLength(1);
      const notes = (await db.select().from(schema.notifications))
        .filter((n) => n.dedupeKey?.includes(":reject:"));
      expect(notes, "一轮一个角色最多一条驳回通知").toHaveLength(1);
      expect(notes[0].dedupeKey, "去重键不得含自增 decision.id——那等于每次都换一个新键")
        .toBe(`sop:${cycle.id}:v${cycle.version}:reject:finance`);
    } finally {
      await client.close();
    }
  });

  it("对齐后本轮仍可改签同意（驳回幂等不是把角色钉死）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { omni, ops, finance, plan } = await seed(db);
      const cycle = await newCycle(db, omni, plan.id);
      await decideSopCycle(finance, {
        cycleId: cycle.id, version: cycle.version, role: "finance", decision: "reject", note: "先看一下资金",
      }, db);
      await decideSopCycle(finance, { cycleId: cycle.id, version: cycle.version, role: "finance", decision: "agree" }, db);
      await decideSopCycle(ops, { cycleId: cycle.id, version: cycle.version, role: "ops", decision: "agree" }, db);
      await decideSopCycle(omni, { cycleId: cycle.id, version: cycle.version, role: "pmc", decision: "agree" }, db);
      await transitionSopCycle(omni, { cycleId: cycle.id, version: cycle.version, target: "frozen" }, db);
      const [after] = await db.select().from(schema.sopCycles).where(eq(schema.sopCycles.id, cycle.id));
      expect(after.status).toBe("frozen");
    } finally {
      await client.close();
    }
  });
});

describe("S2：按冻结计划开单的写路径", () => {
  async function frozen(db: TestDb) {
    const { omni, ops, finance, plan, skus } = await seed(db);
    const cycle = await newCycle(db, omni, plan.id);
    await decideSopCycle(ops, { cycleId: cycle.id, version: cycle.version, role: "ops", decision: "agree" }, db);
    await decideSopCycle(finance, { cycleId: cycle.id, version: cycle.version, role: "finance", decision: "agree" }, db);
    await decideSopCycle(omni, { cycleId: cycle.id, version: cycle.version, role: "pmc", decision: "agree" }, db);
    await transitionSopCycle(omni, { cycleId: cycle.id, version: cycle.version, target: "frozen" }, db);
    return { omni, cycle, plan, skus };
  }

  it("幂等键：同一个键重放只得到同一张草稿（双击不再产生两张进审批链）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { omni, cycle } = await frozen(db);
      const key = crypto.randomUUID();
      const first = await executeFrozenPlan(omni, { cycleId: cycle.id, idempotencyKey: key }, db);
      const second = await executeFrozenPlan(omni, { cycleId: cycle.id, idempotencyKey: key }, db);
      expect(second).toEqual(first);
      expect(await db.select().from(schema.bhDocs), "一个幂等键只应有一张 BH").toHaveLength(1);
      expect(await db.select().from(schema.sopExecutionDrafts)).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("审计与 BH 同一事务：审计写失败即整单回滚，不留下一张没有出处的草稿", async () => {
    const { db, client } = await createTestDb();
    try {
      const { omni, cycle } = await frozen(db);
      failExecuteAudit = true;
      try {
        await expect(
          executeFrozenPlan(omni, { cycleId: cycle.id, idempotencyKey: crypto.randomUUID() }, db),
        ).rejects.toThrow(/审计库写失败/);
      } finally {
        failExecuteAudit = false;
      }
      expect(await db.select().from(schema.bhDocs), "审计失败必须连 BH 一起回滚").toHaveLength(0);
      expect(await db.select().from(schema.sopExecutionDrafts)).toHaveLength(0);
      expect(await db.select().from(schema.bhLines)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("「已开过单」读的是业务链接表，不是 audit_logs：伪造的审计行不影响判定", async () => {
    const { db, client } = await createTestDb();
    try {
      const { omni, cycle, plan, skus } = await frozen(db);
      // 一条形状完全正确、但没有对应 BH 的审计行——旧实现会据此把两行都标成「已开单」
      await db.insert(schema.auditLogs).values({
        userId: omni.id, entity: "sop_cycle", entityId: cycle.id, action: "execute_draft",
        after: { docNo: "BH-FAKE", bhId: 999_999, planningVersionId: plan.id, skuIds: [skus[0].id, skus[1].id] },
      });
      const view = await getFrozenPlanExecution(omni, cycle.id, db);
      expect(view.drafts, "执行页的已开单据只来自 sop_execution_drafts").toHaveLength(0);
      expect(view.lines.every((l) => !l.drafted), "没有任何一行该被标成已开单").toBe(true);

      await executeFrozenPlan(omni, {
        cycleId: cycle.id, idempotencyKey: crypto.randomUUID(), skuIds: [skus[0].id],
      }, db);
      const after = await getFrozenPlanExecution(omni, cycle.id, db);
      expect(after.drafts).toHaveLength(1);
      expect(after.lines.find((l) => l.skuId === skus[0].id)!.drafted).toBe(true);
      expect(after.lines.find((l) => l.skuId === skus[1].id)!.drafted, "没开的行不能被伪造审计带成已开").toBe(false);
    } finally {
      await client.close();
    }
  });
});
