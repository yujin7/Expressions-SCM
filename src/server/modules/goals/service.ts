/**
 * D61 部门目标（department_goals，dept_key=角色）。
 *
 *  - 写路径：create / update 同事务 writeAudit(entity="department_goal")；
 *    编辑权 = admin 或 本部门（user.roles ∋ deptKey）；其他部门只读。
 *  - 读：全员可见全部部门（页面按部门 Tab，本部门可编辑）；D62 受限用户（deptScope 非空）只见范围内部门。
 *  - actual_source=auto：从**已登记读模型缓存**（report_read_model_cache）按**真实缓存键 + 真实 payload 路径**取值
 *      （键与路径见 AUTO_METRIC_SOURCES；键常量直接引用各读模型模块，口径升版 /vN 时随之变更，不再前缀猜测）：
 *      库存占比 inventorySalesRatio / 周转 turns / DIO dio / 账期达成率 paymentTermAttainment /
 *      账期类采购额占比 creditTermSpendShare / OTIF onTimeRate / 销量一致率 salesConsistencyPct /
 *      平台身份覆盖率 platformIdentityCoverage（分子÷分母）/ 降本额 costSavingYtd；
 *      取不到留 null（绝不编造），并在 DTO 里给出 autoStatus=unavailable 说明。
 *  - 达成度 goalAttainment：up = actual ÷ target；down = target ÷ actual；×100 保留 1 位（core/decimal，不用 float 运算）。
 */
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
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
import { DATA_QUALITY_CACHE_KEY } from "@/server/modules/report/data-quality";
import { EXTERNAL_VELOCITY_CACHE_KEY } from "@/server/modules/report/external-velocity";
import { INVENTORY_SALES_RATIO_CACHE_KEY } from "@/server/modules/report/inventory-sales-ratio";
import { PURCHASE_ORDER_METRICS_KEY } from "@/server/modules/report/purchase-order-metrics";
import { SUPPLIER_PAYMENT_TERM_KEY } from "@/server/modules/report/supplier-payment-term";
import { warehouseInventoryCacheKey } from "@/server/modules/report/warehouse-inventory";

export const GOAL_DIRECTIONS = ["up", "down"] as const;
export type GoalDirection = (typeof GOAL_DIRECTIONS)[number];
export const PERIOD_RE = /^(\d{4}-(0[1-9]|1[0-2])|\d{4}-Q[1-4])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 读模型 payload 取值路径：点分段；数组段写 `rows[yearMonth=$period]`（取 yearMonth 等于期间的那一行），
 * `$period` 在取值时替换为目标期间。
 */
export interface AutoMetricPath {
  path: string;
  /** 仅当期间是月份 / 季度时启用；缺省两者皆可 */
  when?: "month" | "quarter";
  /** payload 顶层该字段必须等于期间年份（年度口径读模型防串年）；缺省不校验 */
  periodYearField?: string;
  /** 读模型存 0–1 比例时 ×100 折成百分比（与 METRICS unit=pct 对齐） */
  scale?: 100;
  /**
   * 季度期间按"季内最新有值的月份"取值：path 里的 `$period` 依次替换为该季 3 个月（从后往前），命中即返回。
   * 月末口径指标（库存占比）用它，避免把"最新月"当成任意季度的实际值。
   */
  quarterMonths?: "latest";
  /**
   * 比率指标：payload 只有分子/分母而没有现成比例时，用 `path ÷ divideBy`（分母路径同语法）；
   * 分母取不到或为 0 → 该路径不命中（不编造）。与 scale 叠加时先除后乘。
   */
  divideBy?: string;
}

export interface AutoMetricSource {
  metricKey: string;
  label: string;
  /** report_read_model_cache.key（精确匹配，引用读模型模块导出的常量） */
  cacheKey: string;
  /** 依次尝试的取值路径，首个命中即用 */
  paths: readonly AutoMetricPath[];
  defaultDirection: GoalDirection;
}

export const AUTO_METRIC_SOURCES: readonly AutoMetricSource[] = [
  {
    metricKey: "inventorySalesRatio",
    label: "库存占比",
    cacheKey: INVENTORY_SALES_RATIO_CACHE_KEY,
    // InventorySalesRatioReadModel：rows[].{yearMonth, ratioMonthEndPct}（已是百分比）；current = 最新月
    paths: [
      { path: "rows[yearMonth=$period].ratioMonthEndPct", when: "month" },
      // 季度 = 该季内最新有值月份的月末占比（审阅修复：原来读 current 会把最新月填给任意季度）
      { path: "rows[yearMonth=$period].ratioMonthEndPct", when: "quarter", quarterMonths: "latest" },
    ],
    defaultDirection: "down",
  },
  {
    metricKey: "turns",
    label: "库存周转次数",
    cacheKey: warehouseInventoryCacheKey(90),
    // WarehouseInventoryModel.summary.turns（滚动窗口、非期间口径：取最新一次构建）
    paths: [{ path: "summary.turns" }],
    defaultDirection: "up",
  },
  {
    metricKey: "dio",
    label: "库存周转天数 DIO",
    cacheKey: warehouseInventoryCacheKey(90),
    paths: [{ path: "summary.dio" }],
    defaultDirection: "down",
  },
  {
    metricKey: "paymentTermAttainment",
    label: "账期达成率",
    cacheKey: SUPPLIER_PAYMENT_TERM_KEY,
    // SupplierPaymentTermModel.summary.attainmentRate 为 0–1 比例；payload.year 必须等于期间年份
    paths: [{ path: "summary.attainmentRate", periodYearField: "year", scale: 100 }],
    defaultDirection: "up",
  },
  {
    metricKey: "creditTermSpendShare",
    label: "账期类采购额占比",
    cacheKey: SUPPLIER_PAYMENT_TERM_KEY,
    // summary.creditTermSpendSharePct 已是百分比字符串
    paths: [{ path: "summary.creditTermSpendSharePct", periodYearField: "year" }],
    defaultDirection: "up",
  },
  {
    metricKey: "onTimeRate",
    label: "OTIF 准时交付率",
    cacheKey: PURCHASE_ORDER_METRICS_KEY,
    // PurchaseOrderMetrics.summary.otif.rate 为 0–1 比例（年度累计）；payload.year 必须等于期间年份
    paths: [{ path: "summary.otif.rate", periodYearField: "year", scale: 100 }],
    defaultDirection: "up",
  },
  /* ── BI 深化补入（路径均按读模型 TypeScript 类型核对） ── */
  {
    metricKey: "salesConsistencyPct",
    label: "销量口径一致率",
    cacheKey: DATA_QUALITY_CACHE_KEY,
    // DataQualityReport.salesConsistency.consistencyPct 已是百分比（null = 不足）
    paths: [{ path: "salesConsistency.consistencyPct" }],
    defaultDirection: "up",
  },
  {
    metricKey: "platformIdentityCoverage",
    label: "平台身份覆盖率",
    cacheKey: EXTERNAL_VELOCITY_CACHE_KEY,
    // ExternalVelocity.coverage.{mappedPlatformSkus, platformSkus} 只有分子/分母：÷ 后 ×100 折百分比
    paths: [{ path: "coverage.mappedPlatformSkus", divideBy: "coverage.platformSkus", scale: 100 }],
    defaultDirection: "up",
  },
  {
    metricKey: "costSavingYtd",
    label: "降本额（YTD）",
    cacheKey: PURCHASE_ORDER_METRICS_KEY,
    // PurchaseOrderMetrics.summary.costSaving.savingYtd（scale 2 金额字符串，年度累计）；payload.year 防串年
    paths: [{ path: "summary.costSaving.savingYtd", periodYearField: "year" }],
    defaultDirection: "up",
  },
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

const PATH_SEG_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([A-Za-z_][A-Za-z0-9_]*)=([^\]]+)\])?$/;

/**
 * 按路径在 payload 中取数值（字符串形式）。路径段：`name` 取对象字段；`name[field=$period]` 取数组中
 * field 等于期间的元素。任一段取不到 / 非数值 → null（不猜别名、不回退）。
 */
export function readPayloadPath(payload: unknown, path: string, period: string): string | null {
  let cur: unknown = payload;
  for (const seg of path.split(".")) {
    const m = PATH_SEG_RE.exec(seg);
    if (!m || !cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[m[1]];
    if (m[2]) {
      if (!Array.isArray(cur)) return null;
      const want = m[3].replace("$period", period);
      cur = cur.find((it) => it && typeof it === "object" && String((it as Record<string, unknown>)[m[2]]) === want);
    }
  }
  return pickNumber(cur);
}

/** 'YYYY-Qn' → 该季 3 个月（升序）；非季度格式 → [] */
export function quarterMonthsOf(period: string): string[] {
  const m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!m) return [];
  const start = (Number(m[2]) - 1) * 3 + 1;
  return [0, 1, 2].map((i) => `${m[1]}-${String(start + i).padStart(2, "0")}`);
}

/** 按 AutoMetricSource 的路径表取某期间的值：when / periodYearField 不满足即跳过该路径；scale=100 折百分比 */
export function extractAutoValue(payload: unknown, period: string, paths: readonly AutoMetricPath[]): { value: string; path: string } | null {
  const isMonth = MONTH_RE.test(period);
  const year = period.slice(0, 4);
  for (const p of paths) {
    if (p.when === "month" && !isMonth) continue;
    if (p.when === "quarter" && isMonth) continue;
    if (p.periodYearField) {
      const y = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[p.periodYearField] : undefined;
      if (String(y) !== year) continue;
    }
    const periods = p.quarterMonths === "latest" && !isMonth ? quarterMonthsOf(period).reverse() : [period];
    for (const per of periods) {
      let raw = readPayloadPath(payload, p.path, per);
      if (raw == null) continue;
      let pathUsed = p.path;
      if (p.divideBy) {
        const den = readPayloadPath(payload, p.divideBy, per);
        if (den == null || dZero(den)) continue;
        raw = dDiv(raw, den, 6);
        pathUsed = `${p.path}÷${p.divideBy}`;
      }
      return { value: p.scale ? dMul(raw, p.scale, 4) : raw, path: per === period ? pathUsed : pathUsed.replace(/\$period/g, per) };
    }
  }
  return null;
}

export interface AutoActual {
  value: string | null;
  sourceKey: string | null;
  /** 命中的 payload 路径（审计留痕） */
  path: string | null;
  builtAt: string | null;
}

/** 触发人可回填的部门：admin 全部（undefined）；其他 = 自己角色 ∩ D62 数据范围 */
export function refreshableDeptKeys(user: SessionUser): readonly string[] | undefined {
  if (user.roles.includes("admin")) return undefined;
  return user.roles.filter((r) => {
    if (!(ROLES as readonly string[]).includes(r)) return false;
    try { resolveDeptScope(user, r); return true; } catch { return false; }
  });
}

/** 取某指标某期间的 auto 实际值；无缓存/无值 → value null（绝不编造，sourceKey 仍给出以便排查） */
export async function resolveAutoActual(db: AnyDb, metricKey: string, period: string): Promise<AutoActual> {
  const src = autoSourceFor(metricKey);
  if (!src) return { value: null, sourceKey: null, path: null, builtAt: null };
  const rows: { key: string; payload: unknown; builtAt: Date }[] = await db
    .select({ key: reportReadModelCache.key, payload: reportReadModelCache.payload, builtAt: reportReadModelCache.builtAt })
    .from(reportReadModelCache)
    .where(eq(reportReadModelCache.key, src.cacheKey))
    .orderBy(desc(reportReadModelCache.builtAt))
    .limit(1);
  const r = rows[0];
  if (!r) return { value: null, sourceKey: null, path: null, builtAt: null };
  const hit = extractAutoValue(r.payload, period, src.paths);
  if (!hit) return { value: null, sourceKey: r.key, path: null, builtAt: new Date(r.builtAt).toISOString() };
  return { value: hit.value, sourceKey: r.key, path: hit.path, builtAt: new Date(r.builtAt).toISOString() };
}

/* ────────────────────────── 写路径 ────────────────────────── */

export async function createGoal(raw: GoalCreateInput, user: SessionUser, dbArg?: AnyDb, opts?: { now?: Date }): Promise<GoalRow> {
  const input = goalCreateSchema.parse(raw);
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  if (!canEditDept(user, input.deptKey)) throw new ApiError(403, "只能设置本部门的目标（管理员除外）");
  resolveDeptScope(user, input.deptKey); // D62 受限用户：写路径与读路径同一范围裁剪（范围外 403，且不落库）
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
      // 显式声明 manual 必须落库为 manual（待附证据登记），否则 refreshAutoActuals 会把它当 auto 行覆盖（审阅修复）；
      // 未声明时保持原语义：取到 auto 值 → auto，否则 null（待填）
      actualSource: input.actualSource === "manual" ? "manual" : auto?.value != null ? "auto" : null,
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
      after: { ...input, direction, actualSource, autoValue: auto?.value ?? null, autoSourceKey: auto?.sourceKey ?? null, autoPath: auto?.path ?? null },
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
  resolveDeptScope(user, existing.deptKey);

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
export async function refreshAutoActuals(
  dbArg?: AnyDb,
  opts?: { period?: string; actorId?: number; now?: Date; /** 只回填这些部门（页面刷新按触发人可编辑部门限定；任务缺省全部） */ deptKeys?: readonly string[] },
): Promise<RefreshAutoSummary> {
  const db = dbArg ?? (await getDbAsync());
  const now = opts?.now ?? new Date();
  const clauses: SQL[] = [inArray(departmentGoals.metricKey, AUTO_METRIC_SOURCES.map((s) => s.metricKey))];
  if (opts?.period) clauses.push(eq(departmentGoals.period, opts.period));
  if (opts?.deptKeys) {
    if (!opts.deptKeys.length) return { scanned: 0, updated: 0, unavailable: 0 };
    clauses.push(inArray(departmentGoals.deptKey, [...opts.deptKeys]));
  }
  const rows: Raw[] = await db.select().from(departmentGoals).where(and(...clauses));
  const summary: RefreshAutoSummary = { scanned: 0, updated: 0, unavailable: 0 };
  // 同一 (metricKey, period) 只解析一次：读模型 payload 可达数百 KB，逐行重读是纯浪费
  const memo = new Map<string, Promise<AutoActual>>();
  for (const r of rows) {
    if (r.actualSource === "manual") continue;
    summary.scanned++;
    const memoKey = `${r.metricKey}|${r.period}`;
    let pending = memo.get(memoKey);
    if (!pending) { pending = resolveAutoActual(db, r.metricKey, r.period); memo.set(memoKey, pending); }
    const auto = await pending;
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
        after: { actualValue: auto.value, actualSource: "auto", sourceKey: auto.sourceKey, path: auto.path, builtAt: auto.builtAt },
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
