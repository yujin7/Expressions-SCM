/**
 * D58/D59 SKU 月度计划策略：把分层页的实时判定**固化**到 sku_planning_policy（按 period=YYYY-MM）。
 *
 * 口径纪律：
 * - 分层/权责本身不在此重算——tier/xyz/ownership 全部来自 report/segmentation.getSegmentation
 *   （其内部消费 rules/abc.classifyTier、rules/volatility、rules/replenish-ownership 三个唯一权威）；
 *   本模块只负责「某月固化了什么」与「人工覆写留痕」。
 * - 固化 = 同事务 upsert(skuId, period)：tier/abc/xyz/ownership/builtAt 覆盖，**override_* 与 pilot 保留**
 *   （重建不能抹掉人工决定）；writeAudit 同事务一行（entity=sku_planning_policy, action=build）。
 * - 人工覆写只写 override_tier/by/note（tier 原值保留），pmc（admin 兜底）；写审计 before/after。
 * - 试点标记 pilot：pmc 一键纳入/移出（审计）。
 * - runPolicyBuild 供调度，本模块不注册任务。**调度器实际是每天 03:00 跑一次**
 *   （`jobs/interval-runner.ts` 的 planning-policy-build），因此 runPolicyBuild **必须幂等**：
 *   本期已有策略行即整次跳过，不重算、不写审计。否则「本期已固化」的分层会随销量数据每天变一次，
 *   页面标着 2026-09 期固化的四档昨天 A、今天 B，谁也说不清生效的是哪一版。
 *   要重算由人工在分层页显式重建（force=true），重建时每个分层变化的 SKU 单落一行 retier 审计。
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, r1, resolveDb } from "@/server/core/svc";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { getSegmentation, type SegRow } from "@/server/modules/report/segmentation";
import { tierToAbc, type Tier } from "@/server/rules/abc";
import { OWNERSHIP_LABELS, type Ownership } from "@/server/rules/replenish-ownership";
import type { XyzClass } from "@/server/rules/volatility";

export const TIERS: readonly Tier[] = ["S", "A", "B", "C"];
export const TIER_LABELS: Record<Tier, string> = { S: "S 级（核心）", A: "A 级", B: "B 级", C: "C 级（长尾）" };

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function currentPeriod(): string {
  return todayShanghai().slice(0, 7);
}

export function assertPeriod(period: string): string {
  if (!PERIOD_RE.test(period)) throw new ApiError(400, "期间格式须为 YYYY-MM");
  return period;
}

export interface PolicyRow {
  id: number;
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  period: string;
  /** 规则产出的四档（固化值） */
  tier: Tier;
  /** 人工覆写（null = 未覆写） */
  overrideTier: Tier | null;
  overrideBy: string | null;
  overrideNote: string | null;
  /** 生效分层 = overrideTier ?? tier */
  effectiveTier: Tier;
  abc: "A" | "B" | "C";
  xyz: XyzClass | null;
  ownership: Ownership;
  ownershipLabel: string;
  pilot: boolean;
  builtAt: string;
}

/**
 * 「供应链直出为什么是 0」：S/A/B 规则分层中各阻塞维度的 SKU 数（一个 SKU 可同时计入多项；C 级不计）。
 * 维度与 rules/replenish-ownership.decideOwnership 的 blockers 一一对应：
 * leadDaysUnknown = 交期主数据缺失（去 /master/supply-params 补录即可解除）；
 * xyzNull = 波动样本不足/无动销；xyzNotX = 需求波动 Y/Z；detectorHit = 异动侦测命中。
 */
export interface PolicyBlockers {
  leadDaysUnknown: number;
  xyzNull: number;
  xyzNotX: number;
  detectorHit: number;
  /** S/A/B 规则分层 SKU 总数（分母） */
  candidates: number;
}

export const emptyBlockers = (): PolicyBlockers => ({ leadDaysUnknown: 0, xyzNull: 0, xyzNotX: 0, detectorHit: 0, candidates: 0 });

export interface PolicySummary {
  period: string | null;
  total: number;
  byTier: Record<Tier, number>;
  byEffectiveTier: Record<Tier, number>;
  byOwnership: Record<Ownership, number>;
  overrides: number;
  pilot: number;
  builtAt: string | null;
  /**
   * 该期最近一次固化时的阻塞分布（取自固化审计快照 after.blockers；本功能上线前固化的期间 = null）。
   * 实时分布看 report/replenish-pilot（含补录后立即变化）。
   */
  blockers: PolicyBlockers | null;
}

export interface PolicyResult {
  period: string | null;
  /** 可选期间列表（降序） */
  periods: string[];
  rows: PolicyRow[];
  total: number;
  summary: PolicySummary;
}

const emptyByTier = (): Record<Tier, number> => ({ S: 0, A: 0, B: 0, C: 0 });
const emptyByOwnership = (): Record<Ownership, number> => ({ supply_chain_direct: 0, joint_review: 0, ops_fallback: 0 });

/** 最近一次固化的期间（表空 = null） */
export async function latestPolicyPeriod(db: AnyDb): Promise<string | null> {
  const [row]: { period: string | null }[] = await db
    .select({ period: sql<string | null>`max(${schema.skuPlanningPolicy.period})` })
    .from(schema.skuPlanningPolicy);
  return row?.period ?? null;
}

export interface PolicyLookup {
  tier: Tier;
  effectiveTier: Tier;
  overrideTier: Tier | null;
  xyz: XyzClass | null;
  ownership: Ownership;
  pilot: boolean;
}

/**
 * 供补货建议 / 预警等消费者：某期（缺省最近一期）的 skuId → 策略。
 * 未固化任何期间时返回 { period: null, bySku: 空 }——消费者须显示「未固化」，不得静默按 C 处理。
 */
export async function loadPolicyMap(db: AnyDb, period?: string | null): Promise<{ period: string | null; bySku: Map<number, PolicyLookup> }> {
  const p = period ?? (await latestPolicyPeriod(db));
  const bySku = new Map<number, PolicyLookup>();
  if (!p) return { period: null, bySku };
  const t = schema.skuPlanningPolicy;
  const rows: { skuId: number; tier: string; overrideTier: string | null; xyz: string | null; ownership: string; pilot: boolean }[] = await db
    .select({ skuId: t.skuId, tier: t.tier, overrideTier: t.overrideTier, xyz: t.xyz, ownership: t.ownership, pilot: t.pilot })
    .from(t)
    .where(eq(t.period, p));
  for (const r of rows) {
    const tier = r.tier as Tier;
    const overrideTier = (r.overrideTier as Tier | null) ?? null;
    bySku.set(r.skuId, {
      tier,
      overrideTier,
      effectiveTier: overrideTier ?? tier,
      xyz: (r.xyz as XyzClass | null) ?? null,
      ownership: r.ownership as Ownership,
      pilot: r.pilot,
    });
  }
  return { period: p, bySku };
}

/* ────────────────────────── 固化 ────────────────────────── */

export interface BuildResult {
  period: string;
  total: number;
  inserted: number;
  updated: number;
  byTier: Record<Tier, number>;
  byOwnership: Record<Ownership, number>;
  /** 因 override 仍保留而生效分层 ≠ 规则分层的 SKU 数 */
  overridesKept: number;
  /** 直出为 0 的原因分布（S/A/B 各阻塞维度；见 PolicyBlockers） */
  blockers: PolicyBlockers;
  /** 本期已固化且未 force，整次跳过（未写任何行、未写审计） */
  skipped: boolean;
  /** 重新固化时规则分层与上一版不同的 SKU 数（每一个都单独落一行 retier 审计） */
  tierChanged: number;
}

/** 从分层行统计阻塞分布（与 rules/replenish-ownership 同维度；C 级不计） */
export function countBlockers(rows: readonly Pick<SegRow, "tier" | "xyzRaw" | "leadDaysKnown" | "detectorHit">[]): PolicyBlockers {
  const b = emptyBlockers();
  for (const r of rows) {
    if (r.tier === "C") continue;
    b.candidates += 1;
    if (!r.leadDaysKnown) b.leadDaysUnknown += 1;
    if (r.xyzRaw == null) b.xyzNull += 1;
    else if (r.xyzRaw !== "X") b.xyzNotX += 1;
    if (r.detectorHit) b.detectorHit += 1;
  }
  return b;
}

/**
 * 固化某期分层与权责。actor 为 null 时表示调度任务（审计 userId 取系统用户 = 最小 id 的 admin；无则 1）。
 *
 * **幂等（本模块开头写的是「月度固化」，调度器却是每天 03:00 跑一次）**：
 * 本期只要已有策略行，默认整次跳过——否则「已冻结」的分层会随销量数据每天悄悄变一次，
 * 页面上标着「2026-09 期固化」的四档，昨天是 A 今天是 B，谁也说不清生效的是哪一版。
 * `force: true`（人工在分层页点重建）才真正重算；重算时**每个规则分层发生变化的 SKU 单写一行审计**
 * （entity=sku_planning_policy, action=retier, before/after 带 tier），
 * 「冻结期内改过分层」这件事必须留下逐条痕迹，不能只有一行汇总。
 */
export async function buildSkuPlanningPolicy(
  period: string,
  opts: { db?: AnyDb; actor?: SessionUser | null; force?: boolean } = {},
): Promise<BuildResult> {
  assertPeriod(period);
  const db = await resolveDb(opts.db);
  if (opts.actor) requireAnyRole(opts.actor, "pmc");
  const t = schema.skuPlanningPolicy;

  /* 幂等闸：本期已固化且非 force —— 一行都不写，也不落审计（跳过不是事件） */
  if (!opts.force) {
    const [existingCount]: { n: number }[] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(eq(t.period, period));
    if ((existingCount?.n ?? 0) > 0) {
      return {
        period, total: 0, inserted: 0, updated: 0,
        byTier: emptyByTier(), byOwnership: emptyByOwnership(),
        overridesKept: 0, blockers: countBlockers([]),
        skipped: true, tierChanged: 0,
      };
    }
  }

  const seg = await getSegmentation({ allRows: true }, db);
  const byTier = emptyByTier();
  const byOwnership = emptyByOwnership();
  const result: BuildResult = { period, total: seg.rows.length, inserted: 0, updated: 0, byTier, byOwnership, overridesKept: 0, blockers: countBlockers(seg.rows), skipped: false, tierChanged: 0 };
  const actorId = opts.actor?.id ?? (await systemActorId(db));

  await db.transaction(async (tx: AnyDb) => {
    const existing: { skuId: number; tier: string; overrideTier: string | null }[] = await tx
      .select({ skuId: t.skuId, tier: t.tier, overrideTier: t.overrideTier })
      .from(t)
      .where(eq(t.period, period));
    const existingBySku = new Map(existing.map((e) => [e.skuId, e]));
    /** 重新固化时规则分层被改掉的 SKU（逐条审计，同事务） */
    const retiered: { skuId: number; from: string; to: Tier }[] = [];
    // 按 skuId 升序写入（确定性顺序，同 CLAUDE.md 余额更新纪律）
    const rows = [...seg.rows].sort((a, b) => a.skuId - b.skuId);
    for (const r of rows) {
      byTier[r.tier] += 1;
      byOwnership[r.ownership] += 1;
      const prev = existingBySku.get(r.skuId);
      if (prev?.overrideTier && prev.overrideTier !== r.tier) result.overridesKept += 1;
      if (prev && prev.tier !== r.tier) retiered.push({ skuId: r.skuId, from: prev.tier, to: r.tier });
      if (prev) result.updated += 1; else result.inserted += 1;
      await tx
        .insert(t)
        .values({
          skuId: r.skuId,
          period,
          tier: r.tier,
          abc: tierToAbc(r.tier),
          xyz: r.xyzRaw,
          ownership: r.ownership,
        })
        .onConflictDoUpdate({
          target: [t.skuId, t.period],
          // override_* 与 pilot 刻意不在 set 内：重建不抹人工决定
          set: { tier: r.tier, abc: tierToAbc(r.tier), xyz: r.xyzRaw, ownership: r.ownership, builtAt: sql`now()` },
        });
    }
    /* 冻结期内分层被改：逐条留痕（同事务），否则只剩一行「build，updated=1026」的汇总，
       事后无法回答「9 月里 CP00007 是什么时候从 A 掉到 B 的」。 */
    result.tierChanged = retiered.length;
    for (const c of retiered) {
      await writeAudit(tx, {
        userId: actorId,
        entity: "sku_planning_policy",
        action: "retier",
        before: { period, skuId: c.skuId, tier: c.from },
        after: { period, skuId: c.skuId, tier: c.to, source: opts.actor ? "manual_rebuild" : "scheduler_rebuild" },
      });
    }
    await writeAudit(tx, {
      userId: actorId,
      entity: "sku_planning_policy",
      action: "build",
      after: {
        period,
        total: result.total,
        inserted: result.inserted,
        updated: result.updated,
        byTier,
        byOwnership,
        overridesKept: result.overridesKept,
        tierChanged: result.tierChanged,
        forced: opts.force === true,
        blockers: result.blockers,
        tierCuts: seg.tierCuts,
        months: seg.months,
        source: opts.actor ? "manual" : "scheduler",
      },
    });
  });
  return result;
}

async function systemActorId(db: AnyDb): Promise<number> {
  const [row]: { id: number }[] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`'admin' = ANY(${schema.users.roles})`)
    .orderBy(schema.users.id)
    .limit(1);
  return row?.id ?? 1;
}

/**
 * 调度入口（不在本模块注册）：固化**当期**，幂等——本期已有策略行即跳过。
 * 调度器实际是每天 03:00 跑（`jobs/interval-runner.ts`），靠这里的幂等闸把「每天重算」
 * 变成「本期第一次跑时固化一次」；需要重算由人工在分层页显式重建（force）。
 */
export async function runPolicyBuild(db?: AnyDb): Promise<BuildResult> {
  return buildSkuPlanningPolicy(currentPeriod(), { db, actor: null, force: false });
}

/* ────────────────────────── 人工覆写 / 试点 ────────────────────────── */

const overrideSchema = z.object({
  skuId: z.number().int().positive(),
  period: z.string().regex(PERIOD_RE, "期间格式须为 YYYY-MM"),
  /** null = 撤销覆写 */
  overrideTier: z.enum(["S", "A", "B", "C"]).nullable(),
  note: z.string().trim().max(200).optional(),
});
export type OverrideTierInput = z.infer<typeof overrideSchema>;

export async function overrideTier(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<PolicyLookup & { skuId: number; period: string }> {
  requireAnyRole(user, "pmc");
  const v = overrideSchema.parse(input);
  if (v.overrideTier != null && !v.note?.trim()) throw new ApiError(400, "覆写分层必须填写理由");
  const db = await resolveDb(dbArg);
  const t = schema.skuPlanningPolicy;
  return db.transaction(async (tx: AnyDb) => {
    const [row] = await tx.select().from(t).where(and(eq(t.skuId, v.skuId), eq(t.period, v.period)));
    if (!row) throw new ApiError(404, "该 SKU 在此期间尚未固化分层，请先执行本期固化");
    const nextOverride = v.overrideTier != null && v.overrideTier !== row.tier ? v.overrideTier : null;
    const [updated] = await tx
      .update(t)
      .set({
        overrideTier: nextOverride,
        overrideBy: nextOverride ? user.id : null,
        overrideNote: nextOverride ? (v.note?.trim() ?? null) : null,
      })
      .where(eq(t.id, row.id))
      .returning();
    await writeAudit(tx, {
      userId: user.id,
      entity: "sku_planning_policy",
      entityId: row.id,
      action: nextOverride ? "override_tier" : "clear_override",
      before: { skuId: row.skuId, period: row.period, tier: row.tier, overrideTier: row.overrideTier, overrideNote: row.overrideNote },
      after: { skuId: row.skuId, period: row.period, tier: row.tier, overrideTier: nextOverride, overrideNote: updated.overrideNote, requested: v.overrideTier },
    });
    const tier = updated.tier as Tier;
    return {
      skuId: row.skuId,
      period: row.period,
      tier,
      overrideTier: (updated.overrideTier as Tier | null) ?? null,
      effectiveTier: ((updated.overrideTier as Tier | null) ?? tier),
      xyz: (updated.xyz as XyzClass | null) ?? null,
      ownership: updated.ownership as Ownership,
      pilot: updated.pilot,
    };
  });
}

const pilotSchema = z.object({
  period: z.string().regex(PERIOD_RE, "期间格式须为 YYYY-MM"),
  skuIds: z.array(z.number().int().positive()).min(1).max(500),
  pilot: z.boolean(),
});
export type SetPilotInput = z.infer<typeof pilotSchema>;

/** 试点标记（pmc；admin 兜底）：只改 pilot 列，审计一行记 skuIds */
export async function setPilotFlags(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<{ period: string; changed: number; missing: number[] }> {
  requireAnyRole(user, "pmc");
  const v = pilotSchema.parse(input);
  const db = await resolveDb(dbArg);
  const t = schema.skuPlanningPolicy;
  return db.transaction(async (tx: AnyDb) => {
    const rows: { id: number; skuId: number; pilot: boolean }[] = await tx
      .select({ id: t.id, skuId: t.skuId, pilot: t.pilot })
      .from(t)
      .where(and(eq(t.period, v.period), inArray(t.skuId, v.skuIds)));
    const found = new Set(rows.map((r) => r.skuId));
    const missing = v.skuIds.filter((id) => !found.has(id));
    const toChange = rows.filter((r) => r.pilot !== v.pilot).sort((a, b) => a.skuId - b.skuId);
    if (toChange.length > 0) {
      await tx.update(t).set({ pilot: v.pilot }).where(inArray(t.id, toChange.map((r) => r.id)));
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "sku_planning_policy",
      action: v.pilot ? "pilot_add" : "pilot_remove",
      before: { period: v.period, skuIds: toChange.map((r) => r.skuId), pilot: !v.pilot },
      after: { period: v.period, skuIds: toChange.map((r) => r.skuId), pilot: v.pilot, missing },
    });
    return { period: v.period, changed: toChange.length, missing };
  });
}

/* ────────────────────────── 读 ────────────────────────── */

export interface PolicyQuery {
  period?: string | null;
  q?: string;
  tier?: string;
  ownership?: string;
  /** 只看有人工覆写的行 */
  overriddenOnly?: boolean;
  pilotOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export async function getPolicy(query: PolicyQuery, dbArg?: AnyDb): Promise<PolicyResult> {
  const db = await resolveDb(dbArg);
  const t = schema.skuPlanningPolicy;
  const periodRows: { period: string }[] = await db
    .selectDistinct({ period: t.period })
    .from(t)
    .orderBy(desc(t.period));
  const periods = periodRows.map((r) => r.period);
  const period = query.period ? assertPeriod(query.period) : (periods[0] ?? null);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const summary: PolicySummary = {
    period,
    total: 0,
    byTier: emptyByTier(),
    byEffectiveTier: emptyByTier(),
    byOwnership: emptyByOwnership(),
    overrides: 0,
    pilot: 0,
    builtAt: null,
    blockers: null,
  };
  if (!period) return { period: null, periods, rows: [], total: 0, summary };
  summary.blockers = await loadBuildBlockers(db, period);

  const raw: {
    id: number; skuId: number; code: string; name: string; brand: string | null; period: string;
    tier: string; abc: string; xyz: string | null; ownership: string; pilot: boolean;
    overrideTier: string | null; overrideBy: string | null; overrideNote: string | null; builtAt: Date;
  }[] = await db
    .select({
      id: t.id, skuId: t.skuId, code: schema.skus.code, name: schema.skus.name, brand: schema.brands.nameCn, period: t.period,
      tier: t.tier, abc: t.abc, xyz: t.xyz, ownership: t.ownership, pilot: t.pilot,
      overrideTier: t.overrideTier, overrideBy: schema.users.name, overrideNote: t.overrideNote, builtAt: t.builtAt,
    })
    .from(t)
    .innerJoin(schema.skus, eq(t.skuId, schema.skus.id))
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .leftJoin(schema.users, eq(t.overrideBy, schema.users.id))
    .where(eq(t.period, period));

  const all: PolicyRow[] = raw.map((r) => {
    const tier = r.tier as Tier;
    const overrideTier = (r.overrideTier as Tier | null) ?? null;
    const ownership = r.ownership as Ownership;
    return {
      id: r.id,
      skuId: r.skuId,
      code: r.code,
      name: r.name,
      brand: r.brand,
      period: r.period,
      tier,
      overrideTier,
      overrideBy: r.overrideBy,
      overrideNote: r.overrideNote,
      effectiveTier: overrideTier ?? tier,
      abc: r.abc as "A" | "B" | "C",
      xyz: (r.xyz as XyzClass | null) ?? null,
      ownership,
      ownershipLabel: OWNERSHIP_LABELS[ownership],
      pilot: r.pilot,
      builtAt: r.builtAt.toISOString(),
    };
  });
  summary.total = all.length;
  for (const r of all) {
    summary.byTier[r.tier] += 1;
    summary.byEffectiveTier[r.effectiveTier] += 1;
    summary.byOwnership[r.ownership] += 1;
    if (r.overrideTier) summary.overrides += 1;
    if (r.pilot) summary.pilot += 1;
    if (!summary.builtAt || r.builtAt > summary.builtAt) summary.builtAt = r.builtAt;
  }

  const q = (query.q ?? "").trim().toLowerCase();
  const tierFilter = (query.tier ?? "").trim().toUpperCase();
  const ownershipFilter = (query.ownership ?? "").trim();
  let filtered = all;
  if (tierFilter) filtered = filtered.filter((r) => r.effectiveTier === tierFilter);
  if (ownershipFilter) filtered = filtered.filter((r) => r.ownership === ownershipFilter);
  if (query.overriddenOnly) filtered = filtered.filter((r) => r.overrideTier != null);
  if (query.pilotOnly) filtered = filtered.filter((r) => r.pilot);
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const order: Record<Tier, number> = { S: 0, A: 1, B: 2, C: 3 };
  filtered.sort((a, b) => order[a.effectiveTier] - order[b.effectiveTier] || a.code.localeCompare(b.code));
  return { period, periods, rows: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, summary };
}

/** 该期最近一次固化审计的阻塞快照（entity=sku_planning_policy, action=build, after.period=期间）；无/旧格式 = null */
async function loadBuildBlockers(db: AnyDb, period: string): Promise<PolicyBlockers | null> {
  const a = schema.auditLogs;
  const [row]: { after: unknown }[] = await db
    .select({ after: a.after })
    .from(a)
    .where(and(eq(a.entity, "sku_planning_policy"), eq(a.action, "build"), sql`${a.after} ->> 'period' = ${period}`))
    .orderBy(desc(a.id))
    .limit(1);
  const after = row?.after;
  const b = after && typeof after === "object" ? (after as { blockers?: Partial<PolicyBlockers> | null }).blockers : null;
  if (!b || typeof b !== "object") return null;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { leadDaysUnknown: n(b.leadDaysUnknown), xyzNull: n(b.xyzNull), xyzNotX: n(b.xyzNotX), detectorHit: n(b.detectorHit), candidates: n(b.candidates) };
}

/** 四档占比（skuTierShare 指标用）：count 与 % */
export function tierShare(byTier: Record<Tier, number>): Record<Tier, { count: number; pct: number }> {
  const total = TIERS.reduce((s, k) => s + byTier[k], 0);
  return Object.fromEntries(TIERS.map((k) => [k, { count: byTier[k], pct: total > 0 ? r1((byTier[k] / total) * 100) : 0 }])) as Record<Tier, { count: number; pct: number }>;
}
