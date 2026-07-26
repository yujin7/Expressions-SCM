/**
 * 服务层通用脚手架（终结 num / r1 / resolveDb / AnyDb 在 26 个模块逐字复制）。
 *
 * 纪律：这些是**展示层/装配层**工具——
 * - num：DB 返回的 decimal 字符串 → number，仅用于报表聚合与展示，禁止用于记账路径
 *   （记账一律走 core/decimal 的 dAdd/dMul 等字符串运算，见 CLAUDE.md）；
 * - r1：展示保留 1 位小数；
 * - resolveDb：可选 db 参数的统一解析（测试传 db 走实时，生产不传走默认连接）。
 */
import { getDbAsync } from "@/db";

/** drizzle 查询构建器在本项目按 any 传递（各 service 历史约定，集中于此一处声明） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = any;

/** decimal 字符串/null → number（null/空 = 0）。仅展示与报表聚合用。 */
export const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** 展示层四舍五入到 1 位小数 */
export const r1 = (v: number): number => Math.round(v * 10) / 10;
/** 可空版 r1：null 透传（可销天数等「算不出＝null」的口径专用） */
export const r1n = (v: number | null): number | null => (v == null ? null : r1(v));

/** 展示层四舍五入到 2 位小数 */
export const r2 = (v: number): number => Math.round(v * 100) / 100;

/** 可选 db 参数解析：传入即用（测试/同事务），否则取默认连接 */
export async function resolveDb(db?: AnyDb): Promise<AnyDb> {
  return db ?? (await getDbAsync());
}
