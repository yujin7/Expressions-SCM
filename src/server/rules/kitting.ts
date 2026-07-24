/**
 * R18 齐套引擎（D33/0724 会议；spec/11）：纯函数，十进制字符串运算。
 * 可产量 = min_i( floor(净已发料_i ÷ 毛单耗_i) )；毛单耗 = grossReq_i / woQty。
 * 建议批量 = min(可产量 − 已批量, WO 余量) 按订货倍数向下取整；<1 倍数则 0。
 */
import { dCmp, dDiv, dMul, dSub } from "@/server/core/decimal";

export interface KittingLine {
  materialSkuId: number;
  grossReq: string; // 全单毛需求
  netIssued: string; // FL−TL 净已发（到厂）
}

export function producibleQty(woQty: string, lines: KittingLine[]): number {
  if (lines.length === 0 || dCmp(woQty, "0") <= 0) return 0;
  let minUnits = Infinity;
  for (const l of lines) {
    if (dCmp(l.grossReq, "0") <= 0) continue; // 零需求行不约束
    const perUnit = dDiv(l.grossReq, woQty, 6);
    if (dCmp(perUnit, "0") <= 0) continue;
    const units = Math.floor(Number(dDiv(l.netIssued, perUnit, 6)));
    if (units < minUnits) minUnits = units;
  }
  return Number.isFinite(minUnits) ? Math.max(0, minUnits) : 0;
}

export function suggestBatchQty(i: {
  producible: number;
  alreadyBatched: string; // 已下 JG 批次量合计
  woQty: string;
  orderMultiple?: string | null;
}): number {
  const remainWo = Number(dSub(i.woQty, i.alreadyBatched));
  const room = Math.min(i.producible - Number(i.alreadyBatched), remainWo);
  if (room <= 0) return 0;
  const m = i.orderMultiple ? Number(i.orderMultiple) : 0;
  if (m > 1) return Math.floor(room / m) * m;
  return Math.floor(room);
}

/** 批次上限护栏（spec/11）：超出转人工 */
export const MAX_AUTO_BATCHES = 8;
export function batchAllowed(existingBatches: number): boolean {
  return existingBatches < MAX_AUTO_BATCHES;
}

// 保留 dMul 引用以防未来单位换算扩展（当前未用）
void dMul;
