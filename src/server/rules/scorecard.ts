/**
 * E5-06 供应商记分卡（纯函数）——把「凭印象填的 S–D 分级」换成可解释的数据评分。
 *
 * 现状：suppliers.level 是采购手填的主观分级，而算分所需的原料全在库里躺着：
 * 交期履约（PO 承诺 vs 实际收货）、质检结果（合格/让步/报废）、价格异动（PC 单）。
 * 本模块只负责「由指标算分」这一步，取数在 modules/report/supplier-scorecard.ts，
 * 写档案在 applySupplierLevel（人工点「采纳」才写，绝不自动改主数据）。
 *
 * ── 权重依据（总分 100）──
 *  · 准时交付 40：交期是供应链最贵的变量——晚到直接停线/断货，缺料成本远高于单价差异，
 *    故给最高权重；数据口径复用 rules/leadtime-stats.ts 的 onTimeRate（实际 ≤ 承诺）。
 *  · 质量 40：与准时同权。合格率是基线，但「让步接收」与「报废」不是同一件事——
 *    让步是勉强用了（隐性成本：让步价谈判、下游返修风险），报废是全损（料废 + 工期废），
 *    所以在合格率之上再按 让步率×0.5 + 报废率×1.0 扣分（penalty 单位是「合格率百分点」）。
 *    只扣不加：调整后达成率封顶 1、封底 0。
 *  · 价格稳定 20：单价本身由采购谈判决定、不宜由记分卡评判（低价可能对应差质量），
 *    但「频繁调价」本身是可管理性问题（预算失真、成本核算返工），故只罚频次不罚价格水平。
 *    窗口内变更 0 次满分，达到 PRICE_CHANGE_ZERO_AT 次归零，线性递减。
 *  · 质量案件 20（W2 审计 4b 新增，**仅对有案件的供应商生效**）：`quality_cases` 此前是个孤岛——
 *    投诉/不良事件/召回挂着供应商，却对该供应商的评分零影响，于是「案件越多分数越高」也不会有人发现
 *    （案件多往往伴随收货多、样本多、置信度高）。逾期案件全罚、未逾期在办案件半罚。
 *    **没有案件的供应商不进这个维度**（不是「无数据」，是「不适用」），分数与本次改动前逐位相同；
 *    有案件的按 100 + 20 = 120 分权重归一（归一逻辑本就按可用权重，见下）。
 *
 * ── 缺数据 ≠ 零分（关键设计）──
 * 某维度无数据（如该供应商所有 PO 都没填承诺交期 → onTimeRate=null）时，该维度**不计分**，
 * 得分按**剩余维度的权重归一**：score = 100 × Σ(达成率×权重) / Σ(可用权重)。
 * 若按「缺数据 = 0 分」处理，等于因为我们没记录而惩罚供应商，那是数据质量问题不是供应商问题。
 *
 * ── 样本不足不评级（关键设计）──
 * 收货样本 < minSamples（默认 3）时 score/grade 直接返回 null，而不是给一个低分：
 * 1 单迟到就打 D 级会让记分卡失去信任，且新供应商永远翻不了身。
 */

/** 供应商分级（与 master/schemas.ts SUPPLIER_LEVELS 同集合，此处避免 rules 层反向依赖 modules 层） */
export type SupplierGrade = "S" | "A" | "B" | "C" | "D";

export interface ScoreInput {
  /** 准时率 0~1（来自 leadtime-stats.leadTimeStats）；无承诺交期样本 → null */
  onTimeRate: number | null;
  /** 合格率 0~1 = 合格量 / 判定总量；无检验样本 → null */
  qcPassRate: number | null;
  /** 让步接收率 0~1；无检验样本 → null */
  concessionRate: number | null;
  /** 报废率 0~1；无检验样本 → null */
  scrapRate: number | null;
  /** 窗口内生效的价格变更单次数 */
  priceChangeCount: number;
  /** 收货样本数（置信度依据） */
  sampleN: number;
  /**
   * 质量案件（W2）：null / 省略 = 该供应商窗口内没有任何质量案件 → **本维度不适用、不参与归一**；
   * 有案件才进维度。openCases 含 overdueCases（后者是前者的子集，逾期按全罚、其余半罚）。
   */
  qualityCase?: { openCases: number; overdueCases: number } | null;
}

export interface ScoreBreakdownItem {
  key: string;
  label: string;
  /** 该维度原始权重（分） */
  weight: number;
  /** 该维度原始指标：比率维度为 0~1，价格维度为「变更次数」；无数据 → null */
  value: number | null;
  /** 该维度实得分（= 达成率 × 权重，保留 1 位）；无数据或未评级 → null */
  points: number | null;
  /** 可解释说明（缺数据时写明「权重已归一」） */
  note: string;
}

export interface ScoreResult {
  /** 综合分 0~100；样本不足 → null（不假装打分） */
  score: number | null;
  grade: SupplierGrade | null;
  breakdown: ScoreBreakdownItem[];
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * 权重：onTime + quality + price = 100（基准三维，恒存在）。
 * qualityCase 是**条件维度**：只有窗口内有质量案件的供应商才加进来，届时按 120 权重归一。
 */
export const SCORE_WEIGHTS = { onTime: 40, quality: 40, price: 20, qualityCase: 20 } as const;

/** 质量惩罚系数：让步半罚（勉强可用）、报废全罚（全损） */
export const CONCESSION_PENALTY = 0.5;
export const SCRAP_PENALTY = 1.0;

/** 价格稳定：窗口内变更达到该次数则该维度归零 */
export const PRICE_CHANGE_ZERO_AT = 5;

/** 质量案件惩罚：逾期全罚、其余在办半罚；加权案件数达到该值该维度归零 */
export const QUALITY_CASE_OPEN_PENALTY = 0.5;
export const QUALITY_CASE_OVERDUE_PENALTY = 1.0;
export const QUALITY_CASE_ZERO_AT = 4;

/** 置信度：≥ 该样本数视为高置信 */
export const HIGH_CONFIDENCE_SAMPLES = 10;

/** 等级阈值（降序匹配，第一个满足的即为等级；均不满足 → D） */
export const GRADE_THRESHOLDS: { min: number; grade: SupplierGrade }[] = [
  { min: 90, grade: "S" },
  { min: 80, grade: "A" },
  { min: 70, grade: "B" },
  { min: 60, grade: "C" },
];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const r1 = (v: number): number => Math.round(v * 10) / 10;
const pct = (v: number | null): string => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

/** 分数 → 等级（≥90 S / ≥80 A / ≥70 B / ≥60 C / <60 D） */
export function gradeOf(score: number): SupplierGrade {
  for (const t of GRADE_THRESHOLDS) if (score >= t.min) return t.grade;
  return "D";
}

/** 内部：一个维度的中间结果（ratio=达成率 0~1，null=该维度无数据） */
interface Dim {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  ratio: number | null;
  note: string;
}

export function scoreSupplier(i: ScoreInput, minSamples = 3): ScoreResult {
  const dims: Dim[] = [];

  /* ── 维度 1：准时交付 ── */
  if (i.onTimeRate == null) {
    dims.push({
      key: "onTime",
      label: "准时交付",
      weight: SCORE_WEIGHTS.onTime,
      value: null,
      ratio: null,
      note: "无可核对的原始承诺交期样本（交期、版本链或收货来源不足），该维度无数据，权重已归一",
    });
  } else {
    const ratio = clamp01(i.onTimeRate);
    dims.push({
      key: "onTime",
      label: "准时交付",
      weight: SCORE_WEIGHTS.onTime,
      value: i.onTimeRate,
      ratio,
      note: `准时率 ${pct(i.onTimeRate)}（实际收货 ≤ 承诺到货）× ${SCORE_WEIGHTS.onTime} 分 = ${r1(ratio * SCORE_WEIGHTS.onTime)} 分`,
    });
  }

  /* ── 维度 2：质量（合格率 − 让步/报废惩罚）── */
  if (i.qcPassRate == null) {
    dims.push({
      key: "quality",
      label: "质量",
      weight: SCORE_WEIGHTS.quality,
      value: null,
      ratio: null,
      note: "窗口内无检验判定量，该维度无数据，权重已归一",
    });
  } else {
    const conc = i.concessionRate ?? 0;
    const scrap = i.scrapRate ?? 0;
    const concPen = CONCESSION_PENALTY * conc;
    const scrapPen = SCRAP_PENALTY * scrap;
    const ratio = clamp01(i.qcPassRate - concPen - scrapPen);
    dims.push({
      key: "quality",
      label: "质量",
      weight: SCORE_WEIGHTS.quality,
      value: i.qcPassRate,
      ratio,
      note:
        `合格率 ${pct(i.qcPassRate)} − 让步惩罚 ${(concPen * 100).toFixed(1)}pp（让步率 ${pct(conc)}×${CONCESSION_PENALTY}）` +
        ` − 报废惩罚 ${(scrapPen * 100).toFixed(1)}pp（报废率 ${pct(scrap)}×${SCRAP_PENALTY}）` +
        ` = ${pct(ratio)} × ${SCORE_WEIGHTS.quality} 分 = ${r1(ratio * SCORE_WEIGHTS.quality)} 分`,
    });
  }

  /* ── 维度 3：价格稳定（只罚调价频次，不评判价格水平）── */
  {
    const count = Math.max(0, Math.round(i.priceChangeCount || 0));
    const ratio = clamp01(1 - count / PRICE_CHANGE_ZERO_AT);
    dims.push({
      key: "price",
      label: "价格稳定",
      weight: SCORE_WEIGHTS.price,
      value: count,
      ratio,
      note:
        count === 0
          ? `窗口内无价格变更，满分 ${SCORE_WEIGHTS.price} 分`
          : `窗口内价格变更 ${count} 次（满 ${PRICE_CHANGE_ZERO_AT} 次归零）× ${SCORE_WEIGHTS.price} 分 = ${r1(ratio * SCORE_WEIGHTS.price)} 分`,
    });
  }

  /* ── 维度 4：质量案件（条件维度；无案件的供应商完全不进这一维）── */
  if (i.qualityCase != null) {
    const overdue = Math.max(0, Math.round(i.qualityCase.overdueCases || 0));
    const open = Math.max(0, Math.round(i.qualityCase.openCases || 0));
    const otherOpen = Math.max(0, open - overdue);
    const weighted = otherOpen * QUALITY_CASE_OPEN_PENALTY + overdue * QUALITY_CASE_OVERDUE_PENALTY;
    const ratio = clamp01(1 - weighted / QUALITY_CASE_ZERO_AT);
    dims.push({
      key: "qualityCase",
      label: "质量案件",
      weight: SCORE_WEIGHTS.qualityCase,
      value: open,
      ratio,
      note:
        `在办质量案件 ${open} 件（其中逾期 ${overdue} 件）：逾期×${QUALITY_CASE_OVERDUE_PENALTY} + 其余×${QUALITY_CASE_OPEN_PENALTY}`
        + ` = 加权 ${weighted}（满 ${QUALITY_CASE_ZERO_AT} 归零）× ${SCORE_WEIGHTS.qualityCase} 分 = ${r1(ratio * SCORE_WEIGHTS.qualityCase)} 分`,
    });
  }

  /* ── 置信度：样本数决定，与分值无关 ── */
  const confidence: ScoreResult["confidence"] =
    i.sampleN >= HIGH_CONFIDENCE_SAMPLES ? "high" : i.sampleN >= minSamples ? "medium" : "low";

  /* ── 样本不足：不评级（不是打低分）── */
  if (i.sampleN < minSamples) {
    return {
      score: null,
      grade: null,
      breakdown: dims.map((d) => ({
        key: d.key,
        label: d.label,
        weight: d.weight,
        value: d.value,
        points: null,
        note: `样本不足，不计分。${d.note}`,
      })),
      confidence: "low",
      reason: `样本不足（收货样本 ${i.sampleN}/${minSamples} 单），不予评级——单笔波动不足以定性，宁可不打分也不误伤`,
    };
  }

  /* ── 归一：只用「有数据」的维度权重做分母 ── */
  const usable = dims.filter((d) => d.ratio != null);
  const totalWeight = usable.reduce((a, d) => a + d.weight, 0);
  if (totalWeight === 0) {
    return {
      score: null,
      grade: null,
      breakdown: dims.map((d) => ({ key: d.key, label: d.label, weight: d.weight, value: d.value, points: null, note: d.note })),
      confidence,
      reason: "所有维度均无数据，不予评级",
    };
  }
  const earned = usable.reduce((a, d) => a + (d.ratio as number) * d.weight, 0);
  const score = Math.round((earned / totalWeight) * 100);
  const grade = gradeOf(score);

  const breakdown: ScoreBreakdownItem[] = dims.map((d) => ({
    key: d.key,
    label: d.label,
    weight: d.weight,
    value: d.value,
    points: d.ratio == null ? null : r1(d.ratio * d.weight),
    note: d.note,
  }));

  const missing = dims.filter((d) => d.ratio == null).map((d) => d.label);
  const normNote =
    missing.length > 0 ? `；${missing.join("/")}维度无数据，按剩余 ${totalWeight} 分权重归一` : "";
  const confNote = confidence === "high" ? "高置信" : "中置信（样本偏少，建议结合人工判断）";

  return {
    score,
    grade,
    breakdown,
    confidence,
    reason:
      `综合 ${score} 分（${grade} 级）：` +
      `准时率 ${pct(i.onTimeRate)}、合格率 ${pct(i.qcPassRate)}、让步率 ${pct(i.concessionRate)}、报废率 ${pct(i.scrapRate)}、价格变更 ${Math.max(0, Math.round(i.priceChangeCount || 0))} 次` +
      (i.qualityCase != null
        ? `、在办质量案件 ${i.qualityCase.openCases} 件（逾期 ${i.qualityCase.overdueCases} 件）`
        : "") +
      `${normNote}；收货样本 ${i.sampleN} 单，${confNote}`,
  };
}
