/**
 * 运行参数白名单（PARAM_DEFS）——**缺省值的唯一权威**。
 *
 * 零依赖纯常量模块（禁止 import 任何东西）：`core/params.getNumParam` 的缺省、
 * `admin/params` 的页面与写校验、`core/scoped-params` 的分域校验、各读模型的 `DEFAULT_*`
 * 常量都必须从这里取；不得再在调用点写第二份字面量
 * （`tests/architecture/param-defs-authority.test.ts` 钉住：`getNumParam("k", <字面量>)` 与本表不一致即红）。
 *
 * 背景（2026-09-04 审计）：`dq_sales_consistency_*` 在运行参数页显示 15/20/50，引擎却用 10/5/10；
 * `alert_learned_lead_tolerance_days`、`tier_basis`、`loss_rate_pct` 三个被读模型/结算实际读取的键
 * 根本不在白名单里，只能改 SQL——页面上写的和引擎跑的不是同一个数，这种漂移必须由单一权威消灭。
 *
 * 语义说明：`cover_target_days` 在补货引擎里缺省 45（目标覆盖天数），而 `report/inventory-alerts`
 * 传 0 表示「不叠加目标覆盖层，只按 加工+在途+缓冲 出预警阈值」（0 → null 的三态语义），
 * 两者语义不同，不是漂移；该调用点在权威测试里显式豁免并注明原因。
 */

export type ParamScopeKind = "global" | "category";

/**
 * 品类层允许的品类（与 `skus.lossCategory` 同域）。
 * 放在本零依赖模块是为了**页面也能用**：`"use client"` 组件禁止值导入 `@/server/*` 的有依赖模块，
 * 而分域覆盖表单需要这两个选项；`core/scoped-params` 再导出本常量供服务端校验，避免第二份字面量。
 */
export const PARAM_CATEGORY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "raw", label: "原料" },
  { value: "packaging", label: "包材" },
];

interface ParamDefBase {
  key: string;
  label: string;
  note: string;
  /**
   * 该参数按哪一层维护：缺省 global；`category` = 只按品类（`scope='category:<lossCategory>'`）维护，
   * 全局层不参与读取（结算 R2 只读品类行，缺行=不扣损耗），页面上全局行只读。
   */
  scope?: ParamScopeKind;
}

/** 数值参数（绝大多数） */
export interface NumParamDef extends ParamDefBase {
  kind: "number";
  fallback: number;
  min: number;
  max: number;
  unit: string;
}

/** 枚举/文本开关参数（如 W12 的 tier_basis = qty|value）；读取走 getTextParam，调用方仍须白名单校验 */
export interface EnumParamDef extends ParamDefBase {
  kind: "enum";
  fallback: string;
  options: readonly { value: string; label: string }[];
}

export type ParamDef = NumParamDef | EnumParamDef;

/** 白名单（含缺省与边界；D 号=裁决出处） */
export const PARAM_DEFS: readonly ParamDef[] = [
  { kind: "number", key: "price_tolerance_pct", label: "价格异动容差", fallback: 3, min: 0, max: 50, unit: "%", note: "R1 比价硬门（D4，UAT 校准）" },
  { kind: "number", key: "over_receive_tolerance_pct", label: "超收容差", fallback: 0, min: 0, max: 20, unit: "%", note: "收货超单比例上限" },
  { kind: "number", key: "concession_price_ratio", label: "让步默认价率", fallback: 100, min: 0, max: 100, unit: "%", note: "让步接收结算价比例（D6）" },
  { kind: "number", key: "slow_days_threshold", label: "滞销警戒阈值", fallback: 180, min: 30, max: 720, unit: "天", note: "可销天数超过即判滞销（D39/0724 会议）" },
  { kind: "number", key: "cover_alert_days", label: "断货预警阈值", fallback: 30, min: 3, max: 180, unit: "天", note: "可销天数低于即预警（R11/驾驶舱）" },
  { kind: "number", key: "cover_target_days", label: "补货目标覆盖", fallback: 45, min: 7, max: 365, unit: "天", note: "补货建议的目标覆盖天数（R11，未分层默认）；库存预警读模型传 0 表示不叠加目标层（语义不同，非漂移）" },
  { kind: "number", key: "cover_target_days_a", label: "A类目标覆盖", fallback: 60, min: 7, max: 365, unit: "天", note: "func#14 分层策略：A类(销量前80%)目标覆盖——高价值多备缓冲" },
  { kind: "number", key: "cover_target_days_b", label: "B类目标覆盖", fallback: 45, min: 7, max: 365, unit: "天", note: "func#14：B类(次15%)目标覆盖" },
  { kind: "number", key: "cover_target_days_c", label: "C类目标覆盖", fallback: 25, min: 7, max: 365, unit: "天", note: "func#14：C类(长尾5%)目标覆盖——少备减压库" },
  /* R11 单次订货上限（rules/netreq 的 maxOrder）：服务端此前从不传，规则里的「超买 N 天库存」
     与「超上限已下调」两条警告结构上永远不可能触发。以「日均 × 本天数」作上限——产能/资金约束
     在本系统没有逐 SKU 主数据，而「一次不要买超过 N 天的量」是采购能直接理解也能直接调的口径。
     0 = 不设上限（默认，保持既有行为）。 */
  { kind: "number", key: "replenish_max_order_cover_days", label: "单次订货上限天数", fallback: 0, min: 0, max: 720, unit: "天", note: "R11：单次建议量不超过「日均×本天数」；0=不限（默认）。触发时行上标「已按上限下调」" },
  { kind: "number", key: "replenish_overshoot_warn_days", label: "超买提示阈值", fallback: 90, min: 7, max: 720, unit: "天", note: "R11：MOQ/箱规导致多买超过本天数的库存即在行上提示呆滞风险" },
  { kind: "number", key: "safety_days_fallback", label: "安全库存兜底天数", fallback: 7, min: 0, max: 90, unit: "天", note: "E2-01：统计法不可用（样本<3月或缺生产周期）时按此天数×日均兜底" },
  { kind: "number", key: "service_level_pct", label: "目标服务水平", fallback: 95, min: 90, max: 99, unit: "%", note: "E2-01：安全库存 z 值档位（90/95/97.5→98取95、99）" },
  /* 异动侦测三阈值（2026-07-25 审计收编）：此前硬编码在 report/detectors.ts:34-43，
     无 D 号、不在本白名单、API 也不收覆盖参数——要调阈值必须改代码发版，
     而这三个数字没有业务归属，谁都不敢动。实测命中率 343/441=78% 的「有销量」成品，
     目录三分之一都在清单里等于没有清单。 */
  { kind: "number", key: "detector_sales_drop_pct", label: "销量骤停跌幅", fallback: 70, min: 30, max: 95, unit: "%", note: "E5-10：较前期均值跌幅超过即命中（末期为0直接命中）" },
  { kind: "number", key: "detector_channel_shift_pct", label: "渠道迁移阈值", fallback: 15, min: 5, max: 50, unit: "个百分点", note: "E5-10：任一渠道占比变化绝对值超过即命中" },
  { kind: "number", key: "detector_velocity_dev_pct", label: "速度突变偏离", fallback: 40, min: 15, max: 100, unit: "%", note: "E5-10：本期日均相对近3月基线偏离超过即命中（月度数据下 40% 属常态波动，建议校准后上调）" },
  { kind: "number", key: "auto_wo_on_bh", label: "BH审批自动建WO", fallback: 0, min: 0, max: 1, unit: "", note: "D33 自动链开关①（0=关；上线前须预演验证——spec/11）" },
  { kind: "number", key: "auto_jg_on_ready", label: "齐套自动JG草稿", fallback: 0, min: 0, max: 1, unit: "", note: "D33 自动链开关②（0=关；自动仅产草稿，审批留人工闸）" },
  { kind: "number", key: "batch_posting_enabled", label: "批次过账与FEFO", fallback: 0, min: 0, max: 1, unit: "", note: "E2-12 迁移闸门（默认关；历史余额迁移、全出库路径UAT后方可开启）" },
  /* ── 总监需求实施计划（2026-09-03，D50–D66）：口径类全部参数化，业务可改 ── */
  { kind: "number", key: "inventory_sales_ratio_target_low", label: "库存占比目标下限", fallback: 45, min: 0, max: 200, unit: "%", note: "D54：月末库存金额÷当月销售金额目标区间下限（基线 50）" },
  { kind: "number", key: "valuation_coverage_min_pct", label: "估值覆盖率门槛", fallback: 80, min: 0, max: 100, unit: "%", note: "D51：库存金额估值覆盖率低于本值时标「不完整」" },
  { kind: "number", key: "inventory_sales_ratio_target_high", label: "库存占比目标上限", fallback: 47, min: 0, max: 200, unit: "%", note: "D54：库存占比目标区间上限" },
  { kind: "number", key: "default_production_lead_days", label: "默认加工周期", fallback: 30, min: 0, max: 365, unit: "天", note: "D57：sku_params.normal_lead_days 缺省时的加工周期" },
  { kind: "number", key: "default_logistics_lead_days", label: "默认在途周期", fallback: 15, min: 0, max: 365, unit: "天", note: "D57：sku_params.logistics_lead_days 缺省时的在途周期" },
  { kind: "number", key: "alert_buffer_days", label: "预警缓冲天数", fallback: 5, min: 0, max: 90, unit: "天", note: "D57：库存预警阈值 = 加工周期 + 在途周期 + 本缓冲" },
  { kind: "number", key: "alert_learned_lead_tolerance_days", label: "学习交期容差", fallback: 3, min: 0, max: 60, unit: "天", note: "D57/交期学习：供应商实际交期 P90（样本≥3）比档案加工周期高出超过本值，预警阈值改用学习值并标「学习交期」" },
  { kind: "number", key: "grade_s_pct", label: "S级累计占比", fallback: 50, min: 1, max: 99, unit: "%", note: "D58：近 6 月销量累计占比 ≤ 本值记 S（须 < A 级）" },
  { kind: "number", key: "grade_a_pct", label: "A级累计占比", fallback: 80, min: 1, max: 99, unit: "%", note: "D58：累计占比 ≤ 本值记 A（须 < B 级）" },
  { kind: "number", key: "grade_b_pct", label: "B级累计占比", fallback: 95, min: 1, max: 99, unit: "%", note: "D58：累计占比 ≤ 本值记 B，其余 C" },
  {
    kind: "enum", key: "tier_basis", label: "分层主口径", fallback: "qty",
    options: [{ value: "qty", label: "数量口径（近 6 月销量）" }, { value: "value", label: "金额口径（销量×单位成本）" }],
    note: "W12：分层页/试点把哪一列标为「主口径」；金额口径只是并列对照尺，规则消费者仍读数量口径 tier，切换须另立 D 号",
  },
  { kind: "number", key: "spike_consecutive_days", label: "爆单连续天数", fallback: 3, min: 1, max: 14, unit: "天", note: "D56：最近 N 天每日销量均命中涨幅才判爆单" },
  { kind: "number", key: "spike_rise_pct", label: "爆单涨幅阈值", fallback: 50, min: 10, max: 500, unit: "%", note: "D56：日销量 ≥ 前 7 日日均 × (1+本值%) 记命中" },
  { kind: "number", key: "spike_min_base_qty", label: "爆单最小基数", fallback: 10, min: 0, max: 10000, unit: "件", note: "D56：前 7 日日均低于本值不判爆单（防小基数放大）" },
  { kind: "number", key: "transfer_cost_window_days", label: "调拨成本基线窗口", fallback: 180, min: 30, max: 730, unit: "天", note: "D60：同线路(from,to,type) 已完成单据数量加权均价的回看窗口" },
  { kind: "number", key: "transfer_cost_deviation_pct", label: "调拨成本偏差阈值", fallback: 20, min: 1, max: 200, unit: "%", note: "D60：单位调拨成本偏离基线超过即提醒（不阻断）" },
  { kind: "number", key: "transfer_qty_deviation_x", label: "调拨数量异常倍数", fallback: 3, min: 1, max: 20, unit: "倍", note: "D60：单据数量 > 同线路中位数 × 本值记异常" },
  { kind: "number", key: "transfer_batch_max_docs", label: "调拨零散上限", fallback: 4, min: 1, max: 50, unit: "单", note: "D60：30 天内同线路单据数超过本值记零散调拨" },
  { kind: "number", key: "warehouse_max_active", label: "启用仓库上限", fallback: 12, min: 1, max: 100, unit: "个", note: "D60：实体仓（finished/raw/packaging）启用数量上限提醒" },
  { kind: "number", key: "payment_term_min_years", label: "账期候选合作年限", fallback: 2, min: 0, max: 20, unit: "年", note: "D64：账期谈判候选 = 合作 ≥ 本值年且近 2 年采购额排名上升" },
  { kind: "number", key: "payment_term_target_min_days", label: "目标账期下限", fallback: 45, min: 0, max: 180, unit: "天", note: "D64：月结目标区间下限（≤ 上限）" },
  { kind: "number", key: "payment_term_target_max_days", label: "目标账期上限", fallback: 60, min: 0, max: 180, unit: "天", note: "D64：月结目标区间上限" },
  /* ── W2-G 采购订单指标 / OTIF（D63、D64） ── */
  { kind: "number", key: "otif_window_days", label: "OTIF 准时窗口", fallback: 2, min: 0, max: 30, unit: "天", note: "D63：全收完成日 ≤ 承诺交期 + 本值 记准时" },
  { kind: "number", key: "otif_qty_tolerance_pct", label: "OTIF 足量容差", fallback: 0, min: 0, max: 20, unit: "%", note: "D63：累计已收 ≥ 应收 × (1 − 本值%) 记足量" },
  { kind: "number", key: "po_expected_date_required", label: "PO 提交须填交期", fallback: 0, min: 0, max: 1, unit: "", note: "D63：1=提交 PO 时表头或逐行必须有承诺交期（OTIF 可评前提）；0=不强制" },
  { kind: "number", key: "dq_tolerance_pct", label: "数据质量一致容差", fallback: 1, min: 0, max: 20, unit: "%", note: "D65：SKU 日级数量差异 ≤ 本值视为一致" },
  { kind: "number", key: "dq_snapshot_qty_jump_pct", label: "快照总量跳变阈值", fallback: 30, min: 1, max: 500, unit: "%", note: "D65：同仓相邻快照 ΣQty 变动超过本值即告警 snapshot_quality" },
  { kind: "number", key: "dq_snapshot_vanished_pct", label: "快照消失 SKU 阈值", fallback: 10, min: 1, max: 100, unit: "%", note: "D65：相邻快照消失 SKU 占比超过本值即告警" },
  { kind: "number", key: "dq_sales_consistency_rel_pct", label: "销量一致性相对偏差", fallback: 15, min: 1, max: 100, unit: "%", note: "D65：sales_monthly 与天猫观察按 SKU×月相对偏差 ≥ 本值列为例外" },
  { kind: "number", key: "dq_sales_consistency_abs_floor_qty", label: "销量一致性绝对差下限", fallback: 20, min: 0, max: 100000, unit: "件", note: "D65：|差| ≥ 本值才计例外（防小数放大）" },
  { kind: "number", key: "dq_sales_consistency_min_base_qty", label: "销量一致性最低基数", fallback: 50, min: 0, max: 100000, unit: "件", note: "D65：max(两侧) ≥ 本值才纳入比较" },
  { kind: "number", key: "ops_demand_diff_pct", label: "运营提报核对阈值", fallback: 30, min: 1, max: 500, unit: "%", note: "D55/R3：运营提报量与系统基线（Holt 月量）差异绝对值 ≥ 本值标「需核对」" },
  /* R2 品类允许损耗率：只按品类维护（seed：包材 5、原料 2）；结算扣款直接读品类行，影响金额，故仅管理员可改 */
  {
    kind: "number", key: "loss_rate_pct", label: "品类允许损耗率", fallback: 0, min: 0, max: 100, unit: "%", scope: "category",
    note: "R2：结算（JS）按 category:<raw|packaging> 行扣超耗；无品类行 = 不扣损耗（不回落全局）。只在「分域覆盖」按品类维护",
  },
];

/**
 * D59 参数写权限键组：补货/分层/预警口径归 pmc（单一规则主体）；其余（比价容差、自动链开关、调拨、账期、数据质量、损耗率、分层口径开关）仍仅 admin。
 * 只在这里登记，updateParam 据此判定；页面通过 listParams 的 writableBy 展示。
 */
export const PMC_WRITABLE_PARAM_KEYS: readonly string[] = [
  "slow_days_threshold",
  "cover_alert_days",
  "cover_target_days",
  "cover_target_days_a",
  "cover_target_days_b",
  "cover_target_days_c",
  "replenish_max_order_cover_days",
  "replenish_overshoot_warn_days",
  "safety_days_fallback",
  "service_level_pct",
  "detector_sales_drop_pct",
  "detector_channel_shift_pct",
  "detector_velocity_dev_pct",
  "default_production_lead_days",
  "default_logistics_lead_days",
  "alert_buffer_days",
  "alert_learned_lead_tolerance_days",
  "grade_s_pct",
  "grade_a_pct",
  "grade_b_pct",
  "spike_consecutive_days",
  "spike_rise_pct",
  "spike_min_base_qty",
  "ops_demand_diff_pct",
];

export function paramDef(key: string): ParamDef | undefined {
  return PARAM_DEFS.find((d) => d.key === key);
}

/** 数值参数缺省（唯一权威）；未登记或非数值参数抛错——这是编程错误，不能静默回落 */
export function numParamFallback(key: string): number {
  const def = paramDef(key);
  if (!def) throw new Error(`未登记的运行参数键：${key}（请先登记 core/param-defs.PARAM_DEFS）`);
  if (def.kind !== "number") throw new Error(`运行参数 ${key} 不是数值型，请用 getTextParam`);
  return def.fallback;
}

/** 枚举/文本参数缺省（唯一权威） */
export function textParamFallback(key: string): string {
  const def = paramDef(key);
  if (!def) throw new Error(`未登记的运行参数键：${key}（请先登记 core/param-defs.PARAM_DEFS）`);
  if (def.kind !== "enum") throw new Error(`运行参数 ${key} 不是枚举型，请用 getNumParam`);
  return def.fallback;
}
