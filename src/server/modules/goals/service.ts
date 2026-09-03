/**
 * D61 部门目标（department_goals，dept_key=角色）。
 *
 *  - 写路径：create / update 同事务 writeAudit(entity="department_goal")；
 *    编辑权 = admin 或 本部门（user.roles ∋ deptKey）；其他部门只读。
 *  - 读：全员可见全部部门（页面按部门 Tab，本部门可编辑）；D62 受限用户（deptScope 非空）只见范围内部门。
 *  - actual_source=auto：从**已登记读模型缓存**（report_read_model_cache）取值：
 *      库存占比 inventorySalesRatio / 周转 turns / 账期达成率 paymentTermAttainment / OTIF onTimeRate；
 *      取不到留 null（绝不编造），并在 DTO 里给出 autoStatus 说明。
 *  - 达成度 goalAttainment：up = actual ÷ target；down = target ÷ actual；×100 保留 1 位（core/decimal，不用 float 运算）。
 */
import { and, desc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import { departmentGoals, reportReadModelCache } from "@/db/schema";
import { METRICS } from "@/components/metrics";
import { writeAudit } from "@/server/core/audit";
import { ROLES } from "@/server/core/constants";
import { resolveDeptScope } from "@/server/core/data-scope";
import { dCmp, dDiv, dMul, dZero } from "@/server/core/decimal";
import type { SessionUser } from "@/server/core/dto";
import type { AnyDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";

export const GOAL_DIRECTIONS = ["up", "down"] as const;
export type GoalDirection = (typeof GOAL_DIRECTIONS)[number];
export const PERIOD_RE = /^(\d{4}-(0[1-9]|1[0-2])|\d{4}-Q[1-4])$/;

/** auto 指标 → 已登记读模型缓存键前缀（取最新版本 /vN）与取值路径 */
export interface AutoMetricSource {
  metricKey: string;
  label: string;
  /** report_read_model_cache.key 前缀（不含 /vN） */
  cacheKeyPrefixes: readonly string[];
  /** 从 payload 里取 period 对应值的候选字段名 */
  fields: readonly string[];
  defaultDirection: GoalDirection;
}

export const AUTO_METRIC_SOURCES: readonly AutoMetricSource[] = [
  { metricKey: "inventorySalesRatio", label: "库存占比", cacheKeyPrefixes: ["inventory-sales-ratio", "inventory-daily-position"], fields: ["inventorySalesRatio", "ratio", "value"], defaultDirection: "down" },
  { metricKey: "turns", label: "库存周转", cacheKeyPrefixes: ["warehouse-turns", "inventory-daily-position"], fields: ["turns", "warehouseTurns", "value"], defaultDirection: "up" },
  { metricKey: "paymentTermAttainment", label: "账期达成率", cacheKeyPrefixes: ["supplier-payment-term"], fields: ["paymentTermAttainment", "attainment", "value"], defaultDirection: "up" },
  { metricKey: "onTimeRate", label: "OTIF 准时交付率", cacheKeyPrefixes: ["purchase-order-metrics"], fields: ["onTimeRate", "otif", "value"], defaultDirection: "up" },
];

export function autoSourceFor(metricKey: string): AutoMetricSource | null {
  return AUTO_METRIC_SOURCES.find((s) => s.metricKey === metricKey) ?? null;
}

const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const numericStr = z.union([z.number(), z.string()]).transform((v) => String(v).trim()).refine((v) => /^-?\d+(\.\d{1,4})?$/.test(v), "数值格式非法（最多 4 位小数）");

export const goalCreateSchema = z.object({
  deptKey: z.enum(ROLES),
  period: z.string().trim().regex(PERIOD_RE, "期间格式 YYYY-MM 或 YYYY-Qn"),
  metricKey: z.string().trim().min(1).max(60),
  targetValue: numericStr,
  direction: z.enum(GOAL_DIRECTIONS).optional(),
  note: z.preprocess(emptyToUndef, z.string().trim().max(500).nullable().optional()),
  /** auto=按读模型回填；manual=手工填报；缺省：auto 指标 → auto，否则 manual */
  actualSource: z.enum(["auto", "manual"]).optional(),
});
export type GoalCreateInput = z.input<typeof goalCreateSchema>;

export const goalPatchSchema = z.object({
  targetValue: numericStr.optional(),
  direction: z.enum(GOAL_DIRECTIONS).optional(),
  note: z.preprocess(emptyToUndef, z.string().trim().max(500).nullable().optional()),
  /** 手工填报实际值：必须同时给 evidence（写入 note 尾部，审计 after.evidence） */
  actualValue: numericStr.nullable().optional(),
  evidence: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
}).refine((v) => v.actualValue === undefined || v.actualValue === null || !!v.evidence, { message: "手工填报实际值必须附证据说明" });

export interface GoalRow {
  id: number;
  deptKey: string;
  period: string;
  metricKey: string;
  metricLabel: string;
  unit: string | null;
  targetValue: string;
  direction: GoalDirection;
  actualValue: string | null;
  actualSource: "auto" | "manual" | null;
  /** auto 指标的取值状态：ok | unavailable（读模型无值）| n/a（manual） */
  autoStatus: "ok" | "unavailable" | "n/a";
  /** 达成度 %（1 位小数）；缺实际值 → null */
  attainment: string | null;
  attained: boolean | null;
  note: string | null;
  editable: boolean;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

export function canEditDept(user: SessionUser, deptKey: string): boolean {
  return user.roles.includes("admin") || user.roles.includes(deptKey);
}

/** 达成度：up → actual/target；down → target/actual；×100，1 位小数；分母 0 或缺值 → null */
export function computeAttainment(target: string, actual: string | null, direction: GoalDirection): string | null {
  if (actual == null) return null;
  const num = direction === "up" ? actual : target;
  const den = direction === "up" ? target : actual;
  if (dZero(den)) return null;
  return dMul(dDiv(num, den, 6), 100, 1);
}

export function isAttained(target: string, actual: string | null, direction: GoalDirection): boolean | null {
  if (actual == null) return null;
  return direction === "up" ? dCmp(actual, target) >= 0 : dCmp(actual, target) <= 0;
}

type Raw = typeof departmentGoals.$inferSelect;

function toRow(r: Raw, user: SessionUser): GoalRow {
  const def = METRICS[r.metricKey];
  const src = autoSourceFor(r.metricKey);
  const direction = r.direction as GoalDirection;
  return {
    id: r.id,
    deptKey: r.deptKey,
    period: r.period,
    metricKey: r.metricKey,
    metricLabel: def?.label ?? src?.label ?? r.metricKey,
    unit: def?.unit ?? null,
    targetValue: r.targetValue,
    direction,
    actualValue: r.actualValue ?? null,
    actualSource: (r.actualSource as "auto" | "manual" | null) ?? null,
    autoStatus: r.actualSource === "manual" ? "n/a" : (r.actualValue != null ? "ok" : (src ? "unavailable" : "n/a")),
    attainment: computeAttainment(r.targetValue, r.actualValue ?? null, direction),
    attained: isAttained(r.targetValue, r.actualValue ?? null, direction),
    note: r.note ?? null,
    editable: canEditDept(user, r.deptKey),
    createdBy: r.createdBy,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export interface ListGoalsArgs {
  period?: string;
  deptKey?: string;
}

export async function listGoals(args: ListGoalsArgs, user: SessionUser, dbArg?: AnyDb): Promise<{ rows: GoalRow[]; deptKeys: string[]; editableDepts: string[] }> {
  const db = dbArg ?? (await getDbAsync());
  const scope = resolveDeptScope(user, args.deptKey ?? null);
  const clauses: SQL[] = [];
  if (scope.deptKeys) clauses.push(inArray(departmentGoals.deptKey, scope.deptKeys));
  if (args.period && PERIOD_RE.test(args.period)) clauses.push(eq(departmentGoals.period, args.period));
  const rows: Raw[] = await db
    .select()
    .from(departmentGoals)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(departmentGoals.period), departmentGoals.deptKey, departmentGoals.metricKey);
  const deptKeys = scope.deptKeys ?? [...ROLES];
  return {
    rows: rows.map((r) => toRow(r, user)),
    deptKeys,
    editableDepts: deptKeys.filter((d) => canEditDept(user, d)),
  };
}

export async function getGoal(id: number, user: SessionUser, dbArg?: AnyDb): Promise<GoalRow> {
  const db = dbArg ?? (await getDbAsync());
  const [r]: Raw[] = await db.select().from(departmentGoals).where(eq(departmentGoals.id, id));
  if (!r) throw new ApiError(404, "目标不存在");
  resolveDeptScope(user, r.deptKey); // 范围外 → 403
  return toRow(r, user);
}

/* ────────────────────────── auto 实际值：从已登记读模型缓存取 ────────────────────────── */

function pickNumber(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  return null;
}

/**
 * 在读模型 payload 中按 period 找值。支持三种常见形状：
 *  A. { [period]: { field } } 或 { byPeriod / months / periods: { [period]: {...} } }
 *  B. { rows | items | series: [{ period|month|yearMonth|quarter, field }] }
 *  C. 顶层 { period|month, field } 且 period 相符；或顶层 summary/kpi 内含 field 且 payload.period 相符
 */
export function extractPeriodValue(payload: unknown, period: string, fields: readonly string[]): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const fromObj = (o: unknown): string | null => {
    if (!o || typeof o !== "object") return null;
    const rec = o as Record<string, unknown>;
    for (const f of fields) {
      const n = pickNumber(rec[f]);
      if (n != null) return n;
    }
    return null;
  };
  const direct = fromObj(p[period]);
  if (direct != null) return direct;
  for (const k of ["byPeriod", "months", "periods", "byMonth", "byQuarter"]) {
    const m = p[k];
    if (m && typeof m === "object" && !Array.isArray(m)) {
      const hit = fromObj((m as Record<string, unknown>)[period]);
      if (hit != null) return hit;
    }
  }
  for (const k of ["rows", "items", "series", "months"]) {
    const arr = p[k];
    if (Array.isArray(arr)) {
      for (const it of arr) {
        if (!it || typeof it !== "object") continue;
        const rec = it as Record<string, unknown>;
        const key = rec.period ?? rec.month ?? rec.yearMonth ?? rec.quarter;
        if (key === period) {
          const hit = fromObj(rec);
          if (hit != null) return hit;
        }
      }
    }
  }
  const top = p.period ?? p.month ?? p.yearMonth ?? p.latestMonth;
  if (top === period) {
    const hit = fromObj(p) ?? fromObj(p.summary) ?? fromObj(p.kpi);
    if (hit != null) return hit;
  }
  return null;
}

export interface AutoActual {
  value: string | null;
  sourceKey: string | null;
  builtAt: string | null;
}

/** 取某指标某期间的 auto 实际值；无缓存/无值 → value null（绝不编造） */
export async function resolveAutoActual(db: AnyDb, metricKey: string, period: string): Promise<AutoActual> {
  const src = autoSourceFor(metricKey);
  if (!src) return { value: null, sourceKey: null, builtAt: null };
  const rows: { key: string; payload: unknown; builtAt: Date }[] = await db
    .select({ key: reportReadModelCache.key, payload: reportReadModelCache.payload, builtAt: reportReadModelCache.builtAt })
    .from(reportReadModelCache)
    .where(or(...src.cacheKeyPrefixes.map((pfx) => like(reportReadModelCache.key, `${pfx}/v%`))))
    .orderBy(desc(reportReadModelCache.builtAt));
  for (const r of rows) {
    const v = extractPeriodValue(r.payload, period, src.fields);
    if (v != null) return { value: v, sourceKey: r.key, builtAt: new Date(r.builtAt).toISOString() };
  }
  return { value: null, sourceKey: rows[0]?.key ?? null, builtAt: null };
}

/* ────────────────────────── 写路径 ────────────────────────── */

export async function createGoal(raw: GoalCreateInput, user: SessionUser, dbArg?: AnyDb, opts?: { now?: Date }): Promise<GoalRow> {
  const input = goalCreateSchema.parse(raw);
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  if (!canEditDept(user, input.deptKey)) throw new ApiError(403, "只能设置本部门的目标（管理员除外）");
  const src = autoSourceFor(input.metricKey);
  if (!METRICS[input.metricKey] && !src) throw new ApiError(400, `指标 ${input.metricKey} 未在指标注册表登记`);
  const direction = input.direction ?? src?.defaultDirection ?? "up";
  const actualSource = input.actualSource ?? (src ? "auto" : "manual");
  const auto = actualSource === "auto" ? await resolveAutoActual(db, input.metricKey, input.period) : null;

  const id = await db.transaction(async (tx: AnyDb) => {
    const [ins]: { id: number }[] = await tx.insert(departmentGoals).values({
      deptKey: input.deptKey,
      period: input.period,
      metricKey: input.metricKey,
      targetValue: input.targetValue,
      direction,
      actualValue: auto?.value ?? null,
      actualSource: auto?.value != null ? "auto" : null,
      note: input.note ?? null,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: departmentGoals.id });
    await writeAudit(tx, {
      userId: user.id,
      entity: "department_goal",
      entityId: ins.id,
      action: "create",
      after: { ...input, direction, actualSource, autoValue: auto?.value ?? null, autoSourceKey: auto?.sourceKey ?? null },
    });
    return ins.id;
  });
  return getGoal(id, user, db);
}

export async function updateGoal(id: number, raw: z.input<typeof goalPatchSchema>, user: SessionUser, dbArg?: AnyDb, opts?: { now?: Date }): Promise<GoalRow> {
  const patch = goalPatchSchema.parse(raw);
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  const [existing]: Raw[] = await db.select().from(departmentGoals).where(eq(departmentGoals.id, id));
  if (!existing) throw new ApiError(404, "目标不存在");
  if (!canEditDept(user, existing.deptKey)) throw new ApiError(403, "只能修改本部门的目标（管理员除外）");

  const set: Partial<typeof departmentGoals.$inferInsert> = { updatedAt: now };
  if (patch.targetValue !== undefined) set.targetValue = patch.targetValue;
  if (patch.direction !== undefined) set.direction = patch.direction;
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.actualValue !== undefined) {
    if (patch.actualValue === null) {
      set.actualValue = null;
      set.actualSource = null;
    } else {
      set.actualValue = patch.actualValue;
      set.actualSource = "manual";
      const evidenceLine = `[证据 ${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now)}] ${patch.evidence}`;
      set.note = `${(patch.note !== undefined ? patch.note : existing.note) ?? ""}\n${evidenceLine}`.trim();
    }
  }
  await db.transaction(async (tx: AnyDb) => {
    await tx.update(departmentGoals).set(set).where(eq(departmentGoals.id, id));
    await writeAudit(tx, {
      userId: user.id,
      entity: "department_goal",
      entityId: id,
      action: "update",
      before: { targetValue: existing.targetValue, direction: existing.direction, actualValue: existing.actualValue, actualSource: existing.actualSource, note: existing.note },
      after: { ...set, evidence: patch.evidence ?? null },
    });
  });
  return getGoal(id, user, db);
}

export interface RefreshAutoSummary {
  scanned: number;
  updated: number;
  unavailable: number;
}

/**
 * 回填 auto 实际值（供任务/页面「刷新」调用）：只碰 actual_source ∈ {auto, null} 且指标可 auto 的行；
 * manual 行不覆盖。值未变不写；变了写审计 action=refresh（userId=触发人，缺省行创建人）。
 */
export async function refreshAutoActuals(dbArg?: AnyDb, opts?: { period?: string; actorId?: number; now?: Date }): Promise<RefreshAutoSummary> {
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  const clauses: SQL[] = [inArray(departmentGoals.metricKey, AUTO_METRIC_SOURCES.map((s) => s.metricKey))];
  if (opts?.period) clauses.push(eq(departmentGoals.period, opts.period));
  const rows: Raw[] = await db.select().from(departmentGoals).where(and(...clauses));
  const summary: RefreshAutoSummary = { scanned: 0, updated: 0, unavailable: 0 };
  for (const r of rows) {
    if (r.actualSource === "manual") continue;
    summary.scanned++;
    const auto = await resolveAutoActual(db, r.metricKey, r.period);
    if (auto.value == null) { summary.unavailable++; continue; }
    if (r.actualValue != null && dCmp(r.actualValue, auto.value) === 0) continue;
    await db.transaction(async (tx: AnyDb) => {
      await tx.update(departmentGoals).set({ actualValue: auto.value, actualSource: "auto", updatedAt: now }).where(eq(departmentGoals.id, r.id));
      await writeAudit(tx, {
        userId: opts?.actorId ?? r.createdBy,
        entity: "department_goal",
        entityId: r.id,
        action: "refresh",
        before: { actualValue: r.actualValue, actualSource: r.actualSource },
        after: { actualValue: auto.value, actualSource: "auto", sourceKey: auto.sourceKey, builtAt: auto.builtAt },
      });
    });
    summary.updated++;
  }
  return summary;
}

/* ────────────────────────── 第 4 屏「供应链目标」数据块 ────────────────────────── */

export function currentPeriods(now: Date): { month: string; quarter: string } {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
  const y = day.slice(0, 4);
  const m = Number(day.slice(5, 7));
  return { month: day.slice(0, 7), quarter: `${y}-Q${Math.floor((m - 1) / 3) + 1}` };
}

export interface GoalsBlock {
  generatedAt: string;
  periods: { month: string; quarter: string };
  rows: GoalRow[];
  byDept: { deptKey: string; total: number; withActual: number; attained: number; attainmentRate: string | null; editable: boolean }[];
  metricIds: readonly ["goalAttainment"];
  caliber: string;
  href: string;
}

export const GOALS_CALIBER = "达成度：越高越好 = 实际÷目标，越低越好 = 目标÷实际；auto 实际值取自已登记读模型缓存，取不到留空不编造；手工值必附证据；部门 = 角色（D61）";

/** 驾驶舱第 4 屏：本月 + 本季目标；非 admin 只见范围内部门（resolveDeptScope），但全员可见所有部门的汇总条 */
export async function getGoalsBlock(user: SessionUser, dbArg?: AnyDb, opts?: { now?: Date }): Promise<GoalsBlock> {
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  const periods = currentPeriods(now);
  const scope = resolveDeptScope(user, null);
  const clauses: SQL[] = [inArray(departmentGoals.period, [periods.month, periods.quarter])];
  if (scope.deptKeys) clauses.push(inArray(departmentGoals.deptKey, scope.deptKeys));
  const raw: Raw[] = await db.select().from(departmentGoals).where(and(...clauses)).orderBy(departmentGoals.deptKey, departmentGoals.period, departmentGoals.metricKey);
  const rows = raw.map((r) => toRow(r, user));
  const depts = scope.deptKeys ?? [...ROLES];
  const byDept = depts.map((d) => {
    const mine = rows.filter((r) => r.deptKey === d);
    const withActual = mine.filter((r) => r.actualValue != null);
    const attained = withActual.filter((r) => r.attained === true);
    return {
      deptKey: d,
      total: mine.length,
      withActual: withActual.length,
      attained: attained.length,
      attainmentRate: withActual.length ? dMul(dDiv(attained.length, withActual.length, 6), 100, 1) : null,
      editable: canEditDept(user, d),
    };
  });
  return { generatedAt: now.toISOString(), periods, rows, byDept, metricIds: ["goalAttainment"], caliber: GOALS_CALIBER, href: "/goals" };
}
