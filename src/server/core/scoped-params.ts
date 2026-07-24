/**
 * 分域参数体系（E2-02 / E8-06）——带作用域继承的参数解析器。
 *
 * 背景：阈值原先散在三处（sysParams 全局值、sku_params 每 SKU 交期、代码写死常量），
 * ABC/XYZ 九宫格算出策略却无处落参（全公司共用一个 cover_target_days）。
 * 本模块复用 sys_params 既有的 scope 列（当前只存 'global'），无需迁移即可分域。
 *
 * scope 字符串编码：`global` / `segment:AX` / `brand:12` / `sku:401`
 * 解析顺序（严格）：sku > brand > segment > global > fallback，并返回命中层级用于 UI 解释
 * （例："该 SKU 用的是 AX 分层值 30 天"）。
 * 校验复用 admin/params.ts 的 PARAM_DEFS 白名单（未登记的 key 一律拒绝）。
 */
import { eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { sysParams } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { clearParamCache } from "@/server/core/params";
import { ApiError, type SessionUser } from "@/server/modules/master/common";
import { PARAM_DEFS, type ParamDef } from "@/server/modules/admin/params";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type ParamScope =
  | { kind: "global" }
  | { kind: "segment"; cell: string } // scope 字符串 'segment:AX'
  | { kind: "brand"; brandId: number } // 'brand:12'
  | { kind: "sku"; skuId: number }; // 'sku:401'

/** 解析上下文：给什么解什么，缺项自动跳过该层 */
export interface ResolveCtx {
  skuId?: number | null;
  brandId?: number | null;
  segment?: string | null;
}

export interface ResolvedParam {
  value: number;
  /** 命中层级的 scope 字符串；未命中任何行时为 "fallback" */
  scope: string;
}

export const FALLBACK_SCOPE = "fallback";

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

function requireDef(key: string): ParamDef {
  const def = PARAM_DEFS.find((d) => d.key === key);
  if (!def) throw new ApiError(400, "未登记的参数键");
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
    if (v != null) return { value: v, scope: s };
  }
  return { value: fallback, scope: FALLBACK_SCOPE };
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

/** 写入某作用域的覆盖值（admin/pmc；复用 PARAM_DEFS 的 min/max 校验 + writeAudit） */
export async function setScopedParam(
  user: SessionUser,
  input: { key: string; scope: ParamScope; value: number },
  dbArg?: AnyDb,
): Promise<void> {
  if (!user.roles.includes("admin") && !user.roles.includes("pmc")) {
    throw new ApiError(403, "仅管理员/计划员可维护分域参数");
  }
  const def = requireDef(input.key);
  if (!Number.isFinite(input.value)) throw new ApiError(400, "参数值须为数值");
  if (input.value < def.min || input.value > def.max) {
    throw new ApiError(400, `「${def.label}」取值须在 ${def.min}–${def.max}${def.unit} 之间`);
  }
  const scope = encodeScope(input.scope);
  if (input.scope.kind === "segment" && !input.scope.cell.trim()) {
    throw new ApiError(400, "分层格不能为空");
  }

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
    entity: "sys_param_scoped",
    action: "update",
    before: { key: input.key, scope, value: old?.value ?? null },
    after: { key: input.key, scope, value: input.value },
  });
}

/** 列出某 key 的全部作用域覆盖（供管理页展示），按优先级由高到低排序 */
export async function listScopedOverrides(
  key: string,
  dbArg?: AnyDb,
): Promise<{ scope: string; value: number }[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const rows: { scope: string; value: string }[] = await db
    .select({ scope: sysParams.scope, value: sysParams.value })
    .from(sysParams)
    .where(eq(sysParams.key, key));
  const rank = (s: string): number =>
    s.startsWith("sku:") ? 0 : s.startsWith("brand:") ? 1 : s.startsWith("segment:") ? 2 : 3;
  return rows
    .map((r) => ({ scope: r.scope, value: toNum(r.value) }))
    .filter((r): r is { scope: string; value: number } => r.value != null)
    .sort((a, b) => rank(a.scope) - rank(b.scope) || a.scope.localeCompare(b.scope));
}
