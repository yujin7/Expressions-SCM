import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "@/server/modules/outsource/common";
import { shanghaiMonthOf } from "@/server/core/business-day";
import { currentWriteActor } from "@/server/core/current-write-actor";
import { loadUserScopes } from "@/server/core/data-scope";
import { bhReadScope } from "@/server/core/bh-read-scope";
import { dCmp } from "@/server/core/decimal";

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
  /** 幂等键：双击「按冻结计划开单」只应产生一张草稿（与 createSopCycleSchema 同型） */
  idempotencyKey: z.string().uuid().transform(key => key.toLowerCase()),
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

/**
 * 三方共识必须是**三个人**（2026-09-04 安全审计 S1）。
 *
 * 此前只判「每个角色最新决定是 agree 且摘要 = 当前 planDigest」，全程没有任何
 * 「签认人互不相同」的要求；而角色是叠加的，一个同时挂 pmc/ops/finance 的账号
 * （小组织的常见配置）能自己签满三个角色、自己冻结当月——冻结之后全系统实时补货建议
 * 转只读，所有下单都改走他冻结的那个版本。`decideSopCycle` 早就拒绝「管理员代签」，
 * 但代签与「一人身兼三角」是同一件事的两面，只堵了一面。
 *
 * 判定放在两处（签认时 + 冻结时），因为它们回答的问题不同：
 *  · 签认时拦住**制造**这种局面的那一步，并当场把话说清楚；
 *  · 冻结时再查一次，历史数据（护栏上线前签下的）不会因为绕过写路径就通过冻结门。
 *
 * 返回本轮同一个人持有的重复「同意」——空数组 = 签认人互不相同。
 */
function duplicateSigners(
  latest: Partial<Record<SopRole, SopDecision>>,
  planDigest: string,
): { userId: number; name: string | null; roles: SopRole[] }[] {
  const byUser = new Map<number, { userId: number; name: string | null; roles: SopRole[] }>();
  for (const role of SOP_ROLES) {
    const hit = latest[role];
    if (hit?.decision !== "agree" || hit.planDigest !== planDigest) continue;
    const entry = byUser.get(hit.decidedBy)
      ?? { userId: hit.decidedBy, name: hit.decidedByName, roles: [] };
    entry.roles.push(role);
    byUser.set(hit.decidedBy, entry);
  }
  return [...byUser.values()].filter((e) => e.roles.length > 1);
}

/** 三方共识是否达成：三个角色都以当前摘要签了「同意」，且**由三个不同的人**签。 */
function consensusReached(latest: Partial<Record<SopRole, SopDecision>>, planDigest: string): boolean {
  return pendingRoles(latest, planDigest).length === 0 && duplicateSigners(latest, planDigest).length === 0;
}

function describeDuplicateSigners(dups: { name: string | null; roles: SopRole[] }[]): string {
  return dups
    .map((d) => `${d.name ?? "该用户"} 同时以 ${d.roles.map((r) => `「${SOP_ROLE_LABELS[r]}」`).join("、")} 签认`)
    .join("；");
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
  return shanghaiMonthOf(now);
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
    /* 与冻结门同一个判定（含「三个人」要求）——界面不得把一个必然 409 的冻结按钮点亮 */
    const consensusReady = consensusReached(latest, row.planDigest);
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
  const decided = db.transaction(async (tx: AnyDb) => {
    const cycle = await lockCycle(value.cycleId, tx);
    if (cycle.status !== "consensus") throw new ApiError(409, "当前周期已退出共识阶段，不能再签认");
    if (cycle.version !== value.version) throw new ApiError(409, `共识轮次已变化：当前第 ${cycle.version} 轮`);

    /* 本轮已落的决定（周期行已 FOR UPDATE 锁住，读到的就是最终态） */
    const { rows: roundRows } = await currentDecisions(cycle.id, cycle.version, tx);

    if (value.decision === "agree") {
      /* S1 一人一签：同一轮里同一个人不得持有第二份「同意」。
         角色是叠加的，`user.roles.includes(value.role)` 只保证「你确实有这个角色」，
         不保证「签这三个角色的是三个人」——不加这道，一人身兼三角即可独自冻结当月。
         同角色重复签也走这里（本轮没变，重签没有新信息）。 */
      const mine = roundRows.find((r) => r.decision === "agree" && r.decidedBy === user.id);
      if (mine) {
        throw new ApiError(
          409,
          mine.role === value.role
            ? `本轮您已以「${SOP_ROLE_LABELS[value.role]}」身份签认过，无需重复签认。`
            : `本轮您已以「${SOP_ROLE_LABELS[mine.role as SopRole]}」身份签认过：`
              + "三方共识必须由三个不同的人完成，一人身兼多角时只能签其中一个角色，"
              + "其余角色请由实际负责的同事本人签认。",
        );
      }
    } else {
      /* S7 驳回一轮一次：驳回既不改状态也不推进轮次，此前可以无限次重复，
         每次都插一条决定 + 一条审计 + 一条 severity=high 的新通知给发起人
         （配了飞书就是一条飞书消息）——一个谁都能循环触发的通知放大器。
         同一轮同一角色的第二次驳回没有新信息：意见已经记下了，改计划才推进轮次。 */
      const already = roundRows.find((r) => r.decision === "reject" && r.role === value.role);
      if (already) {
        throw new ApiError(
          409,
          `本轮「${SOP_ROLE_LABELS[value.role]}」已驳回过（第 ${cycle.version} 轮），不重复记录。`
          + "请由发起人更换源计划开启新一轮共识；对齐后本轮仍可直接改签「同意」。",
        );
      }
    }

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
        /* 去重键**不含 decision.id**：那是自增主键，每插一条就变一个新键，
           等于「去重键保证每次都不去重」。一轮一个角色最多一条驳回通知，
           上面的驳回幂等闸让它连第二次插入都到不了。 */
        dedupeKey: `sop:${cycle.id}:v${cycle.version}:reject:${value.role}`,
        userId: cycle.createdBy,
      }];
    } else {
      const { latest } = await currentDecisions(cycle.id, cycle.version, tx);
      notify = awaitingItems(meta, pendingRoles(latest, cycle.planDigest));
    }
  });
  try {
    await decided;
  } catch (error) {
    /* 数据库背书（uq_sop_agree_one_per_signer / uq_sop_reject_one_per_role_round）兜底命中：
       应用层闸门本该先拦下，但并发下两笔同时通过读检查时唯一索引才是最终仲裁者。
       用户看到的必须是中文的 409，而不是 23505 变成的 500。 */
    if (databaseErrorCode(error) === "23505") {
      throw new ApiError(
        409,
        value.decision === "agree"
          ? "本轮您已签认过：三方共识必须由三个不同的人完成，一人身兼多角时只能签其中一个角色。"
          : `本轮「${SOP_ROLE_LABELS[value.role]}」已驳回过，不重复记录；请由发起人更换源计划开启新一轮。`,
      );
    }
    throw error;
  }
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
      const missing = pendingRoles(latest, cycle.planDigest);
      if (missing.length > 0) throw new ApiError(409, `尚未达成三方共识：${missing.join("、")}`);
      /* S1：三个签名齐了还不够——必须来自三个不同的人。护栏上线前签下的历史数据
         同样走这道门，不因为「当时能签」就放行冻结。 */
      const dups = duplicateSigners(latest, cycle.planDigest);
      if (dups.length > 0) {
        throw new ApiError(
          409,
          `三方共识必须由三个不同的人签认：${describeDuplicateSigners(dups)}。`
          + "请让实际持有该角色的另一位同事本人签认后再冻结（冻结会让当月实时建议转为只读，全公司下单改走此版本）。",
        );
      }
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

/** 已冻结周期的行与历史；关闭后仍可读，新增开单另由 executeFrozenPlan 守卫。 */
export async function getFrozenPlanExecution(user: SessionUser, cycleId: number, dbArg?: AnyDb): Promise<FrozenPlanExecutionView> {
  requireAnyRole(user, "pmc", "purchasing", "ops", "finance");
  const db = await resolveDb(dbArg);
  const [cycle] = await db.select().from(schema.sopCycles).where(eq(schema.sopCycles.id, cycleId));
  if (!cycle) throw new ApiError(404, "S&OP 周期不存在");
  if (!["frozen", "executing", "closed"].includes(cycle.status)) {
    throw new ApiError(409, `只有已冻结过的周期可查看执行记录（当前 ${cycle.status}）`);
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

  /* 已开草稿读**业务链接表**，不再从 audit_logs 反推（S2）。
     此前 `drafted` 是解析 `audit_logs.after.skuIds` 算出来的，而那条审计写在
     createBh 的事务之外：审计写失败 → 页面显示这些行「未开单」→ 同样的量被再开一张。
     现在 sop_execution_drafts 与 BH 主单在同一事务里落地，读到的即是真账。 */
  const scopedReader = { ...user, ...await loadUserScopes(db, user.id) };
  const draftRows: { docNo: string; bhId: number; skuIds: number[]; createdAt: Date; by: string | null; readable: boolean }[] = await db
    .select({
      docNo: schema.sopExecutionDrafts.docNo,
      bhId: schema.sopExecutionDrafts.bhId,
      skuIds: schema.sopExecutionDrafts.skuIds,
      createdAt: schema.sopExecutionDrafts.createdAt,
      by: schema.users.name,
      readable: sql<boolean>`${bhReadScope(db, scopedReader) ?? sql`true`}`,
    })
    .from(schema.sopExecutionDrafts)
    .innerJoin(schema.bhDocs, eq(schema.sopExecutionDrafts.bhId, schema.bhDocs.id))
    .leftJoin(schema.users, eq(schema.sopExecutionDrafts.createdBy, schema.users.id))
    .where(eq(schema.sopExecutionDrafts.cycleId, cycle.id))
    .orderBy(desc(schema.sopExecutionDrafts.id));
  const draftedSkus = new Set<number>();
  // Shared plan coverage remains true even when a particular BH is outside the reader's scope.
  for (const row of draftRows) for (const skuId of row.skuIds ?? []) draftedSkus.add(skuId);
  const drafts = draftRows.filter(r => r.readable).map((r) => {
    const skuIds = r.skuIds ?? [];
    return {
      docNo: r.docNo,
      bhId: r.bhId,
      lineCount: skuIds.length,
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
 * 绝不回算实时建议（那正是冻结要防的事）。
 *
 * 三处写路径纪律（2026-09-04 安全审计 S2 修复）：
 *  1. **审计在 createBh 的事务内**（`hooks.inTx`）——与 npd/service.createNpdFirstOrder 同一处方。
 *     此前 createBh 先提交自己的事务、writeAudit 再单独跑一次：BH 已建成而审计失败，
 *     就留下一张没人知道从哪来的备货草稿（CLAUDE.md 明令禁止的形状）。
 *  2. **链接落 `sop_execution_drafts`**，与 BH 同一事务；执行页的「已开单」由它回答。
 *     从 audit_logs 反推业务状态本身就是缺陷：审计写失败＝页面认为没开过＝重复开单。
 *  3. **幂等键**：双击「按冻结计划开单」此前会得到两张内容相同的 BH 草稿一起进审批链
 *     （createSopCycle 早有幂等键，这里漏了）。重放直接返回第一次的单据。
 */
export async function executeFrozenPlan(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<{ id: number; docNo: string; lineCount: number }> {
  requireAnyRole(user, "pmc");
  const value = executeFrozenPlanSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "pmc");
    const scopedActor = { ...actor, ...await loadUserScopes(tx, actor.id) };
    // Existing keys are globally unique. Serialize that same boundary before any source read/write.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sop-execute'), hashtext(${value.idempotencyKey}))`);
    const db = tx;
    const requestIntent = {
      v: 1 as const, cycleId: value.cycleId,
      skuIds: value.skuIds?.length ? [...new Set(value.skuIds)].sort((a, b) => a - b) : null,
      includeSuppressed: Boolean(value.includeSuppressed), remark: value.remark?.trim() || null,
    };
    const replay = await findExecutionDraft(db, scopedActor, value.idempotencyKey, requestIntent);
    if (replay) return replay;
    const [cycle] = await db.select().from(schema.sopCycles).where(eq(schema.sopCycles.id, value.cycleId)).for("update");
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
      .filter((l) => dCmp(l.suggestedQty, "0") > 0);
    if (picked.length === 0) {
      throw new ApiError(400, wanted ? "所选行在冻结版本里没有可开单的数量（被抑制的行需显式放行）" : "冻结版本里没有可开单的行");
    }
    if (picked.length > 200) throw new ApiError(400, "一次最多 200 项，请分批开单");

    const { createDerivedBh } = await import("@/server/modules/outsource/bh");
    const skuIds = picked.map((l) => l.skuId);
    const doc = await createDerivedBh(
      scopedActor, "sop",
      {
        remark: value.remark?.trim() || `按冻结 S&OP 计划开单（${cycle.name}／版本 #${plan.id}，人工确认）`,
        lines: picked.map((l) => ({ skuId: l.skuId, qty: l.suggestedQty })),
      },
      db,
      {
        /* 链接与审计都在 createBh 的事务内：任一写失败即整单回滚，
           不会留下「有单没审计」或「有单没链接（于是会被重复开一次）」的中间态。 */
        inTx: async (tx, created) => {
          await tx.insert(schema.sopExecutionDrafts).values({
            cycleId: cycle.id,
            cycleVersion: cycle.version,
            bhId: created.id,
            docNo: created.docNo,
            planningVersionId: plan.id,
            planDigest: cycle.planDigest,
            skuIds,
            includeSuppressed: Boolean(value.includeSuppressed),
            requestIntent,
            idempotencyKey: value.idempotencyKey,
            createdBy: user.id,
          });
          await writeAudit(tx, {
            userId: user.id,
            entity: "sop_cycle",
            entityId: cycle.id,
            action: "execute_draft",
            after: {
              docNo: created.docNo,
              bhId: created.id,
              planningVersionId: plan.id,
              planDigest: cycle.planDigest,
              cycleVersion: cycle.version,
              skuIds,
              includeSuppressed: Boolean(value.includeSuppressed),
              source: "sop_frozen_plan",
            },
          });
        },
      },
    );
    return { id: doc.id, docNo: doc.docNo, lineCount: picked.length };
  });
}

/** 幂等重放：同一个幂等键只对应一张 BH 草稿（并发下唯一键是最终仲裁者） */
async function findExecutionDraft(
  db: AnyDb,
  user: SessionUser,
  idempotencyKey: string,
  requestIntent: NonNullable<typeof schema.sopExecutionDrafts.$inferSelect.requestIntent>,
): Promise<{ id: number; docNo: string; lineCount: number } | null> {
  const found = await findOwnedExecutionDraft(db, user, idempotencyKey);
  if (!found) return null;
  const { row, doc } = found;
  const original = row.requestIntent;
  if (original.v !== 1 || original.cycleId !== requestIntent.cycleId
    || original.includeSuppressed !== requestIntent.includeSuppressed || original.remark !== requestIntent.remark
    || JSON.stringify(original.skuIds) !== JSON.stringify(requestIntent.skuIds)) {
    throw new ApiError(409, "请求标识已用于不同周期、选择或备注，请核对原备货申请，不要修改原请求重试");
  }
  return { id: doc.id, docNo: doc.docNo, lineCount: (row.skuIds ?? []).length };
}

/** Read-only recovery uses the same owner/scope authority and key lock as execution. */
export async function getSopExecutionResult(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  const requestKey = z.string().uuid().transform(key => key.toLowerCase()).parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const actor = await currentWriteActor(tx, user);
    requireAnyRole(actor, "pmc");
    const scopedActor = { ...actor, ...await loadUserScopes(tx, actor.id) };
    // Wait for an in-flight execution to commit/roll back before declaring no receipt.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sop-execute'), hashtext(${requestKey}))`);
    const found = await findOwnedExecutionDraft(tx, scopedActor, requestKey);
    return found
      ? { requestKey, requestIntent: found.row.requestIntent, document: found.doc, lineCount: (found.row.skuIds ?? []).length }
      : { requestKey, requestIntent: null, document: null, lineCount: 0 };
  });
}

async function findOwnedExecutionDraft(db: AnyDb, user: SessionUser, idempotencyKey: string) {
  // Older callers could store uppercase UUIDs. Never miss their receipt after normalization.
  const rows: (typeof schema.sopExecutionDrafts.$inferSelect)[] = await db
    .select()
    .from(schema.sopExecutionDrafts)
    .where(sql`lower(${schema.sopExecutionDrafts.idempotencyKey}) = ${idempotencyKey}`)
    .limit(2);
  if (rows.length > 1) throw new ApiError(409, "历史请求标识存在大小写冲突，请联系负责人核对原开单记录，不要重复开单");
  const [row] = rows;
  if (!row) return null;
  if (row.createdBy !== user.id) throw new ApiError(403, "请求标识不属于当前账号，请核对自己的开单记录");
  const [doc] = await db.select({ id: schema.bhDocs.id, docNo: schema.bhDocs.docNo, status: schema.bhDocs.status }).from(schema.bhDocs)
    .where(and(eq(schema.bhDocs.id, row.bhId), bhReadScope(db, user)));
  if (!doc) throw new ApiError(403, "原备货申请不在当前可读范围，请联系负责人核对");
  if (!row.requestIntent) throw new ApiError(409, `历史回执未保存完整请求内容，请在备货申请中核对 ${doc.docNo}；不要换请求标识重复开单`);
  return { row: { ...row, requestIntent: row.requestIntent }, doc };
}
