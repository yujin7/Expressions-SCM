/**
 * 渠道维报表的范围落地（D62）：把页面/路由传来的「渠道 code」翻译成 channels.id，
 * 交给唯一权威 `core/data-scope.resolveChannelScope` 解析，再回给报表一个可直接下推 SQL 的形状。
 *
 * 口径：
 * - 受限用户（非 admin 且登记了 channel 范围）：未指定渠道 → 全部范围（forced）；范围内 → 单渠道（forced）；
 *   范围外或 code 不存在 → ApiError 403（不存在的 code 对受限用户同样是「他人渠道」，不暴露主档有无）。
 * - 不限用户：请求 code 原样透传给报表既有的 EXISTS(code) 过滤（不加 id 条件，保证无筛选时逐字等价）。
 * - `scopeLabel` 只在 forced 时给出（渠道名顿号连接），页面据此把渠道选择器改成只读标签。
 * - 本模块只解析、不裁剪；各报表用 `channelScopeCondition` 把 id 集合下推到 sales_monthly.channel_id。
 */
import { inArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { channels } from "@/db/schema";
import { resolveChannelScope, type ScopeUser } from "@/server/core/data-scope";
import { ApiError } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface ResolvedChannelScope {
  /** null = 不限；forced 时为受限用户允许的渠道 id（已排序去重）；不限用户带 code 时为 [该渠道 id] */
  channelIds: number[] | null;
  /** true = 范围由用户的受限记录强制施加（页面把渠道选择器改只读标签） */
  forced: boolean;
  /** forced 时的范围标签（渠道名顿号连接）；不限 = null */
  scopeLabel: string | null;
  /** 回显的渠道 code（合法请求时）；受限用户未指定时为 null */
  channelCode: string | null;
}

export const UNRESTRICTED_SCOPE: ResolvedChannelScope = { channelIds: null, forced: false, scopeLabel: null, channelCode: null };

/** 受限判定与 core/data-scope 同口径：admin 或无范围记录 = 不限 */
export function isChannelRestricted(user: ScopeUser | undefined): boolean {
  if (!user) return false;
  if (user.roles.includes("admin")) return false;
  return user.channelScope != null;
}

export async function resolveChannelScopeByCode(
  db: AnyDb,
  user: ScopeUser | undefined,
  requestedCode?: string | null,
): Promise<ResolvedChannelScope> {
  const code = requestedCode?.trim() || null;
  const restricted = isChannelRestricted(user);
  if (!restricted && code === null) return UNRESTRICTED_SCOPE;
  const rows: { id: number; code: string; name: string }[] = await db
    .select({ id: channels.id, code: channels.code, name: channels.name })
    .from(channels);
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const requested = code === null ? null : byCode.get(code) ?? null;
  if (code !== null && requested === null) {
    // 不存在的 code：受限用户一律 403（不泄露主档有无）；不限用户保持既有 EXISTS(code) 行为（筛出 0 行）
    if (restricted) throw new ApiError(403, "无权访问该渠道的数据");
    return { channelIds: null, forced: false, scopeLabel: null, channelCode: code };
  }
  const scope = resolveChannelScope(user ?? { roles: [] }, requested?.id ?? null);
  const scopeLabel = scope.forced && scope.channelIds
    ? scope.channelIds.map((id) => byId.get(id)?.name ?? `渠道#${id}`).join("、")
    : null;
  return { channelIds: scope.channelIds, forced: scope.forced, scopeLabel, channelCode: code };
}

/**
 * 下推 SQL 的条件：只有 forced（受限）时才追加 `channel_id IN (...)`；
 * 不限用户的自选渠道仍走各报表原有的 EXISTS(code) 过滤，保证无筛选时逐字等价。
 */
export function channelScopeCondition(column: PgColumn, scope: ResolvedChannelScope): SQL | undefined {
  if (!scope.forced || !scope.channelIds) return undefined;
  return inArray(column, scope.channelIds);
}
