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

export const MAX_BOM_DEPTH = 32;

export class BomCycleError extends Error {
  constructor(public readonly cycle: number[]) {
    super(`BOM 存在循环：${cycle.join(" → ")}`);
    this.name = "BomCycleError";
  }
}

export class BomDepthError extends Error {
  constructor(public readonly path: number[]) {
    super(`BOM 层级超过安全上限 ${MAX_BOM_DEPTH}：${path.join(" → ")}`);
    this.name = "BomDepthError";
  }
}

function addDemand(out: Map<number, string>, skuId: number, qty: Dec): void {
  out.set(skuId, dQty(dAdd(out.get(skuId) ?? "0", qty, 6)));
}

/**
 * 从一个根 SKU 检查循环与异常深度。返回首个循环路径；无循环返回 null。
 * 路径首尾相同，例如 A → B → C → A，便于服务层直接映射成人类可读编码。
 */
export function findBomCycleFrom(
  rootSkuId: number,
  bom: Map<number, BomLineLike[]>,
): number[] | null {
  const path: number[] = [];
  const active = new Map<number, number>();

  const visit = (skuId: number, depth: number): number[] | null => {
    const prior = active.get(skuId);
    if (prior != null) return [...path.slice(prior), skuId];
    if (depth > MAX_BOM_DEPTH) throw new BomDepthError([...path, skuId]);
    const lines = bom.get(skuId);
    if (!lines || lines.length === 0) return null;

    active.set(skuId, path.length);
    path.push(skuId);
    for (const line of lines) {
      const cycle = visit(line.materialSkuId, depth + 1);
      if (cycle) return cycle;
    }
    path.pop();
    active.delete(skuId);
    return null;
  };

  return visit(rootSkuId, 0);
}

/** 全图循环去重；同一循环从不同入口命中时只返回一次。 */
export function findBomCycles(bom: Map<number, BomLineLike[]>): number[][] {
  const unique = new Map<string, number[]>();
  for (const root of bom.keys()) {
    const cycle = findBomCycleFrom(root, bom);
    if (!cycle) continue;
    const nodes = [...new Set(cycle.slice(0, -1))].sort((a, b) => a - b);
    const key = nodes.join(",");
    if (!unique.has(key)) unique.set(key, cycle);
  }
  return [...unique.values()];
}

/**
 * 多成品需求 → **末级物料**毛需求合计（多层展开）。
 *
 * bom: SKU → 其生效 BOM 行（调用方负责只传 status='active'）。
 * - 子件有生效 BOM：继续向下展开，不把中间半成品重复计作采购末级物料；
 * - 子件无生效 BOM：作为末级物料汇总；
 * - 每一层都按自身 BOM 行应用双损耗/legacy 回退，保持 WO 快照同口径；
 * - 根 SKU 无 BOM：保持旧契约，返回空（由前端列为断链）；
 * - 任一根需求出现循环或超过 32 层：整次计算失败，绝不返回部分低估结果。
 */
export function explode(
  demands: { skuId: number; qty: Dec }[],
  bom: Map<number, BomLineLike[]>,
): Map<number, string> {
  const out = new Map<number, string>();
  const path: number[] = [];
  const active = new Map<number, number>();

  const walk = (skuId: number, qty: Dec, depth: number): void => {
    const prior = active.get(skuId);
    if (prior != null) throw new BomCycleError([...path.slice(prior), skuId]);
    if (depth > MAX_BOM_DEPTH) throw new BomDepthError([...path, skuId]);
    const lines = bom.get(skuId);
    if (!lines || lines.length === 0) {
      if (depth > 0) addDemand(out, skuId, qty);
      return;
    }

    active.set(skuId, path.length);
    path.push(skuId);
    for (const line of lines) {
      const gross = grossFromBom({
        planQty: qty,
        qtyPer: line.qtyPer,
        incomingLossPct: line.incomingLossPct,
        productionLossPct: line.productionLossPct,
        lossRatePct: line.lossRatePct,
      });
      if (dCmp(gross, "0") > 0) walk(line.materialSkuId, gross, depth + 1);
    }
    path.pop();
    active.delete(skuId);
  };

  for (const demand of demands) {
    if (dCmp(demand.qty, "0") > 0) walk(demand.skuId, demand.qty, 0);
  }
  return out;
}
