/**
 * R18 齐套引擎（D33/0724 会议；spec/11）：纯函数，十进制字符串运算。
 * 可产量 = min_i( floor(净已发料_i ÷ 毛单耗_i) )；毛单耗 = grossReq_i / woQty。
 * 建议批量 = min(可产量 − 已批量, WO 余量) 按订货倍数向下取整；<1 倍数则 0。
 */
import { dCmp, dFloorToMultiple, dMulDivFloor, dSub, type Dec } from "@/server/core/decimal";

export interface KittingLine {
  materialSkuId: number;
  grossReq: string; // 全单毛需求
  netIssued: string; // 调用方提供的可用料依据；现行自动建批为本WO的PO已收，不等于已验证到厂
}

export function producibleQty(woQty: string, lines: KittingLine[]): string {
  if (lines.length === 0 || dCmp(woQty, "0") <= 0) return "0";
  let minUnits: string | null = null;
  for (const l of lines) {
    if (dCmp(l.grossReq, "0") <= 0) continue; // 零需求行不约束
    // Do not quantize gross/WO first: tiny requirements must still constrain capacity.
    const units = dMulDivFloor(l.netIssued, woQty, l.grossReq);
    if (minUnits === null || dCmp(units, minUnits) < 0) minUnits = units;
  }
  return minUnits !== null && dCmp(minUnits, "0") > 0 ? minUnits : "0";
}

export function suggestBatchQty(i: {
  producible: Dec;
  alreadyBatched: string; // 已下 JG 批次量合计
  woQty: string;
  orderMultiple?: string | null;
}): string {
  const limit = dCmp(i.producible, i.woQty) < 0 ? i.producible : i.woQty;
  const room = dSub(limit, i.alreadyBatched, 6);
  if (dCmp(room, "0") <= 0) return "0.0000";
  // Preserve the existing whole-unit fallback for absent/nonpositive/sub-unit multiples.
  const multiple = i.orderMultiple && dCmp(i.orderMultiple, "1") > 0 ? i.orderMultiple : "1";
  return dFloorToMultiple(room, multiple);
}

/** 批次上限护栏（spec/11）：超出转人工 */
export const MAX_AUTO_BATCHES = 8;
export function batchAllowed(existingBatches: number): boolean {
  return existingBatches < MAX_AUTO_BATCHES;
}
