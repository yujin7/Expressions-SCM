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
 * - runPolicyBuild 供调度（建议每月 1 日 02:30 Asia/Shanghai），本模块不注册任务。
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { type AnyDb, r1, resolveDb } from "@/server/core/svc";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { getSegmentation } from "@/server/modules/report/segmentation";
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

export interface PolicySummary {
  period: string | null;
  total: number;
  byTier: Record<Tier, number>;
  byEffectiveTier: Record<Tier, number>;
  byOwnership: Record<Ownership, number>;
  overrides: number;
  pilot: number;
  builtAt: string | null;
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
}

/**
 * 固化某期分层与权责。actor 为 null 时表示调度任务（审计 userId 取系统用户 = 最小 id 的 admin；无则 1）。
 */
export async function buildSkuPlanningPolicy(
  period: string,
  opts: { db?: AnyDb; actor?: SessionUser | null } = {},
): Promise<BuildResult> {
  assertPeriod(period);
  const db = await resolveDb(opts.db);
  if (opts.actor) requireAnyRole(opts.actor, "pmc");
  const seg = await getSegmentation({ allRows: true }, db);
  const t = schema.skuPlanningPolicy;
  const byTier = emptyByTier();
  const byOwnership = emptyByOwnership();
  const result: BuildResult = { period, total: seg.rows.length, inserted: 0, updated: 0, byTier, byOwnership, overridesKept: 0 };
  const actorId = opts.actor?.id ?? (await systemActorId(db));

  await db.transaction(async (tx: AnyDb) => {
    const existing: { skuId: number; overrideTier: string | null }[] = await tx
      .select({ skuId: t.skuId, overrideTier: t.overrideTier })
      .from(t)
      .where(eq(t.period, period));
    const existingBySku = new Map(existing.map((e) => [e.skuId, e]));
    // 按 skuId 升序写入（确定性顺序，同 CLAUDE.md 余额更新纪律）
    const rows = [...seg.rows].sort((a, b) => a.skuId - b.skuId);
    for (const r of rows) {
      byTier[r.tier] += 1;
      byOwnership[r.ownership] += 1;
      const prev = existingBySku.get(r.skuId);
      if (prev?.overrideTier && prev.overrideTier !== r.tier) result.overridesKept += 1;
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

/** 调度入口（不在本模块注册）：固化当月；建议 cron `30 2 1 * *`（Asia/Shanghai） */
export async function runPolicyBuild(db?: AnyDb): Promise<BuildResult> {
  return buildSkuPlanningPolicy(currentPeriod(), { db, actor: null });
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
  };
  if (!period) return { period: null, periods, rows: [], total: 0, summary };

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

/** 四档占比（skuTierShare 指标用）：count 与 % */
export function tierShare(byTier: Record<Tier, number>): Record<Tier, { count: number; pct: number }> {
  const total = TIERS.reduce((s, k) => s + byTier[k], 0);
  return Object.fromEntries(TIERS.map((k) => [k, { count: byTier[k], pct: total > 0 ? r1((byTier[k] / total) * 100) : 0 }])) as Record<Tier, { count: number; pct: number }>;
}
