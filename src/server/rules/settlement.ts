/**
 * R5 委外结算（《01》§5，逐物料，禁止跨物料轧差）：
 *   有效完工数 Q = 合格 + 让步接收 + 备品（备品/让步同样消耗物料，必须计入基数）
 *   对每一物料 i：
 *     净标准用量ᵢ = BOM单位用量ᵢ × Q
 *     允许损耗ᵢ   = 净标准用量ᵢ × 品类允许损耗率ᵢ
 *     实际损耗ᵢ   = 累计发料ᵢ − 累计退料ᵢ − 净标准用量ᵢ   （可为负：可能节约或记录/标准差异，非实物余料）
 *     超额损耗ᵢ   = max(0, 实际损耗ᵢ − 允许损耗ᵢ)          ← 逐行钳零，省料不得抵扣他料超损
 *     扣款ᵢ       = 超额损耗ᵢ × 当月加权平均价ᵢ
 *   应付加工费 = Σ(收货分段数量 × 当时加工费现价) + 让步数 × 让步单价（备品不计加工费）
 *   结算金额   = 应付加工费 − Σ扣款ᵢ ± 手工调整
 * 数量 scale=4，金额 scale=2；纯函数，全部经 decimal.ts。
 */
import { dAdd, dSub, dMul, dDiv, dMax, dMoney, dQty } from "@/server/core/decimal";

export type SettleMaterial = {
  materialSkuId: number;
  /** BOM 单位用量 */
  qtyPer: string;
  /** 累计发料量（FL） */
  issuedQty: string;
  /** 累计退料量（TL，R5 退回量唯一数据源） */
  returnedQty: string;
  /** 品类允许损耗率（百分数，R2 唯一来源=sys_param） */
  allowedLossRatePct: string;
  /** 当月加权平均价（含税口径与应付一致） */
  avgPrice: string;
};

export type SettleInput = {
  /** 合格数 */
  goodQty: string;
  /** 让步接收数 */
  concessionQty: string;
  /** 备品数（消耗物料但不计加工费） */
  spareQty: string;
  /** 合格数按收货时点分段 × 当时 JG 加工费现价 */
  feeSegments: { qty: string; rate: string }[];
  /** 让步单价（D6，默认全价，财务审批） */
  concessionPrice: string;
  /** 手工调整（审批留痕，可正可负） */
  manualAdj: string;
  materials: SettleMaterial[];
};

export type SettleLine = {
  materialSkuId: number;
  stdQty: string;
  allowedLoss: string;
  actualLoss: string;
  excessLoss: string;
  deductPrice: string;
  deductAmount: string;
};

export type SettleResult = {
  effectiveQty: string;
  lines: SettleLine[];
  feePayable: string;
  deductionTotal: string;
  settleAmount: string;
};

export function settle(i: SettleInput): SettleResult {
  // 有效完工数：合格 + 让步 + 备品（三者都消耗物料）
  const effectiveQty = dQty(dAdd(dAdd(i.goodQty, i.concessionQty, 6), i.spareQty, 6));

  // 逐物料计算，禁止跨物料轧差
  const lines: SettleLine[] = i.materials.map((m) => {
    const stdQty = dMul(m.qtyPer, effectiveQty, 4);
    const allowedLoss = dQty(dMul(stdQty, dDiv(m.allowedLossRatePct, "100", 6), 6));
    const actualLoss = dQty(dSub(dSub(m.issuedQty, m.returnedQty, 6), stdQty, 6));
    // 逐行钳零：省料（负损耗）不得冲抵其他物料的超损
    const excessLoss = dMax("0", dSub(actualLoss, allowedLoss, 4), 4);
    const deductAmount = dMoney(dMul(excessLoss, m.avgPrice, 6));
    return {
      materialSkuId: m.materialSkuId,
      stdQty,
      allowedLoss,
      actualLoss,
      excessLoss,
      deductPrice: m.avgPrice,
      deductAmount,
    };
  });

  // 应付加工费 = Σ分段(合格数×当时现价) + 让步数×让步单价；备品不计加工费
  let fee = "0";
  for (const seg of i.feeSegments) {
    fee = dAdd(fee, dMul(seg.qty, seg.rate, 6), 6);
  }
  fee = dAdd(fee, dMul(i.concessionQty, i.concessionPrice, 6), 6);
  const feePayable = dMoney(fee);

  // Σ扣款（各行已落金额口径，按 scale=2 累加）
  let deductionTotal = "0.00";
  for (const line of lines) {
    deductionTotal = dAdd(deductionTotal, line.deductAmount, 2);
  }

  // 结算金额 = 应付加工费 − 扣款合计 ± 手工调整
  const settleAmount = dMoney(dAdd(dSub(feePayable, deductionTotal, 6), i.manualAdj, 6));

  return { effectiveQty, lines, feePayable, deductionTotal, settleAmount };
}
