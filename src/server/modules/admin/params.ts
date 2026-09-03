/**
 * 运行参数维护（D39 阈值参数化 + 既有 R 规则参数统一入口）。
 * 白名单制：仅暴露登记过的 global 参数；写=admin，读=admin/pmc/purchasing/finance。
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { sysParams } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { clearParamCache } from "@/server/core/params";
import { ApiError, type SessionUser } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export interface ParamDef {
  key: string;
  label: string;
  fallback: number;
  min: number;
  max: number;
  unit: string;
  note: string;
}

/** 白名单（含缺省与边界；D 号=裁决出处） */
export const PARAM_DEFS: ParamDef[] = [
  { key: "price_tolerance_pct", label: "价格异动容差", fallback: 3, min: 0, max: 50, unit: "%", note: "R1 比价硬门（D4，UAT 校准）" },
  { key: "over_receive_tolerance_pct", label: "超收容差", fallback: 0, min: 0, max: 20, unit: "%", note: "收货超单比例上限" },
  { key: "concession_price_ratio", label: "让步默认价率", fallback: 100, min: 0, max: 100, unit: "%", note: "让步接收结算价比例（D6）" },
  { key: "slow_days_threshold", label: "滞销警戒阈值", fallback: 180, min: 30, max: 720, unit: "天", note: "可销天数超过即判滞销（D39/0724 会议）" },
  { key: "cover_alert_days", label: "断货预警阈值", fallback: 30, min: 3, max: 180, unit: "天", note: "可销天数低于即预警（R11/驾驶舱）" },
  { key: "cover_target_days", label: "补货目标覆盖", fallback: 45, min: 7, max: 365, unit: "天", note: "补货建议的目标覆盖天数（R11，未分层默认）" },
  { key: "cover_target_days_a", label: "A类目标覆盖", fallback: 60, min: 7, max: 365, unit: "天", note: "func#14 分层策略：A类(销量前80%)目标覆盖——高价值多备缓冲" },
  { key: "cover_target_days_b", label: "B类目标覆盖", fallback: 45, min: 7, max: 365, unit: "天", note: "func#14：B类(次15%)目标覆盖" },
  { key: "cover_target_days_c", label: "C类目标覆盖", fallback: 25, min: 7, max: 365, unit: "天", note: "func#14：C类(长尾5%)目标覆盖——少备减压库" },
  { key: "safety_days_fallback", label: "安全库存兜底天数", fallback: 7, min: 0, max: 90, unit: "天", note: "E2-01：统计法不可用（样本<3月或缺生产周期）时按此天数×日均兜底" },
  { key: "service_level_pct", label: "目标服务水平", fallback: 95, min: 90, max: 99, unit: "%", note: "E2-01：安全库存 z 值档位（90/95/97.5→98取95、99）" },
  /* 异动侦测三阈值（2026-07-25 审计收编）：此前硬编码在 report/detectors.ts:34-43，
     无 D 号、不在本白名单、API 也不收覆盖参数——要调阈值必须改代码发版，
     而这三个数字没有业务归属，谁都不敢动。实测命中率 343/441=78% 的「有销量」成品，
     目录三分之一都在清单里等于没有清单。 */
  { key: "detector_sales_drop_pct", label: "销量骤停跌幅", fallback: 70, min: 30, max: 95, unit: "%", note: "E5-10：较前期均值跌幅超过即命中（末期为0直接命中）" },
  { key: "detector_channel_shift_pct", label: "渠道迁移阈值", fallback: 15, min: 5, max: 50, unit: "个百分点", note: "E5-10：任一渠道占比变化绝对值超过即命中" },
  { key: "detector_velocity_dev_pct", label: "速度突变偏离", fallback: 40, min: 15, max: 100, unit: "%", note: "E5-10：本期日均相对近3月基线偏离超过即命中（月度数据下 40% 属常态波动，建议校准后上调）" },
  { key: "auto_wo_on_bh", label: "BH审批自动建WO", fallback: 0, min: 0, max: 1, unit: "", note: "D33 自动链开关①（0=关；上线前须预演验证——spec/11）" },
  { key: "auto_jg_on_ready", label: "齐套自动JG草稿", fallback: 0, min: 0, max: 1, unit: "", note: "D33 自动链开关②（0=关；自动仅产草稿，审批留人工闸）" },
  { key: "batch_posting_enabled", label: "批次过账与FEFO", fallback: 0, min: 0, max: 1, unit: "", note: "E2-12 迁移闸门（默认关；历史余额迁移、全出库路径UAT后方可开启）" },
  /* ── 总监需求实施计划（2026-09-03，D50–D66）：口径类全部参数化，业务可改 ── */
  { key: "inventory_sales_ratio_target_low", label: "库存占比目标下限", fallback: 45, min: 0, max: 200, unit: "%", note: "D54：月末库存金额÷当月销售金额目标区间下限（基线 50）" },
  { key: "inventory_sales_ratio_target_high", label: "库存占比目标上限", fallback: 47, min: 0, max: 200, unit: "%", note: "D54：库存占比目标区间上限" },
  { key: "default_production_lead_days", label: "默认加工周期", fallback: 30, min: 0, max: 365, unit: "天", note: "D57：sku_params.normal_lead_days 缺省时的加工周期" },
  { key: "default_logistics_lead_days", label: "默认在途周期", fallback: 15, min: 0, max: 365, unit: "天", note: "D57：sku_params.logistics_lead_days 缺省时的在途周期" },
  { key: "alert_buffer_days", label: "预警缓冲天数", fallback: 5, min: 0, max: 90, unit: "天", note: "D57：库存预警阈值 = 加工周期 + 在途周期 + 本缓冲" },
  { key: "grade_s_pct", label: "S级累计占比", fallback: 50, min: 1, max: 99, unit: "%", note: "D58：近 6 月销量累计占比 ≤ 本值记 S（须 < A 级）" },
  { key: "grade_a_pct", label: "A级累计占比", fallback: 80, min: 1, max: 99, unit: "%", note: "D58：累计占比 ≤ 本值记 A（须 < B 级）" },
  { key: "grade_b_pct", label: "B级累计占比", fallback: 95, min: 1, max: 99, unit: "%", note: "D58：累计占比 ≤ 本值记 B，其余 C" },
  { key: "spike_consecutive_days", label: "爆单连续天数", fallback: 3, min: 1, max: 14, unit: "天", note: "D56：最近 N 天每日销量均命中涨幅才判爆单" },
  { key: "spike_rise_pct", label: "爆单涨幅阈值", fallback: 50, min: 10, max: 500, unit: "%", note: "D56：日销量 ≥ 前 7 日日均 × (1+本值%) 记命中" },
  { key: "spike_min_base_qty", label: "爆单最小基数", fallback: 10, min: 0, max: 10000, unit: "件", note: "D56：前 7 日日均低于本值不判爆单（防小基数放大）" },
  { key: "transfer_cost_window_days", label: "调拨成本基线窗口", fallback: 180, min: 30, max: 730, unit: "天", note: "D60：同线路(from,to,type) 已完成单据数量加权均价的回看窗口" },
  { key: "transfer_cost_deviation_pct", label: "调拨成本偏差阈值", fallback: 20, min: 1, max: 200, unit: "%", note: "D60：单位调拨成本偏离基线超过即提醒（不阻断）" },
  { key: "transfer_qty_deviation_x", label: "调拨数量异常倍数", fallback: 3, min: 1, max: 20, unit: "倍", note: "D60：单据数量 > 同线路中位数 × 本值记异常" },
  { key: "transfer_batch_max_docs", label: "调拨零散上限", fallback: 4, min: 1, max: 50, unit: "单", note: "D60：30 天内同线路单据数超过本值记零散调拨" },
  { key: "warehouse_max_active", label: "启用仓库上限", fallback: 12, min: 1, max: 100, unit: "个", note: "D60：实体仓（finished/raw/packaging）启用数量上限提醒" },
  { key: "payment_term_min_years", label: "账期候选合作年限", fallback: 2, min: 0, max: 20, unit: "年", note: "D64：账期谈判候选 = 合作 ≥ 本值年且近 2 年采购额排名上升" },
  { key: "payment_term_target_min_days", label: "目标账期下限", fallback: 45, min: 0, max: 180, unit: "天", note: "D64：月结目标区间下限（≤ 上限）" },
  { key: "payment_term_target_max_days", label: "目标账期上限", fallback: 60, min: 0, max: 180, unit: "天", note: "D64：月结目标区间上限" },
  /* ── W2-G 采购订单指标 / OTIF（D63、D64） ── */
  { key: "otif_window_days", label: "OTIF 准时窗口", fallback: 2, min: 0, max: 30, unit: "天", note: "D63：全收完成日 ≤ 承诺交期 + 本值 记准时" },
  { key: "otif_qty_tolerance_pct", label: "OTIF 足量容差", fallback: 0, min: 0, max: 20, unit: "%", note: "D63：累计已收 ≥ 应收 × (1 − 本值%) 记足量" },
  { key: "po_expected_date_required", label: "PO 提交须填交期", fallback: 0, min: 0, max: 1, unit: "", note: "D63：1=提交 PO 时表头或逐行必须有承诺交期（OTIF 可评前提）；0=不强制" },
  { key: "dq_tolerance_pct", label: "数据质量一致容差", fallback: 1, min: 0, max: 20, unit: "%", note: "D65：SKU 日级数量差异 ≤ 本值视为一致" },
];

export async function listParams(dbArg?: AnyDb): Promise<(ParamDef & { value: number; isDefault: boolean; lastChangedBy: string | null; lastChangedAt: string | null })[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const rows: { key: string; value: string }[] = await db
    .select({ key: sysParams.key, value: sysParams.value })
    .from(sysParams)
    .where(eq(sysParams.scope, "global"));
  const byKey = new Map(rows.map((r) => [r.key, Number(r.value)]));
  /* #17：最近修改人/时间——audit_log entity=sys_param 逐键取最新一条 */
  const auditRows: { after: unknown; createdAt: Date; name: string | null }[] = await db
    .select({ after: schema.auditLogs.after, createdAt: schema.auditLogs.createdAt, name: schema.users.name })
    .from(schema.auditLogs)
    .leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
    .where(eq(schema.auditLogs.entity, "sys_param"))
    .orderBy(desc(schema.auditLogs.id));
  const lastByKey = new Map<string, { by: string | null; at: string }>();
  for (const a of auditRows) {
    const key = (a.after as { key?: string } | null)?.key;
    if (key && !lastByKey.has(key)) lastByKey.set(key, { by: a.name, at: a.createdAt.toISOString().slice(0, 16).replace("T", " ") });
  }
  return PARAM_DEFS.map((d) => {
    const v = byKey.get(d.key);
    const ok = v != null && Number.isFinite(v);
    const last = lastByKey.get(d.key);
    return { ...d, value: ok ? (v as number) : d.fallback, isDefault: !ok, lastChangedBy: last?.by ?? null, lastChangedAt: last?.at ?? null };
  });
}

const updateSchema = z.object({ key: z.string(), value: z.number().finite() });

export async function updateParam(user: SessionUser, input: unknown, dbArg?: AnyDb): Promise<void> {
  if (!user.roles.includes("admin")) throw new ApiError(403, "仅管理员可修改运行参数");
  const v = updateSchema.parse(input);
  const def = PARAM_DEFS.find((d) => d.key === v.key);
  if (!def) throw new ApiError(400, "未登记的参数键");
  if (v.value < def.min || v.value > def.max) {
    throw new ApiError(400, `「${def.label}」取值须在 ${def.min}–${def.max}${def.unit} 之间`);
  }
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const [old] = await db
    .select({ value: sysParams.value })
    .from(sysParams)
    .where(and(eq(sysParams.scope, "global"), eq(sysParams.key, v.key)));
  if (v.key === "batch_posting_enabled" && String(v.value) !== (old?.value ?? String(def.fallback))) {
    if (v.value === 1) {
      throw new ApiError(409, "批次过账必须通过同页「上线体检」确认后启用，不能作为普通参数直接修改");
    }
    throw new ApiError(409, "批次过账启用后不可直接关闭；回退必须走库存迁移与专项变更流程");
  }
  await db
    .insert(sysParams)
    .values({ scope: "global", key: v.key, value: String(v.value), note: def.label })
    .onConflictDoUpdate({ target: [sysParams.scope, sysParams.key], set: { value: String(v.value) } });
  clearParamCache();
  await writeAudit(db, {
    userId: user.id,
    entity: "sys_param",
    action: "update",
    before: { key: v.key, value: old?.value ?? null },
    after: { key: v.key, value: v.value },
  });
}
