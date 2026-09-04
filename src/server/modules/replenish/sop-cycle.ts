import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "@/server/modules/outsource/common";

export const SOP_ROLES = ["ops", "pmc", "finance"] as const;
export type SopRole = (typeof SOP_ROLES)[number];
export type SopStatus = "consensus" | "frozen" | "executing" | "closed";
export type SopDecisionValue = "agree" | "reject";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份格式须为 YYYY-MM");

export const createSopCycleSchema = z.object({
  month: monthSchema,
  name: z.string().trim().min(2).max(100),
  planningVersionId: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
});

export const changeSopPlanSchema = z.object({
  cycleId: z.number().int().positive(),
  version: z.number().int().positive(),
  planningVersionId: z.number().int().positive(),
});

export const decideSopCycleSchema = z.object({
  cycleId: z.number().int().positive(),
  version: z.number().int().positive(),
  role: z.enum(SOP_ROLES),
  decision: z.enum(["agree", "reject"]),
  note: z.string().trim().max(500).nullable().optional(),
});

export const transitionSopCycleSchema = z.object({
  cycleId: z.number().int().positive(),
  version: z.number().int().positive(),
  target: z.enum(["frozen", "executing", "closed"]),
});

interface VersionSummary {
  id: number;
  name: string;
  weekStart: string;
  digest: string;
  lineCount: number;
  suggestedCount: number;
  suppressedCount: number;
  createdAt: Date;
}

export interface SopDecision {
  id: number;
  cycleVersion: number;
  role: SopRole;
  decision: SopDecisionValue;
  note: string | null;
  planDigest: string;
  decidedBy: number;
  decidedByName: string | null;
  decidedAt: Date;
  current: boolean;
}

export interface SopCycle {
  id: number;
  month: string;
  name: string;
  status: SopStatus;
  planningVersionId: number;
  planDigest: string;
  version: number;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
  frozenAt: Date | null;
  executingAt: Date | null;
  closedAt: Date | null;
  plan: VersionSummary;
  decisions: SopDecision[];
  currentDecisions: Partial<Record<SopRole, SopDecision>>;
  consensusReady: boolean;
}

/**
 * 「当月实时建议是否已被冻结锁死」——与 `assertLiveSuggestionsWritable` 同源判定。
 * 界面必须**提前**知道：此前补货页不问，用户勾满 200 行、点提交才吃 409，
 * 一次白干（还容易被误读成系统故障）。
 */
export interface LiveSuggestionsFreeze {
  frozen: boolean;
  /** 冻结当月建议的周期（frozen/executing）；未冻结 = null */
  cycle: { id: number; month: string; name: string; status: SopStatus } | null;
  /** 判定所用的上海当月（YYYY-MM） */
  month: string;
}

export interface SopWorkspace {
  cycles: SopCycle[];
  versions: VersionSummary[];
  /** 当月实时建议冻结状态（补货页开屏横幅据此渲染） */
  liveSuggestionsFreeze: LiveSuggestionsFreeze;
  limitations: string[];
}

function currentShanghaiMonth(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(now).slice(0, 7);
}

function databaseErrorCode(error: unknown): string | undefined {
  const value = error as { code?: string; cause?: { code?: string } };
  return value.code ?? value.cause?.code;
}

async function getVersion(id: number, db: AnyDb): Promise<VersionSummary> {
  const [row] = await db
    .select({
      id: schema.planningVersions.id,
      name: schema.planningVersions.name,
      weekStart: schema.planningVersions.weekStart,
      digest: schema.planningVersions.digest,
      lineCount: schema.planningVersions.lineCount,
      suggestedCount: schema.planningVersions.suggestedCount,
      suppressedCount: schema.planningVersions.suppressedCount,
      createdAt: schema.planningVersions.createdAt,
    })
    .from(schema.planningVersions)
    .where(eq(schema.planningVersions.id, id));
  if (!row) throw new ApiError(404, "计划版本不存在");
  return row;
}

async function lockCycle(cycleId: number, db: AnyDb) {
  await db.execute(sql`SELECT id FROM sop_cycles WHERE id = ${cycleId} FOR UPDATE`);
  const [cycle] = await db
    .select()
    .from(schema.sopCycles)
    .where(eq(schema.sopCycles.id, cycleId));
  if (!cycle) throw new ApiError(404, "S&OP 周期不存在");
  return cycle;
}

async function currentDecisions(cycleId: number, version: number, db: AnyDb) {
  const rows = await db
    .select({
      id: schema.sopDecisions.id,
      cycleVersion: schema.sopDecisions.cycleVersion,
      role: schema.sopDecisions.role,
      decision: schema.sopDecisions.decision,
      note: schema.sopDecisions.note,
      planDigest: schema.sopDecisions.planDigest,
      decidedBy: schema.sopDecisions.decidedBy,
      decidedByName: schema.users.name,
      decidedAt: schema.sopDecisions.decidedAt,
    })
    .from(schema.sopDecisions)
    .leftJoin(schema.users, eq(schema.sopDecisions.decidedBy, schema.users.id))
    .where(and(
      eq(schema.sopDecisions.cycleId, cycleId),
      eq(schema.sopDecisions.cycleVersion, version),
    ))
    .orderBy(desc(schema.sopDecisions.id));
  const latest: Partial<Record<SopRole, SopDecision>> = {};
  for (const row of rows) {
    const role = row.role as SopRole;
    if (!latest[role]) {
      latest[role] = {
        ...row,
        role,
        decision: row.decision as SopDecisionValue,
        current: true,
      };
    }
  }
  return { rows, latest };
}

export async function getSopWorkspace(user: SessionUser, dbArg?: AnyDb): Promise<SopWorkspace> {
  requireAnyRole(user, "pmc", "purchasing", "ops", "finance");
  const db = await resolveDb(dbArg);
  const [versions, cycleRows] = await Promise.all([
    db
      .select({
        id: schema.planningVersions.id,
        name: schema.planningVersions.name,
        weekStart: schema.planningVersions.weekStart,
        digest: schema.planningVersions.digest,
        lineCount: schema.planningVersions.lineCount,
        suggestedCount: schema.planningVersions.suggestedCount,
        suppressedCount: schema.planningVersions.suppressedCount,
        createdAt: schema.planningVersions.createdAt,
      })
      .from(schema.planningVersions)
      .orderBy(desc(schema.planningVersions.createdAt), desc(schema.planningVersions.id))
      .limit(52),
    db
      .select()
      .from(schema.sopCycles)
      .orderBy(desc(schema.sopCycles.month), desc(schema.sopCycles.id))
      .limit(24),
  ]);
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const cycles: SopCycle[] = [];
  for (const row of cycleRows) {
    const plan = versionById.get(row.planningVersionId) ?? await getVersion(row.planningVersionId, db);
    const decisionRows = await db
      .select({
        id: schema.sopDecisions.id,
        cycleVersion: schema.sopDecisions.cycleVersion,
        role: schema.sopDecisions.role,
        decision: schema.sopDecisions.decision,
        note: schema.sopDecisions.note,
        planDigest: schema.sopDecisions.planDigest,
        decidedBy: schema.sopDecisions.decidedBy,
        decidedByName: schema.users.name,
        decidedAt: schema.sopDecisions.decidedAt,
      })
      .from(schema.sopDecisions)
      .leftJoin(schema.users, eq(schema.sopDecisions.decidedBy, schema.users.id))
      .where(eq(schema.sopDecisions.cycleId, row.id))
      .orderBy(desc(schema.sopDecisions.id));
    const latest: Partial<Record<SopRole, SopDecision>> = {};
    const decisions: SopDecision[] = decisionRows.map((decision) => {
      const role = decision.role as SopRole;
      const current = decision.cycleVersion === row.version && !latest[role];
      const value: SopDecision = {
        ...decision,
        role,
        decision: decision.decision as SopDecisionValue,
        current: Boolean(current),
      };
      if (current) latest[role] = value;
      return value;
    });
    const consensusReady = SOP_ROLES.every((role) =>
      latest[role]?.decision === "agree" && latest[role]?.planDigest === row.planDigest);
    cycles.push({
      ...row,
      status: row.status as SopStatus,
      plan,
      decisions,
      currentDecisions: latest,
      consensusReady,
    });
  }
  return {
    cycles,
    versions,
    liveSuggestionsFreeze: await getLiveSuggestionsFreeze(db),
    limitations: [
      "当前周期治理数量计划与跨职能共识；尚无已裁决成本/资金事实，因此不冒充财务 IBP。",
      "冻结引用不可变计划版本；历史不会按今天的库存、销量或参数回算。",
      "自动化只冻结建议证据，不自动审批或下单；执行仍走现有 BH/采购人工审批链。",
    ],
  };
}

export async function createSopCycle(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<SopCycle> {
  requireAnyRole(user, "pmc");
  const value = createSopCycleSchema.parse(input);
  const db = await resolveDb(dbArg);
  const existingByKey = await db
    .select({ id: schema.sopCycles.id })
    .from(schema.sopCycles)
    .where(eq(schema.sopCycles.idempotencyKey, value.idempotencyKey));
  if (existingByKey[0]) {
    const workspace = await getSopWorkspace(user, db);
    return workspace.cycles.find((cycle) => cycle.id === existingByKey[0].id)!;
  }
  const plan = await getVersion(value.planningVersionId, db);
  let id = 0;
  try {
    await db.transaction(async (tx: AnyDb) => {
      const [created] = await tx
        .insert(schema.sopCycles)
        .values({
          ...value,
          planDigest: plan.digest,
          createdBy: user.id,
        })
        .returning({ id: schema.sopCycles.id });
      id = created.id;
      await writeAudit(tx, {
        userId: user.id,
        entity: "sop_cycle",
        entityId: id,
        action: "create",
        after: { month: value.month, name: value.name, planningVersionId: plan.id, planDigest: plan.digest },
      });
    });
  } catch (error) {
    if (databaseErrorCode(error) === "23505") {
      const [replay] = await db
        .select({ id: schema.sopCycles.id })
        .from(schema.sopCycles)
        .where(eq(schema.sopCycles.idempotencyKey, value.idempotencyKey));
      if (replay) {
        const workspace = await getSopWorkspace(user, db);
        return workspace.cycles.find((cycle) => cycle.id === replay.id)!;
      }
      throw new ApiError(409, "该月份已有 S&OP 周期");
    }
    throw error;
  }
  const workspace = await getSopWorkspace(user, db);
  return workspace.cycles.find((cycle) => cycle.id === id)!;
}

export async function changeSopPlan(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<void> {
  requireAnyRole(user, "pmc");
  const value = changeSopPlanSchema.parse(input);
  const db = await resolveDb(dbArg);
  const plan = await getVersion(value.planningVersionId, db);
  await db.transaction(async (tx: AnyDb) => {
    const cycle = await lockCycle(value.cycleId, tx);
    if (cycle.status !== "consensus") throw new ApiError(409, "只有共识阶段可以更换源计划");
    if (cycle.version !== value.version) throw new ApiError(409, `版本冲突：当前共识轮次 ${cycle.version}`);
    if (cycle.planningVersionId === plan.id) throw new ApiError(400, "请选择不同的计划版本");
    const [updated] = await tx
      .update(schema.sopCycles)
      .set({
        planningVersionId: plan.id,
        planDigest: plan.digest,
        version: sql`${schema.sopCycles.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.sopCycles.id, cycle.id),
        eq(schema.sopCycles.status, "consensus"),
        eq(schema.sopCycles.version, value.version),
      ))
      .returning({ id: schema.sopCycles.id });
    if (!updated) throw new ApiError(409, "S&OP 周期已被其他用户更新");
    await writeAudit(tx, {
      userId: user.id,
      entity: "sop_cycle",
      entityId: cycle.id,
      action: "change_plan",
      before: { planningVersionId: cycle.planningVersionId, planDigest: cycle.planDigest, version: cycle.version },
      after: { planningVersionId: plan.id, planDigest: plan.digest, version: cycle.version + 1 },
    });
  });
}

export async function decideSopCycle(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<void> {
  const value = decideSopCycleSchema.parse(input);
  if (!user.roles.includes(value.role)) {
    throw new ApiError(403, "签认必须由实际持有该业务角色的用户本人完成，管理员不能代签");
  }
  const note = value.note?.trim() || null;
  if (value.decision === "reject" && (note?.length ?? 0) < 5) {
    throw new ApiError(400, "拒绝共识须填写至少 5 个字符的原因");
  }
  const db = await resolveDb(dbArg);
  await db.transaction(async (tx: AnyDb) => {
    const cycle = await lockCycle(value.cycleId, tx);
    if (cycle.status !== "consensus") throw new ApiError(409, "当前周期已退出共识阶段，不能再签认");
    if (cycle.version !== value.version) throw new ApiError(409, `共识轮次已变化：当前第 ${cycle.version} 轮`);
    const [decision] = await tx
      .insert(schema.sopDecisions)
      .values({
        cycleId: cycle.id,
        cycleVersion: cycle.version,
        role: value.role,
        decision: value.decision,
        note,
        planDigest: cycle.planDigest,
        decidedBy: user.id,
      })
      .returning({ id: schema.sopDecisions.id });
    await writeAudit(tx, {
      userId: user.id,
      entity: "sop_decision",
      entityId: decision.id,
      action: value.decision,
      after: {
        cycleId: cycle.id,
        cycleVersion: cycle.version,
        role: value.role,
        note,
        planDigest: cycle.planDigest,
      },
    });
  });
}

export async function transitionSopCycle(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<void> {
  requireAnyRole(user, "pmc");
  const value = transitionSopCycleSchema.parse(input);
  const db = await resolveDb(dbArg);
  await db.transaction(async (tx: AnyDb) => {
    const cycle = await lockCycle(value.cycleId, tx);
    if (cycle.version !== value.version) throw new ApiError(409, `版本冲突：当前共识轮次 ${cycle.version}`);
    const expected: Record<typeof value.target, SopStatus> = {
      frozen: "consensus",
      executing: "frozen",
      closed: "executing",
    };
    if (cycle.status !== expected[value.target]) {
      throw new ApiError(409, `不能从 ${cycle.status} 直接进入 ${value.target}`);
    }
    const now = new Date();
    if (value.target === "frozen") {
      const plan = await getVersion(cycle.planningVersionId, tx);
      if (plan.digest !== cycle.planDigest) throw new ApiError(409, "源计划摘要不一致，禁止冻结");
      const { latest } = await currentDecisions(cycle.id, cycle.version, tx);
      const missing = SOP_ROLES.filter((role) =>
        latest[role]?.decision !== "agree" || latest[role]?.planDigest !== cycle.planDigest);
      if (missing.length > 0) throw new ApiError(409, `尚未达成三方共识：${missing.join("、")}`);
    }
    const lifecycle = value.target === "frozen"
      ? { status: "frozen", frozenBy: user.id, frozenAt: now }
      : value.target === "executing"
        ? { status: "executing", executingBy: user.id, executingAt: now }
        : { status: "closed", closedBy: user.id, closedAt: now };
    const [updated] = await tx
      .update(schema.sopCycles)
      .set({ ...lifecycle, updatedAt: now })
      .where(and(
        eq(schema.sopCycles.id, cycle.id),
        eq(schema.sopCycles.status, cycle.status),
        eq(schema.sopCycles.version, cycle.version),
      ))
      .returning({ id: schema.sopCycles.id });
    if (!updated) throw new ApiError(409, "S&OP 周期已被其他用户更新");
    await writeAudit(tx, {
      userId: user.id,
      entity: "sop_cycle",
      entityId: cycle.id,
      action: value.target,
      before: { status: cycle.status, version: cycle.version },
      after: { status: value.target, version: cycle.version, planDigest: cycle.planDigest },
    });
  });
}

/** 冻结当月实时建议的周期（frozen/executing）——闸门与界面横幅**同一个查询**，不许各判一次 */
export async function getLiveSuggestionsFreeze(dbArg?: AnyDb, now = new Date()): Promise<LiveSuggestionsFreeze> {
  const db = await resolveDb(dbArg);
  const month = currentShanghaiMonth(now);
  const [active] = await db
    .select({
      id: schema.sopCycles.id,
      month: schema.sopCycles.month,
      name: schema.sopCycles.name,
      status: schema.sopCycles.status,
    })
    .from(schema.sopCycles)
    .where(and(
      eq(schema.sopCycles.month, month),
      inArray(schema.sopCycles.status, ["frozen", "executing"]),
    ));
  return {
    frozen: Boolean(active),
    cycle: active ? { ...active, status: active.status as SopStatus } : null,
    month,
  };
}

/** 冻结/执行中的当月周期只能读取冻结版本；禁止从实时重算建议绕过共识生成草稿。 */
export async function assertLiveSuggestionsWritable(dbArg?: AnyDb, now = new Date()): Promise<void> {
  const freeze = await getLiveSuggestionsFreeze(dbArg, now);
  if (freeze.frozen) {
    throw new ApiError(409, "当月 S&OP 计划已冻结；实时建议只读，请按冻结计划版本执行");
  }
}
