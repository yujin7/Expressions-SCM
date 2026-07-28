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

export function clearParamCache(): void {
  cache.clear();
}
