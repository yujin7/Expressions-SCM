/**
 * 环比/同比比较（纯函数，唯一权威）。
 *
 * - momPct(current, previous)：(current − previous) / previous × 100，2dp；缺任一项或上期为 0 → null（不补零、不除零）。
 * - momPointDiff(currentPct, previousPct)：百分点差 current − previous，2dp；缺任一项 → null。
 * 内部走 decimal 工具（禁 float 运算），输出 number 供图卡直接使用。
 */
import { type Dec, dCmp, dDeviationPct, dSub } from "@/server/core/decimal";

function valid(v: Dec | null | undefined): v is Dec {
  if (v == null) return false;
  if (typeof v === "number") return Number.isFinite(v);
  return /^-?\d+(\.\d+)?$/.test(v.trim());
}

export function momPct(current: Dec | null | undefined, previous: Dec | null | undefined): number | null {
  if (!valid(current) || !valid(previous)) return null;
  if (dCmp(previous, 0) === 0) return null;
  return Number(dDeviationPct(previous, current));
}

export function momPointDiff(currentPct: Dec | null | undefined, previousPct: Dec | null | undefined): number | null {
  if (!valid(currentPct) || !valid(previousPct)) return null;
  return Number(dSub(currentPct, previousPct, 2));
}
