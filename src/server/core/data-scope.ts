/**
 * 数据范围（D62）：user_data_scopes(scope_kind channel|dept, target_id) 的加载与解析。
 *
 * 口径：
 * - admin 不受限；**无范围记录 = null = 不限**（受限只发生在明确登记了范围的用户身上，沿用 ops 角色）。
 * - 渠道粒度 = channels 主档 id；店铺→渠道映射走 aliases(aliasType=channel, scope=JIANDAOYUN)，不在本模块。
 * - 部门先=角色（D61）：`target_id` 存 `ROLES` 枚举索引（表列为 integer），对外一律以 dept_key（角色码）出现。
 * - 受限用户请求范围外的渠道 → ApiError 403；范围内 → 单渠道并标记 forced。
 * - 本波只提供解析/过滤原语，页面按 route-access.scopedMode 接入是下一波（不改任何页面数据过滤）。
 *
 * 用法（读路径）：
 *   const scope = resolveChannelScope(user, params.channelId);       // { channelIds: number[] | null, forced }
 *   const rows = filterRowsByChannelScope(all, (r) => r.channelId, scope);
 *   // 或把 scope.channelIds 直接下推到 SQL：inArray(t.channelId, scope.channelIds)
 */
import { eq } from "drizzle-orm";
import { userDataScopes } from "@/db/schema";
import { ROLES } from "@/server/core/constants";
import { ApiError } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export const SCOPE_KINDS = ["channel", "dept"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** 解析所需的最小用户形状（SessionUser 的子集；undefined 视为未加载 = 不限，仅限直接调 service 的后台/测试路径） */
export interface ScopeUser {
  roles: readonly string[];
  channelScope?: readonly number[] | null;
  deptScope?: readonly string[] | null;
}

export interface ChannelScope {
  /** null = 不限；否则为允许的渠道 id 集合（已排序去重） */
  channelIds: number[] | null;
  /** true = 范围由用户的受限记录强制施加（而非调用方自选） */
  forced: boolean;
}

export interface DeptScope {
  deptKeys: string[] | null;
  forced: boolean;
}

export interface UserScopes {
  channelScope: number[] | null;
  deptScope: string[] | null;
}

const uniqSortedNums = (xs: readonly number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);
const uniqSortedStrs = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** dept_key（角色码）↔ target_id（ROLES 索引） */
export function deptKeyToTargetId(deptKey: string): number {
  const i = (ROLES as readonly string[]).indexOf(deptKey);
  if (i < 0) throw new ApiError(400, `未知部门键：${deptKey}`);
  return i;
}
export function targetIdToDeptKey(targetId: number): string | null {
  return (ROLES as readonly string[])[targetId] ?? null;
}

/** 从 DB 加载某用户的范围记录；无记录返回 null（= 不限） */
export async function loadUserScopes(db: AnyDb, userId: number): Promise<UserScopes> {
  const rows: { scopeKind: string; targetId: number }[] = await db
    .select({ scopeKind: userDataScopes.scopeKind, targetId: userDataScopes.targetId })
    .from(userDataScopes)
    .where(eq(userDataScopes.userId, userId));
  const channels = rows.filter((r) => r.scopeKind === "channel").map((r) => r.targetId);
  const depts = rows
    .filter((r) => r.scopeKind === "dept")
    .map((r) => targetIdToDeptKey(r.targetId))
    .filter((k): k is string => k !== null);
  return {
    channelScope: channels.length > 0 ? uniqSortedNums(channels) : null,
    deptScope: depts.length > 0 ? uniqSortedStrs(depts) : null,
  };
}

function isUnrestricted(user: ScopeUser, scope: readonly unknown[] | null | undefined): boolean {
  return user.roles.includes("admin") || scope == null;
}

/**
 * 渠道范围解析。
 * - 不限用户：requested 给了则 [requested]（forced=false），否则 null；
 * - 受限用户：requested 在范围内 → [requested]（forced=true）；范围外 → 403；未给 → 全部范围（forced=true）。
 */
export function resolveChannelScope(user: ScopeUser, requestedChannelId?: number | null): ChannelScope {
  const requested = requestedChannelId ?? null;
  if (requested !== null && (!Number.isInteger(requested) || requested <= 0)) {
    throw new ApiError(400, "无效的渠道 ID");
  }
  if (isUnrestricted(user, user.channelScope)) {
    return { channelIds: requested === null ? null : [requested], forced: false };
  }
  const allowed = uniqSortedNums(user.channelScope as readonly number[]);
  if (requested === null) return { channelIds: allowed, forced: true };
  if (!allowed.includes(requested)) throw new ApiError(403, "无权访问该渠道的数据");
  return { channelIds: [requested], forced: true };
}

/** 部门范围解析（口径同 resolveChannelScope；键为角色码） */
export function resolveDeptScope(user: ScopeUser, requestedDeptKey?: string | null): DeptScope {
  const requested = requestedDeptKey ?? null;
  if (requested !== null && !(ROLES as readonly string[]).includes(requested)) {
    throw new ApiError(400, `未知部门键：${requested}`);
  }
  if (isUnrestricted(user, user.deptScope)) {
    return { deptKeys: requested === null ? null : [requested], forced: false };
  }
  const allowed = uniqSortedStrs(user.deptScope as readonly string[]);
  if (requested === null) return { deptKeys: allowed, forced: true };
  if (!allowed.includes(requested)) throw new ApiError(403, "无权访问该部门的数据");
  return { deptKeys: [requested], forced: true };
}

/**
 * 按渠道范围裁剪行。scope.channelIds 为 null 时原样返回；
 * 渠道为空（未映射/非渠道维）的行默认剔除，`keepUnassigned` 可保留。
 */
export function filterRowsByChannelScope<T>(
  rows: readonly T[],
  getChannelId: (row: T) => number | null | undefined,
  scope: ChannelScope,
  opts: { keepUnassigned?: boolean } = {},
): T[] {
  if (scope.channelIds === null) return [...rows];
  const allowed = new Set(scope.channelIds);
  return rows.filter((r) => {
    const id = getChannelId(r);
    if (id == null) return opts.keepUnassigned === true;
    return allowed.has(id);
  });
}

/** 按部门范围裁剪行（同上） */
export function filterRowsByDeptScope<T>(
  rows: readonly T[],
  getDeptKey: (row: T) => string | null | undefined,
  scope: DeptScope,
  opts: { keepUnassigned?: boolean } = {},
): T[] {
  if (scope.deptKeys === null) return [...rows];
  const allowed = new Set(scope.deptKeys);
  return rows.filter((r) => {
    const k = getDeptKey(r);
    if (k == null) return opts.keepUnassigned === true;
    return allowed.has(k);
  });
}
