/**
 * E2-07 相关需求展开（MRP 的缺失另一半）：成品需求 → BOM → 物料毛需求。
 *
 * ── 双损耗毛需求公式（来源：`src/server/modules/outsource/wo.ts` → buildWoLineSnapshot，原样照抄含 legacy 回退）──
 *   const dualZero = dCmp(l.incomingLossPct, "0") === 0 && dCmp(l.productionLossPct, "0") === 0;
 *   const lossFactor = dualZero
 *     ? dAdd("1", dDiv(l.lossRatePct, "100", 6), 6)
 *     : dMul(dAdd("1", dDiv(l.incomingLossPct, "100", 6), 6), dAdd("1", dDiv(l.productionLossPct, "100", 6), 6), 6);
 *   const grossReq = dQty(dMul(dMul(l.qtyPer, lossFactor, 6), wo.qty, 6));
 *
 * 损耗先后顺序（《04》§2）：净单位用量 qtyPer 先按【来料损耗 incomingLossPct】放大，
 * 再按【生产损耗 productionLossPct】放大——两者**相乘**而非相加，故 5% + 5% = ×1.1025（+10.25%）而非 +10%。
 * 双列同时为 0 时回退旧列 lossRatePct（存量 BOM 兼容，只填过旧字段的行不至于按 0 损耗低估）。
 * 本文件与 wo.ts 是同一口径的两个使用点——改动必须同步，否则 WO 快照与 MRP 前瞻会打架。
 *
 * 禁 float（CLAUDE.md）：入参可为数字或十进制字符串，内部全程 decimal.ts，出参为 qty scale=4 字符串。
 */
import { dAdd, dCmp, dDiv, dMul, dQty, type Dec } from "@/server/core/decimal";

/** BOM 行的展开所需字段（bom_lines 子集） */
export interface BomLineLike {
  materialSkuId: number;
  /** 净单位用量 */
  qtyPer: Dec;
  /** 来料损耗 %（双损耗新列） */
  incomingLossPct?: Dec | null;
  /** 生产损耗 %（双损耗新列） */
  productionLossPct?: Dec | null;
  /** 旧口径单一损耗 %（双损耗均为 0 时回退） */
  lossRatePct?: Dec | null;
}

export interface GrossFromBomInput {
  /** 计划产出数量（WO 剩余产出 / 成品建议补货量） */
  planQty: Dec;
  /** 净单位用量 */
  qtyPer: Dec;
  incomingLossPct?: Dec | null;
  productionLossPct?: Dec | null;
  /** legacy 回退用（双损耗均为 0 时生效） */
  lossRatePct?: Dec | null;
}

/**
 * 单行毛需求 = 净单位用量 × 损耗系数 × 计划产量（qty scale=4 字符串）。
 * 与 wo.ts 快照逐字同式——含双损耗均为 0 时回退 lossRatePct 的 legacy 分支。
 */
export function grossFromBom(input: GrossFromBomInput): string {
  const incoming = input.incomingLossPct ?? "0";
  const production = input.productionLossPct ?? "0";
  const legacy = input.lossRatePct ?? "0";
  // 04 §2 双损耗口径：毛=净×(1+来料)×(1+生产)；双列为 0 时回退旧 lossRatePct（存量 BOM 兼容）
  const dualZero = dCmp(incoming, "0") === 0 && dCmp(production, "0") === 0;
  const lossFactor = dualZero
    ? dAdd("1", dDiv(legacy, "100", 6), 6)
    : dMul(dAdd("1", dDiv(incoming, "100", 6), 6), dAdd("1", dDiv(production, "100", 6), 6), 6);
  return dQty(dMul(dMul(input.qtyPer, lossFactor, 6), input.planQty, 6));
}

/**
 * 多成品需求 → 物料毛需求合计（单层展开）。
 *
 * bom: 成品 skuId → 其生效 BOM 的行集合（调用方负责只传「生效」BOM，判定见 wo.ts：status='active'）。
 * 返回：物料 skuId → 毛需求合计（qty scale=4 字符串）。无 BOM 的成品被静默跳过（前端另行提示）。
 *
 * TODO（多层 BOM）：当前仅做**单层**展开——半成品物料若自身也有生效 BOM，其下级需求不再继续下钻。
 * 现网 BOM 均为「成品→原料/包材」单层，故不影响；将来出现半成品层级时需在此加拓扑排序 + 循环检测。
 */
export function explode(
  demands: { skuId: number; qty: Dec }[],
  bom: Map<number, BomLineLike[]>,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const d of demands) {
    if (dCmp(d.qty, "0") <= 0) continue; // 零/负需求不产生物料需求
    const lines = bom.get(d.skuId);
    if (!lines || lines.length === 0) continue;
    for (const l of lines) {
      const gross = grossFromBom({
        planQty: d.qty,
        qtyPer: l.qtyPer,
        incomingLossPct: l.incomingLossPct,
        productionLossPct: l.productionLossPct,
        lossRatePct: l.lossRatePct,
      });
      out.set(l.materialSkuId, dQty(dAdd(out.get(l.materialSkuId) ?? "0", gross, 6)));
    }
  }
  return out;
}
