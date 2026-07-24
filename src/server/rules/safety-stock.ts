/**
 * E2-01 安全库存（纯函数）——本系统此前完全没有安全库存概念，
 * 建议量 = 毛需求 − 在库 − 在途，等于把安全库存设成 0：需求一波动，服务水平必然低于目标，
 * 而系统不会告诉你。本模块补上这一层。
 *
 * 口径（教科书式，逐项可解释）：
 *   SS = z(服务水平) × σ_LT
 *   σ_LT = √( LT × σ_d²  +  d̄² × σ_LT交期² )     ——需求波动与交期波动各贡献一项
 * 其中：
 *   - d̄ = 日均需求；σ_d = 日需求标准差（由月度序列折算：σ_月 / √(月天数)）；
 *   - LT = 常规生产周期（天）；σ_LT交期 = 交期波动（天，来自供应商履约历史；无则 0）；
 *   - z 由服务水平查表（90%/95%/97.5%/99%）。
 *
 * 诚实降级：样本不足（<3 个月）时 σ 不可信 → 返回 method='fallback'，
 * 用「分层默认安全天数 × 日均」兜底，并标注原因，绝不假装算出了统计安全库存。
 */

/** 服务水平 → z 值（单尾正态分位，常用档位） */
export const SERVICE_LEVEL_Z: Record<string, number> = {
  "90": 1.28,
  "95": 1.65,
  "97.5": 1.96,
  "99": 2.33,
};

export type SafetyMethod = "statistical" | "fallback" | "none";

export interface SafetyStockInput {
  /** 月度销量序列（升序，至少 3 期才做统计法） */
  monthly: number[];
  /** 日均需求 */
  daily: number;
  /** 常规生产周期（天）；null=未知 */
  leadDays: number | null;
  /** 交期波动标准差（天）；无履约历史则 0 */
  leadDaysStdev?: number;
  /** 服务水平档位，默认 95 */
  serviceLevel?: keyof typeof SERVICE_LEVEL_Z | string;
  /** 兜底安全天数（分层默认；统计法不可用时用 daily × 该天数） */
  fallbackDays?: number;
  /** 月天数基准（与 velocity.DAYS_PER_MONTH 对齐） */
  daysPerMonth?: number;
}

export interface SafetyStockResult {
  /** 建议安全库存（件，向上取整） */
  safetyQty: number;
  method: SafetyMethod;
  /** 可解释：命中的口径说明 */
  reason: string;
  /** 中间量（供解释链展示） */
  detail: { z: number | null; sigmaDaily: number | null; sigmaLeadTime: number | null };
}

/** 样本标准差（n-1 分母；样本 <2 返回 null） */
export function stdev(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

export function safetyStock(input: SafetyStockInput): SafetyStockResult {
  const daysPerMonth = input.daysPerMonth ?? 30.4;
  const fallbackDays = input.fallbackDays ?? 0;
  const daily = Math.max(0, input.daily);
  const zKey = String(input.serviceLevel ?? "95");
  const z = SERVICE_LEVEL_Z[zKey] ?? SERVICE_LEVEL_Z["95"];

  if (daily <= 0) {
    return { safetyQty: 0, method: "none", reason: "无动销，不设安全库存", detail: { z: null, sigmaDaily: null, sigmaLeadTime: null } };
  }

  const series = input.monthly.filter((v) => Number.isFinite(v) && v >= 0);
  const sigmaMonthly = series.length >= 3 ? stdev(series) : null;
  const lt = input.leadDays;

  // 统计法需要：≥3 期样本 + 已知交期
  if (sigmaMonthly != null && lt != null && lt > 0) {
    const sigmaDaily = sigmaMonthly / Math.sqrt(daysPerMonth);
    const sigmaLt = Math.max(0, input.leadDaysStdev ?? 0);
    const sigmaLeadTime = Math.sqrt(lt * sigmaDaily ** 2 + daily ** 2 * sigmaLt ** 2);
    const qty = Math.ceil(z * sigmaLeadTime);
    return {
      safetyQty: qty,
      method: "statistical",
      reason:
        `统计法：服务水平 ${zKey}%（z=${z}）× 交期内需求波动 σ=${sigmaLeadTime.toFixed(1)}` +
        `（生产周期 ${lt} 天${sigmaLt > 0 ? `，交期波动 ±${sigmaLt.toFixed(1)} 天` : "，交期按确定值"}）`,
      detail: { z, sigmaDaily, sigmaLeadTime },
    };
  }

  if (fallbackDays > 0) {
    const why = lt == null || lt <= 0 ? "缺生产周期" : "销量样本不足 3 个月";
    return {
      safetyQty: Math.ceil(daily * fallbackDays),
      method: "fallback",
      reason: `${why}，统计法不可用 → 按分层默认 ${fallbackDays} 天安全库存兜底`,
      detail: { z: null, sigmaDaily: null, sigmaLeadTime: null },
    };
  }

  return {
    safetyQty: 0,
    method: "none",
    reason: lt == null || lt <= 0 ? "缺生产周期且无兜底天数，未设安全库存" : "样本不足且无兜底天数，未设安全库存",
    detail: { z: null, sigmaDaily: null, sigmaLeadTime: null },
  };
}
