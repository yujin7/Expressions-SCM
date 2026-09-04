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

/**
 * W2-#4 从冻结版本开单：勾选冻结计划里的行 → 生成 BH 备货申请草稿。
 *
 * 此前 `assertLiveSuggestionsWritable` 让实时建议在冻结期 409，但冻结的那个版本**没有任何出口**——
 * 于是执行发生在系统外（微信/电话/手工表），冻结计划变成一张与执行无关的纸。
 * 这里给出唯一的执行通道：数量只能来自冻结版本的行（不回算实时建议），
 * 人工闸与审计与实时路径完全一致（pmc 勾选 → BH 草稿 → 正常审批链）。
 */
export const executeFrozenPlanSchema = z.object({
  cycleId: z.number().int().positive(),
  /** 冻结版本里的行（planning_version_lines.sku_id）；缺省 = 全部有建议量的行 */
  skuIds: z.array(z.number().int().positive()).max(200, "一次最多 200 项").optional(),
  /** 是否连被抑制的行一起开（默认否——抑制的量要人工核实过才放行） */
  includeSuppressed: z.boolean().optional(),
  remark: z.string().trim().max(500).optional(),
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

/* ────────────────────── W2-#5 三方共识的通知 ────────────────────── */

/**
 * 事故形状：整条三方共识流程**一次 `enqueueNotification` 都没有**。
 * 周期停在「等财务签认」上，没有任何人被告知；发起人以为在推进，财务根本不知道有这件事。
 * 一个需要三个人依次动手的流程，没有通知就等于没有流程。
 *
 * 三个必发时刻（去重键含轮次 version：换源计划开新一轮 = 新的一次通知，不会被旧键吃掉）：
 *  - awaiting：轮到谁签就通知谁（targetRole，站内）；
 *  - rejected：通知**周期发起人**并带上驳回原因——没有原因的驳回等于沉默；
 *  - frozen：通知全部参与方（三个角色），冻结意味着他们的执行口径变了。
 *
 * 通知是尽力而为：失败绝不反噬业务写入（与 todo/service.notifyAssignee 同纪律）。
 * 动态 import `jobs/notify`：它值导入 workbench/focus 与 report/decision-studio，
 * 静态引用会把本模块拖进那张模块图（2026-09-04 的 `Cannot access 'X' before initialization` 就是这么来的）。
 */
async function notifySop(db: AnyDb, items: NotifyItem[]): Promise<void> {
  if (items.length === 0) return;
  try {
    const { enqueueNotification } = await import("@/jobs/notify");
    for (const n of items) {
      await enqueueNotification(db, {
        channel: "in_app",
        title: n.title,
        body: n.body,
        href: "/replenish/sop",
        severity: n.severity,
        dedupeKey: n.dedupeKey,
        userId: n.userId ?? null,
        targetRole: n.targetRole ?? null,
      });
    }
  } catch {
    // 通知失败不反噬业务
  }
}

interface NotifyItem {
  title: string;
  body: string;
  severity: "info" | "high";
  dedupeKey: string;
  userId?: number | null;
  targetRole?: SopRole | null;
}

const SOP_ROLE_LABELS: Record<SopRole, string> = { ops: "运营", pmc: "生产计划", finance: "财务" };

/** 尚未在本轮以当前摘要签「同意」的角色——待签名单与冻结门是同一个判定，不许各判一次。 */
function pendingRoles(latest: Partial<Record<SopRole, SopDecision>>, planDigest: string): SopRole[] {
  return SOP_ROLES.filter((role) => latest[role]?.decision !== "agree" || latest[role]?.planDigest !== planDigest);
}

function awaitingItems(cycle: { id: number; name: string; month: string; version: number }, roles: SopRole[]): NotifyItem[] {
  return roles.map((role) => ({
    title: `【S&OP 待签认】${cycle.name}`,
    body: `${cycle.month} 计划周期第 ${cycle.version} 轮共识等待「${SOP_ROLE_LABELS[role]}」签认。未签认前不能冻结，冻结后当月实时建议转为只读。`,
    severity: "info" as const,
    dedupeKey: `sop:${cycle.id}:v${cycle.version}:await:${role}`,
    targetRole: role,
  }));
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
  const created = workspace.cycles.find((cycle) => cycle.id === id)!;
  // W2-#5：新周期一开就得让三方知道要签认，否则它从第一天起就停在「等某个人」上
  await notifySop(db, awaitingItems(created, pendingRoles(created.currentDecisions, created.planDigest)));
  return created;
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
  let nextRound: { id: number; name: string; month: string; version: number } | null = null;
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
    nextRound = { id: cycle.id, name: cycle.name, month: cycle.month, version: cycle.version + 1 };
  });
  /* W2-#5：换源计划 = 新一轮共识，旧签认全部作废——三方必须重新被叫一次。
     去重键含轮次号，所以这次通知不会被上一轮的键吃掉。 */
  if (nextRound) await notifySop(db, awaitingItems(nextRound, [...SOP_ROLES]));
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
  let notify: NotifyItem[] = [];
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

    /* W2-#5 通知在事务内**装配**、事务外发送：
       驳回 → 通知周期发起人并带上原因（发起人是唯一有义务改计划的人）；
       同意 → 把还没签的角色再叫一次（"等财务"从此有人知道）。 */
    const meta = { id: cycle.id, name: cycle.name, month: cycle.month, version: cycle.version };
    if (value.decision === "reject") {
      notify = [{
        title: `【S&OP 共识被驳回】${cycle.name}`,
        body: `${SOP_ROLE_LABELS[value.role]}（${user.name}）驳回了 ${cycle.month} 第 ${cycle.version} 轮共识：${note ?? "（无原因）"}。请更换源计划或与该角色对齐后重开一轮。`,
        severity: "high",
        dedupeKey: `sop:${cycle.id}:v${cycle.version}:reject:${value.role}:${decision.id}`,
        userId: cycle.createdBy,
      }];
    } else {
      const { latest } = await currentDecisions(cycle.id, cycle.version, tx);
      notify = awaitingItems(meta, pendingRoles(latest, cycle.planDigest));
    }
  });
  await notifySop(db, notify);
}

export async function transitionSopCycle(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<void> {
  requireAnyRole(user, "pmc");
  const value = transitionSopCycleSchema.parse(input);
  const db = await resolveDb(dbArg);
  let notify: NotifyItem[] = [];
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

    /* W2-#5：冻结改变的是**所有参与方的执行口径**（当月实时建议转只读，执行改走冻结版本），
       所以三个角色都要收到，并且要直接告诉他们替代路径在哪——否则冻结只会让人以为系统坏了。 */
    if (value.target === "frozen") {
      notify = SOP_ROLES.map((role) => ({
        title: `【S&OP 计划已冻结】${cycle.name}`,
        body: `${cycle.month} 第 ${cycle.version} 轮三方共识达成，计划已冻结（版本 #${cycle.planningVersionId}）。当月实时补货建议转为只读；需要下单请在「S&OP 计划周期」页用「按冻结计划开单」生成 BH 草稿（仍走正常审批）。`,
        severity: "high" as const,
        dedupeKey: `sop:${cycle.id}:v${cycle.version}:frozen:${role}`,
        targetRole: role,
      }));
    }
  });
  await notifySop(db, notify);
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

/**
 * 冻结/执行中的当月周期只能读取冻结版本；禁止从实时重算建议绕过共识生成草稿。
 *
 * W2-#4：报错必须指出**替代路径**。此前只说「实时建议只读」，却没有任何地方能把冻结的那批需求提出来，
 * 于是执行整体挪到系统外（微信/电话/手工表）。现在冻结版本本身有执行通道，409 直接指过去。
 */
export async function assertLiveSuggestionsWritable(dbArg?: AnyDb, now = new Date()): Promise<void> {
  const freeze = await getLiveSuggestionsFreeze(dbArg, now);
  if (freeze.frozen) {
    throw new ApiError(
      409,
      `当月 S&OP 计划已冻结（${freeze.cycle?.name ?? freeze.month}），实时建议只读。`
      + `请到「S&OP 计划周期」页用冻结版本开单：勾选冻结计划中的行 →「按冻结计划开单」生成 BH 草稿（同样走人工确认与正常审批）。`,
    );
  }
}

/* ────────────────────── W2-#4 冻结版本的执行通道 ────────────────────── */

export interface FrozenPlanLine {
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  /** 冻结时点的建议量（不回算） */
  suggestedQty: string;
  suppressed: boolean;
  shortageDate: string | null;
  orderByDate: string | null;
  orderWindowMissed: boolean;
  /** 该行是否已经开过 BH（同周期同 SKU 只提示，不硬拦——分批下单是常态） */
  drafted: boolean;
}

export interface FrozenPlanExecutionView {
  cycle: { id: number; month: string; name: string; status: SopStatus; planningVersionId: number; planDigest: string };
  lines: FrozenPlanLine[];
  /** 已由本周期生成的 BH 草稿 */
  drafts: { docNo: string; bhId: number; lineCount: number; at: string; by: string | null }[];
}

/** 冻结（或执行中）周期的可执行行 + 已开单据。共识未达成/已关闭的周期没有执行通道。 */
export async function getFrozenPlanExecution(user: SessionUser, cycleId: number, dbArg?: AnyDb): Promise<FrozenPlanExecutionView> {
  requireAnyRole(user, "pmc", "purchasing", "ops", "finance");
  const db = await resolveDb(dbArg);
  const [cycle] = await db.select().from(schema.sopCycles).where(eq(schema.sopCycles.id, cycleId));
  if (!cycle) throw new ApiError(404, "S&OP 周期不存在");
  if (cycle.status !== "frozen" && cycle.status !== "executing") {
    throw new ApiError(409, `只有已冻结/执行中的周期有执行通道（当前 ${cycle.status}）`);
  }
  const lineRows: { skuId: number; skuCode: string; skuName: string; baseUom: string; suggestedQty: string; suppressed: boolean; shortageDate: string | null; orderByDate: string | null; orderWindowMissed: boolean }[] = await db
    .select({
      skuId: schema.planningVersionLines.skuId,
      skuCode: schema.planningVersionLines.skuCode,
      skuName: schema.planningVersionLines.skuName,
      baseUom: schema.planningVersionLines.baseUom,
      suggestedQty: schema.planningVersionLines.suggestedQty,
      suppressed: schema.planningVersionLines.suppressed,
      shortageDate: schema.planningVersionLines.shortageDate,
      orderByDate: schema.planningVersionLines.orderByDate,
      orderWindowMissed: schema.planningVersionLines.orderWindowMissed,
    })
    .from(schema.planningVersionLines)
    .where(eq(schema.planningVersionLines.versionId, cycle.planningVersionId));

  const draftRows: { after: unknown; createdAt: Date; by: string | null }[] = await db
    .select({ after: schema.auditLogs.after, createdAt: schema.auditLogs.createdAt, by: schema.users.name })
    .from(schema.auditLogs)
    .leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
    .where(and(
      eq(schema.auditLogs.entity, "sop_cycle"),
      eq(schema.auditLogs.action, "execute_draft"),
      eq(schema.auditLogs.entityId, cycle.id),
    ))
    .orderBy(desc(schema.auditLogs.id));
  const draftedSkus = new Set<number>();
  const drafts = draftRows.map((r) => {
    const after = (r.after ?? {}) as { docNo?: string; bhId?: number; skuIds?: number[] };
    for (const id of after.skuIds ?? []) draftedSkus.add(id);
    return {
      docNo: after.docNo ?? "",
      bhId: after.bhId ?? 0,
      lineCount: (after.skuIds ?? []).length,
      at: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
      by: r.by,
    };
  });

  return {
    cycle: {
      id: cycle.id, month: cycle.month, name: cycle.name, status: cycle.status as SopStatus,
      planningVersionId: cycle.planningVersionId, planDigest: cycle.planDigest,
    },
    lines: lineRows
      .map((l) => ({ ...l, drafted: draftedSkus.has(l.skuId) }))
      .sort((a, b) => (a.orderByDate ?? "9999-12-31").localeCompare(b.orderByDate ?? "9999-12-31") || a.skuCode.localeCompare(b.skuCode)),
    drafts,
  };
}

/**
 * 按冻结计划开单（W2-#4）：把冻结版本的行生成一张 BH 草稿。
 *
 * 与实时路径**同一个人工闸**：pmc 勾选 → createBh → 正常审批链；数量取冻结版本的行，
 * 绝不回算实时建议（那正是冻结要防的事）。审计落在 sop_cycle 上（action=execute_draft），
 * 因此「这张单出自哪个共识版本」可回溯。
 */
export async function executeFrozenPlan(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ id: number; docNo: string; lineCount: number }> {
  requireAnyRole(user, "pmc");
  const value = executeFrozenPlanSchema.parse(input);
  const db = await resolveDb(dbArg);
  const [cycle] = await db.select().from(schema.sopCycles).where(eq(schema.sopCycles.id, value.cycleId));
  if (!cycle) throw new ApiError(404, "S&OP 周期不存在");
  if (cycle.status !== "frozen" && cycle.status !== "executing") {
    throw new ApiError(409, `只有已冻结/执行中的周期可以按计划开单（当前 ${cycle.status}）`);
  }
  const plan = await getVersion(cycle.planningVersionId, db);
  if (plan.digest !== cycle.planDigest) {
    throw new ApiError(409, "冻结版本摘要与周期记录不一致，拒绝据此开单");
  }

  const wanted = value.skuIds?.length ? new Set(value.skuIds) : null;
  const lines: { skuId: number; skuCode: string; suggestedQty: string; suppressed: boolean }[] = await db
    .select({
      skuId: schema.planningVersionLines.skuId,
      skuCode: schema.planningVersionLines.skuCode,
      suggestedQty: schema.planningVersionLines.suggestedQty,
      suppressed: schema.planningVersionLines.suppressed,
    })
    .from(schema.planningVersionLines)
    .where(eq(schema.planningVersionLines.versionId, cycle.planningVersionId));
  const picked = lines
    .filter((l) => (wanted ? wanted.has(l.skuId) : true))
    .filter((l) => (value.includeSuppressed ? true : !l.suppressed))
    .filter((l) => Number(l.suggestedQty) > 0);
  if (picked.length === 0) {
    throw new ApiError(400, wanted ? "所选行在冻结版本里没有可开单的数量（被抑制的行需显式放行）" : "冻结版本里没有可开单的行");
  }
  if (picked.length > 200) throw new ApiError(400, "一次最多 200 项，请分批开单");

  const { createBh } = await import("@/server/modules/outsource/bh");
  const delegate: SessionUser = user.roles.includes("ops") ? user : { ...user, roles: [...user.roles, "ops"] };
  const doc = await createBh(
    delegate,
    {
      remark: value.remark?.trim() || `按冻结 S&OP 计划开单（${cycle.name}／版本 #${plan.id}，人工确认）`,
      lines: picked.map((l) => ({ skuId: l.skuId, qty: l.suggestedQty })),
    },
    db,
  );
  await writeAudit(db, {
    userId: user.id,
    entity: "sop_cycle",
    entityId: cycle.id,
    action: "execute_draft",
    after: {
      docNo: doc.docNo,
      bhId: doc.id,
      planningVersionId: plan.id,
      planDigest: cycle.planDigest,
      cycleVersion: cycle.version,
      skuIds: picked.map((l) => l.skuId),
      includeSuppressed: Boolean(value.includeSuppressed),
      source: "sop_frozen_plan",
    },
  });
  return { id: doc.id, docNo: doc.docNo, lineCount: picked.length };
}
