/**
 * 库存记录准确率 IRA 轨 A——盘点命中率（纯函数，唯一权威）。
 *
 * 输入已审批 PD 行 {bookQty, countedQty}；命中 = |账面 − 实盘| ≤ absTolerance（默认 0，严格相等；
 * 一个全局绝对容差，不做 ABC 分档）；rate = hits/lines × 100（2dp），lines=0 → null。
 * 限制（卡片必须显示）：未改动行计为命中，偏高；仅 realtime 仓。
 */
import { type Dec, dCmp, dDiv, dMul, dSub } from "@/server/core/decimal";

export interface CountLine {
  bookQty: Dec;
  countedQty: Dec;
}

export interface CountHitRate {
  lines: number;
  hits: number;
  rate: number | null;
}

export function countHitRate(lines: CountLine[], absTolerance: Dec = 0): CountHitRate {
  const tol = dCmp(absTolerance, 0) > 0 ? absTolerance : 0;
  let hits = 0;
  for (const l of lines ?? []) {
    const diff = dSub(l.bookQty, l.countedQty, 4);
    const abs = diff.startsWith("-") ? diff.slice(1) : diff;
    if (dCmp(abs, tol) <= 0) hits += 1;
  }
  const n = lines?.length ?? 0;
  return { lines: n, hits, rate: n > 0 ? Number(dMul(dDiv(hits, n, 6), 100, 2)) : null };
}
