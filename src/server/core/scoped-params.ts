/**
 * 分域参数体系（E2-02 / E8-06）——带作用域继承的参数解析器。
 *
 * 背景：阈值原先散在三处（sysParams 全局值、sku_params 每 SKU 交期、代码写死常量），
 * ABC/XYZ 九宫格算出策略却无处落参（全公司共用一个 cover_target_days）。
 * 本模块复用 sys_params 既有的 scope 列（当前只存 'global'），无需迁移即可分域。
 *
 * scope 字符串编码：`global` / `segment:AX` / `brand:12` / `sku:401` / `category:packaging`
 * 解析顺序（严格）：sku > brand > segment > global > fallback，并返回命中层级用于 UI 解释
 * （例："该 SKU 用的是 AX 分层值 30 天"）。
 * `category:*` 只服务于 `scope: "category"` 的参数（R2 损耗率，结算直接按品类行读），不参与上述继承链。
 * 校验复用 core/param-defs 的 PARAM_DEFS 白名单（未登记的 key 一律拒绝）。
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { sysParams } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { clearParamCache } from "@/server/core/params";
import { PARAM_CATEGORY_OPTIONS, PMC_WRITABLE_PARAM_KEYS, paramDef, type NumParamDef } from "@/server/core/param-defs";
import { ApiError, type SessionUser } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export type ParamScope =
  | { kind: "global" }
  | { kind: "segment"; cell: string } // scope 字符串 'segment:AX'
  | { kind: "brand"; brandId: number } // 'brand:12'
  | { kind: "sku"; skuId: number } // 'sku:401'
  | { kind: "category"; category: string }; // 'category:packaging'（仅 scope=category 的参数）

/** 解析上下文：给什么解什么，缺项自动跳过该层 */
export interface ResolveCtx {
  skuId?: number | null;
  brandId?: number | null;
  segment?: string | null;
}

/** 命中层级（机器可读）——UI/读模型据此解释「这个数来自哪一层」，不必再解析 scope 串 */
export type ParamLayer = "sku" | "brand" | "segment" | "global" | "fallback";

export interface ResolvedParam {
  value: number;
  /** 命中层级的 scope 字符串；未命中任何行时为 "fallback" */
  scope: string;
  /** 命中层级枚举（由 scope 串推导，供调用方直接落到行上而不再各自 split） */
  layer: ParamLayer;
}

export const FALLBACK_SCOPE = "fallback";

/** 品类损耗率允许的品类（与 skus.lossCategory 同域）；唯一权威在 core/param-defs（页面也读同一份） */
export const PARAM_CATEGORY_SCOPES: readonly string[] = PARAM_CATEGORY_OPTIONS.map((o) => o.value);

/** scope 串 → 层级枚举（唯一推导处；未知前缀按 fallback 处理，绝不猜） */
export function scopeLayer(scope: string): ParamLayer {
  if (scope === "global") return "global";
  const kind = scope.split(":")[0];
  if (kind === "sku" || kind === "brand" || kind === "segment") return kind;
  return "fallback";
}

/** scope 对象 → 字符串（写库用） */
export function encodeScope(s: ParamScope): string {
  switch (s.kind) {
    case "global":
      return "global";
    case "segment":
      return `segment:${s.cell.trim().toUpperCase()}`;
    case "brand":
      return `brand:${s.brandId}`;
    case "sku":
      return `sku:${s.skuId}`;
    case "category":
      return `category:${s.category.trim().toLowerCase()}`;
  }
}

/** 中文层级名（供 UI 解释命中来源） */
export function describeScope(scope: string): string {
  if (scope === FALLBACK_SCOPE) return "系统缺省";
  if (scope === "global") return "全局";
  const [kind, rest] = scope.split(":");
  if (kind === "segment") return `${rest} 分层`;
  if (kind === "brand") return `品牌#${rest}`;
  if (kind === "sku") return `SKU#${rest}`;
  if (kind === "category") return `品类 ${rest === "raw" ? "原料" : rest === "packaging" ? "包材" : rest}`;
  return scope;
}

/** ctx → 按优先级排列的候选 scope 串（sku → brand → segment → global） */
function candidateScopes(ctx: ResolveCtx): string[] {
  const out: string[] = [];
  if (ctx.skuId != null) out.push(`sku:${ctx.skuId}`);
  if (ctx.brandId != null) out.push(`brand:${ctx.brandId}`);
  const seg = (ctx.segment ?? "").trim().toUpperCase();
  if (seg) out.push(`segment:${seg}`);
  out.push("global");
  return out;
}

function toNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 分域只对数值参数有意义（枚举开关如 tier_basis 是全局口径开关，不分域） */
function requireDef(key: string): NumParamDef {
  const def = paramDef(key);
  if (!def) throw new ApiError(400, "未登记的参数键");
  if (def.kind !== "number") throw new ApiError(400, `「${def.label}」是枚举开关，不支持分域覆盖`);
  return def;
}

/* ── 进程内缓存：key → (scope → value)，60s，与 core/params 同节奏；传 dbArg 时旁路 ── */
const scopedCache = new Map<string, { rows: Map<string, number>; exp: number }>();

export function clearScopedParamCache(): void {
  scopedCache.clear();
}

async function loadScopeMap(key: string, dbArg?: AnyDb): Promise<Map<string, number>> {
  if (!dbArg) {
    const hit = scopedCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.rows;
  }
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const rows: { scope: string; value: string }[] = await db
    .select({ scope: sysParams.scope, value: sysParams.value })
    .from(sysParams)
    .where(eq(sysParams.key, key));
  const map = new Map<string, number>();
  for (const r of rows) {
    const n = toNum(r.value);
    if (n != null) map.set(r.scope, n);
  }
  if (!dbArg) scopedCache.set(key, { rows: map, exp: Date.now() + 60_000 });
  return map;
}

function pick(map: Map<string, number>, fallback: number, ctx: ResolveCtx): ResolvedParam {
  for (const s of candidateScopes(ctx)) {
    const v = map.get(s);
    if (v != null) return { value: v, scope: s, layer: scopeLayer(s) };
  }
  return { value: fallback, scope: FALLBACK_SCOPE, layer: "fallback" };
}

/**
 * 逐级解析：sku > brand > segment > global > fallback。
 * 返回值与命中层级（可解释）。
 */
export async function resolveNumParam(
  key: string,
  fallback: number,
  ctx: ResolveCtx,
  dbArg?: AnyDb,
): Promise<ResolvedParam> {
  const map = await loadScopeMap(key, dbArg);
  return pick(map, fallback, ctx);
}

/**
 * 批量解析（避免 N+1）：一次取回该 key 的所有 scope 行，在内存中按 ctx 逐个解析。
 * 用法：const r = await makeResolver("cover_target_days", 45); rows.map((x) => r(x));
 */
export async function makeResolver(
  key: string,
  fallback: number,
  dbArg?: AnyDb,
): Promise<(ctx: ResolveCtx) => ResolvedParam> {
  const map = await loadScopeMap(key, dbArg);
  return (ctx: ResolveCtx) => pick(map, fallback, ctx);
}

/** scope 形状校验（先于 encodeScope 调用，保证参数错误是 400 而不是 500） */
function assertScopeShape(scope: ParamScope): void {
  switch (scope.kind) {
    case "global":
      return;
    case "segment":
      if (typeof scope.cell !== "string" || !scope.cell.trim()) throw new ApiError(400, "分层格不能为空");
      return;
    case "brand":
      if (!Number.isInteger(scope.brandId) || scope.brandId <= 0) throw new ApiError(400, "brandId 须为正整数");
      return;
    case "sku":
      if (!Number.isInteger(scope.skuId) || scope.skuId <= 0) throw new ApiError(400, "skuId 须为正整数");
      return;
    case "category":
      if (typeof scope.category !== "string" || !PARAM_CATEGORY_SCOPES.includes(scope.category.trim().toLowerCase())) {
        throw new ApiError(400, `品类只能是 ${PARAM_CATEGORY_SCOPES.join(" / ")}`);
      }
      return;
    default:
      throw new ApiError(400, `未知的 scope.kind：${String((scope as { kind?: unknown }).kind)}`);
  }
}

/**
 * 参数层级与 scope 的匹配：`scope: "category"` 的参数只能写 category 行；
 * 其余参数不能写 category 行（结算不会读，写了只会误导）。
 */
function assertScopeAllowedForDef(def: NumParamDef, scope: ParamScope): void {
  const categoryParam = def.scope === "category";
  if (categoryParam && scope.kind !== "category") {
    throw new ApiError(400, `「${def.label}」只按品类维护（category:raw / category:packaging）`);
  }
  if (!categoryParam && scope.kind === "category") {
    throw new ApiError(400, `「${def.label}」不按品类维护；品类层只对损耗率等品类参数有效`);
  }
}

function assertScopedWriter(user: SessionUser, def: NumParamDef): void {
  if (!user.roles.includes("admin") && !user.roles.includes("pmc")) {
    throw new ApiError(403, "仅管理员/计划员可维护分域参数");
  }
  /* 品类参数（损耗率）直接进结算扣款金额——与全局层同样只允许管理员，不因为换了一层就放宽 */
  if (def.scope === "category" && !user.roles.includes("admin") && !PMC_WRITABLE_PARAM_KEYS.includes(def.key)) {
    throw new ApiError(403, `「${def.label}」影响结算金额，仅管理员可改`);
  }
}

/** 写入某作用域的覆盖值（admin/pmc；复用 PARAM_DEFS 的 min/max 校验 + writeAudit） */
export async function setScopedParam(
  user: SessionUser,
  input: { key: string; scope: ParamScope; value: number },
  dbArg?: AnyDb,
): Promise<void> {
  if (!user.roles.includes("admin") && !user.roles.includes("pmc")) {
    throw new ApiError(403, "仅管理员/计划员可维护分域参数");
  }
  /* **global 层不走这条路**（2026-07-26 红队实证的提权口子）。
     global 行与 admin/params.ts 的 updateParam 落在同一个唯一键 (scope,key) 上，
     而那条路径是 admin-only。本函数放行 pmc，于是 pmc 一个请求就能改写
     比价硬门 / 超收容差 / 让步价率 / D33 自动链开关这些 admin-only 的全局参数——
     实测 pmc01 对 /api/admin/params 得 403，对本路径同 key 得 201 并真的改掉了值。
     分域参数只管 sku/brand/segment/category 层；global 一律回 admin 专用路径。 */
  if (input.scope.kind === "global" && !user.roles.includes("admin")) {
    throw new ApiError(403, "全局参数仅管理员可改，请走「运行参数」页（/api/admin/params）");
  }
  const def = requireDef(input.key);
  assertScopedWriter(user, def);
  if (!Number.isFinite(input.value)) throw new ApiError(400, "参数值须为数值");
  if (input.value < def.min || input.value > def.max) {
    throw new ApiError(400, `「${def.label}」取值须在 ${def.min}–${def.max}${def.unit} 之间`);
  }
  /* 形状校验必须**先于** encodeScope：否则畸形 scope 会在 encodeScope 里抛 TypeError，
     把「用户参数写错」变成 500 并污染 error_logs（本仓反复出现的缺陷类）。 */
  assertScopeShape(input.scope);
  if (input.scope.kind !== "global") assertScopeAllowedForDef(def, input.scope);
  const scope = encodeScope(input.scope);

  const db: AnyDb = dbArg ?? (await getDbAsync());
  const before = (await db
    .select({ scope: sysParams.scope, key: sysParams.key, value: sysParams.value })
    .from(sysParams)
    .where(eq(sysParams.key, input.key))) as { scope: string; key: string; value: string }[];
  const old = before.find((r) => r.scope === scope);

  await db
    .insert(sysParams)
    .values({ scope, key: input.key, value: String(input.value), note: `${def.label}（${describeScope(scope)}）` })
    .onConflictDoUpdate({ target: [sysParams.scope, sysParams.key], set: { value: String(input.value) } });

  clearScopedParamCache();
  clearParamCache(); // global 层与 core/params 共用同一批行，一并失效
  await writeAudit(db, {
    userId: user.id,
    // global 行与 admin/params 写的是同一行，审计 entity 必须一致，
    // 否则运行参数页（只读 entity="sys_param"）的「最近修改人/时间」会停留在上一次 admin 的记录
    entity: input.scope.kind === "global" ? "sys_param" : "sys_param_scoped",
    action: "update",
    before: { key: input.key, scope, value: old?.value ?? null },
    after: { key: input.key, scope, value: input.value },
  });
}

/**
 * 移除某个作用域的覆盖，回落到上一级（sku→brand→segment→global→系统缺省）。
 *
 * 必须有这个：一个**设得上却撤不掉**的覆盖是陷阱——业务试设一次分层参数后
 * 无法回退，只能带着一个自己也解释不清的数字继续跑，而它正驱动补货建议量。
 * global 层不允许在此删除（它是兜底底座，改值走 admin/params 的 updateParam）。
 */
export async function clearScopedParam(
  user: SessionUser,
  input: { key: string; scope: ParamScope },
  dbArg?: AnyDb,
): Promise<void> {
  if (!user.roles.includes("admin") && !user.roles.includes("pmc")) {
    throw new ApiError(403, "仅管理员/计划员可维护分域参数");
  }
  const def = requireDef(input.key);
  assertScopedWriter(user, def);
  if (input.scope.kind === "global") throw new ApiError(400, "全局层不可删除，请直接改值");
  assertScopeShape(input.scope);
  const scope = encodeScope(input.scope);

  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [old] = (await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.key, input.key), eq(sysParams.scope, scope)))) as { value: string }[];
  if (!old) throw new ApiError(404, "该作用域没有覆盖值");

  await db.delete(sysParams).where(and(eq(sysParams.key, input.key), eq(sysParams.scope, scope)));
  clearScopedParamCache();
  clearParamCache();
  await writeAudit(db, {
    userId: user.id,
    entity: "sys_param_scoped",
    action: "delete",
    before: { key: input.key, scope, value: old.value },
    after: { key: input.key, scope, value: null },
  });
}

export interface ScopedOverrideRow {
  scope: string;
  /** scope 前缀（sku/brand/segment/category/global） */
  kind: string;
  /** 目标标识（SKU 编码 / 品牌名 / 分层格 / 品类） */
  target: string;
  /** 中文描述（describeScope） */
  label: string;
  value: number;
  lastChangedBy: string | null;
  lastChangedAt: string | null;
}

/** 列出某 key 的全部作用域覆盖（供管理页展示），按优先级由高到低排序；附最近修改人/时间与目标名称 */
export async function listScopedOverrides(
  key: string,
  dbArg?: AnyDb,
): Promise<ScopedOverrideRow[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const rows: { scope: string; value: string }[] = await db
    .select({ scope: sysParams.scope, value: sysParams.value })
    .from(sysParams)
    .where(eq(sysParams.key, key));
  const rank = (s: string): number =>
    s.startsWith("sku:") ? 0 : s.startsWith("brand:") ? 1 : s.startsWith("segment:") ? 2 : s.startsWith("category:") ? 3 : 4;
  const overrides = rows
    .map((r) => ({ scope: r.scope, value: toNum(r.value) }))
    .filter((r): r is { scope: string; value: number } => r.value != null && r.scope !== "global")
    .sort((a, b) => rank(a.scope) - rank(b.scope) || a.scope.localeCompare(b.scope));
  if (overrides.length === 0) return [];

  /* 目标名称：SKU 编码 / 品牌名（只查用到的 id） */
  const skuIds = overrides.filter((o) => o.scope.startsWith("sku:")).map((o) => Number(o.scope.slice(4))).filter((n) => Number.isInteger(n) && n > 0);
  const brandIds = overrides.filter((o) => o.scope.startsWith("brand:")).map((o) => Number(o.scope.slice(6))).filter((n) => Number.isInteger(n) && n > 0);
  const skuName = new Map<number, string>();
  const brandName = new Map<number, string>();
  if (skuIds.length > 0) {
    const skuRows: { id: number; code: string; name: string }[] = await db.select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name }).from(schema.skus).where(inArray(schema.skus.id, skuIds));
    for (const s of skuRows) skuName.set(s.id, `${s.code} ${s.name}`);
  }
  if (brandIds.length > 0) {
    const brandRows: { id: number; code: string; nameCn: string }[] = await db.select({ id: schema.brands.id, code: schema.brands.code, nameCn: schema.brands.nameCn }).from(schema.brands).where(inArray(schema.brands.id, brandIds));
    for (const b of brandRows) brandName.set(b.id, `${b.code} ${b.nameCn}`);
  }

  /* 最近修改人/时间：audit_logs entity=sys_param_scoped，按 (key, scope) 取最新一条 */
  const auditRows: { after: unknown; createdAt: Date; name: string | null }[] = await db
    .select({ after: schema.auditLogs.after, createdAt: schema.auditLogs.createdAt, name: schema.users.name })
    .from(schema.auditLogs)
    .leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
    .where(eq(schema.auditLogs.entity, "sys_param_scoped"))
    .orderBy(desc(schema.auditLogs.id));
  const lastByScope = new Map<string, { by: string | null; at: string }>();
  for (const a of auditRows) {
    const after = a.after as { key?: string; scope?: string } | null;
    if (after?.key !== key || !after.scope || lastByScope.has(after.scope)) continue;
    lastByScope.set(after.scope, { by: a.name, at: a.createdAt.toISOString().slice(0, 16).replace("T", " ") });
  }

  return overrides.map((o) => {
    const [kind, rest = ""] = o.scope.split(":");
    const target = kind === "sku"
      ? (skuName.get(Number(rest)) ?? `SKU#${rest}`)
      : kind === "brand"
        ? (brandName.get(Number(rest)) ?? `品牌#${rest}`)
        : rest;
    const last = lastByScope.get(o.scope);
    return { scope: o.scope, kind, target, label: describeScope(o.scope), value: o.value, lastChangedBy: last?.by ?? null, lastChangedAt: last?.at ?? null };
  });
}
