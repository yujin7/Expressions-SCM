/**
 * 运行参数读取（sys_params，global scope）——D39 阈值参数化。
 * 数值型带缺省；60s 进程内缓存（与驾驶舱缓存同节奏）；测试传 dbArg 时旁路缓存。
 */
import { and, eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { sysParams } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const cache = new Map<string, { v: number; exp: number }>();
const textCache = new Map<string, { v: string | null; exp: number }>();

export async function getNumParam(key: string, fallback: number, dbArg?: AnyDb): Promise<number> {
  if (!dbArg) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
  }
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [row] = await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.scope, "global"), eq(sysParams.key, key)));
  const n = row ? Number(row.value) : NaN;
  const v = Number.isFinite(n) ? n : fallback;
  if (!dbArg) cache.set(key, { v, exp: Date.now() + 60_000 });
  return v;
}

/**
 * 文本型运行参数（枚举开关用）。数值白名单 admin/params.ts 的 PARAM_DEFS 只承载数值，
 * 枚举/开关类参数（如 W12 的 `tier_basis` = qty|value）走这里，缺省与合法值由调用方裁定；
 * **调用方必须对返回值做白名单校验**，非法值一律回落缺省，绝不让脏值改变口径。
 */
export async function getTextParam(key: string, fallback: string, dbArg?: AnyDb): Promise<string> {
  if (!dbArg) {
    const hit = textCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.v ?? fallback;
  }
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [row] = await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.scope, "global"), eq(sysParams.key, key)));
  const raw = row ? String(row.value).trim() : "";
  if (!dbArg) textCache.set(key, { v: raw || null, exp: Date.now() + 60_000 });
  return raw || fallback;
}

export function clearParamCache(): void {
  cache.clear();
  textCache.clear();
}
