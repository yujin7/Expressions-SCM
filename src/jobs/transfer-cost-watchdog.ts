/**
 * D60 调拨成本/数量/零散看门狗（category=transfer_cost）——审计 #10 起改走 alerts/engine.upsertAlerts：
 * 去重键幂等（dedupeKey = transfer_cost:<refKey>，数据库部分唯一索引兜底）、责任角色 warehouse、动作链接、
 * sourceRule/paramsSnapshot/why 同行落库；不再命中即刻自动关闭（autoCloseAfterDays=0：费用红字/单据变化是硬事实，
 * 不需要数据缺口迟滞）。system_alerts 属系统写入（无 id=0 伪用户），不写 audit_logs（与 freshness / snapshot-age 同口径）。
 *
 * 人工关闭 180 天不重开：本类条件在窗口内恒成立，否则每次 cron 都会重开（审阅 must-fix）——
 * 现由引擎 suppressManuallyClosedDays 统一承担（按 dedupeKey）。
 *
 * 一次性回填：历史行（引擎接入前）没有 dedupe_key，本 run 开头把 category=transfer_cost 且 dedupe_key 为空的行
 * 按 ref_key 补成 transfer_cost:<ref_key>——open 行同键只补最早一条（部分唯一索引不允许两条 open 同键；
 * 多余的 open 行留空键交给引擎迟滞关闭），resolved 行全部补（让 180 天人工关闭抑制对历史关闭也生效）。
 *
 * 信号来源只消费 report/transfer-routes 读模型（rules/transfer-cost 唯一权威，强制重算不吃缓存）：
 * - refKey `doc:<docNo>`：费用偏差 alert（severity high）/ watch（medium）、数量异常 watch（medium）；
 * - refKey `lane:<from>><to>:<type>`：零散线路（30 天 > transfer_batch_max_docs 单，medium）。
 * 本文件只导出 run，不在 interval-runner/scheduler 登记（由编排方登记：建议 "15 11,17 * * *"）。
 *
 * system_alerts 不经金额剥离、任何角色都可读：title/detail/why 只能用读模型的**不带数值**判定文案
 * （feeReason/qtyReason/档位），绝不拼 feePctDev/feeZ/unitFee/amount——偏差百分比与 σ 反推得出单位费用
 * （tests/jobs/transfer-cost-watchdog.test.ts 钉住 detail 与 why 不含 %/σ）。
 */
import type { AnyDb } from "@/server/core/svc";
import { backfillAlertDedupeKeys, upsertAlerts, type AlertCandidate, type AlertWhy } from "@/server/modules/alerts/engine";
import { refreshTransferRoutes, type TransferRoutesModel } from "@/server/modules/report/transfer-routes";

export const ALERT_CATEGORY = "transfer_cost";
export const TRANSFER_COST_SOURCE_RULE = "rules/transfer-cost";
export const TRANSFER_COST_ACTION_HREF = "/inventory/transfer-routes?tab=anomalies";
/** 人工关闭后不重开的窗口（天） */
export const MANUAL_CLOSE_SUPPRESS_DAYS = 180;

export interface TransferCostWatchdogSummary {
  opened: number;
  refreshed: number;
  autoClosed: number;
  /** 人工关闭 180 天内抑制未开 */
  suppressed: number;
  /** 本轮回填 dedupe_key 的历史行数 */
  backfilled: number;
  /** 本轮命中的 refKey */
  hits: string[];
  anomalyCount: number;
  scatteredLaneCount: number;
}

interface Signal {
  refKey: string;
  title: string;
  detail: string;
  severity: "high" | "medium";
  why: AlertWhy[];
  paramsSnapshot: Record<string, unknown>;
}

export function dedupeKeyOf(refKey: string): string {
  return `${ALERT_CATEGORY}:${refKey}`;
}

export function buildSignals(model: TransferRoutesModel): Signal[] {
  const out: Signal[] = [];
  for (const a of model.anomalies) {
    const lane = `${a.fromWarehouse}→${a.toWarehouse}（${a.transferTypeLabel}）`;
    const parts: string[] = [];
    const why: AlertWhy[] = [];
    if (a.feeLevel !== "ok") {
      parts.push(`费用：${a.feeReason}`);
      why.push({ label: "费用判定", value: a.feeReason, source: TRANSFER_COST_SOURCE_RULE });
    }
    if (a.qtyLevel === "watch") {
      parts.push(`数量：${a.qtyReason}`);
      why.push({ label: "数量判定", value: a.qtyReason, source: TRANSFER_COST_SOURCE_RULE });
    }
    why.push({ label: "档位", value: a.level === "alert" ? "异常（alert）" : "提醒（watch）", source: TRANSFER_COST_SOURCE_RULE });
    why.push({ label: "样本", value: `${a.feeSamples} 单${a.feeInsufficient ? "（样本不足仅提醒）" : ""}`, source: "report/transfer-routes" });
    out.push({
      refKey: `doc:${a.docNo}`,
      title: a.level === "alert" ? `调拨成本异常：${a.docNo} ${lane}` : `调拨提醒：${a.docNo} ${lane}`,
      detail: `${parts.join("；")}（完成日 ${a.date}，件数 ${a.qty}，样本 ${a.feeSamples}${a.feeInsufficient ? "，样本不足仅提醒" : ""}）——请到 库存→调拨线路与费用→异常 复核`,
      severity: a.level === "alert" ? "high" : "medium",
      why,
      // 只放不可反推单位费用的字段（档位/样本/日期/件数）；偏差%、σ、单位费用绝不进快照
      paramsSnapshot: { docNo: a.docNo, level: a.level, feeLevel: a.feeLevel, qtyLevel: a.qtyLevel, feeSamples: a.feeSamples, feeInsufficient: a.feeInsufficient, date: a.date, qty: a.qty },
    });
  }
  for (const l of model.lanes) {
    if (!l.scattered) continue;
    out.push({
      refKey: `lane:${l.laneKey}`,
      title: `零散调拨：${l.fromWarehouse}→${l.toWarehouse}（${l.transferTypeLabel}）近 30 天 ${l.docCount30} 单`,
      detail: `同线路 30 天内 ${l.docCount30} 单，超过零散上限 ${model.params.batchMaxDocs} 单（transfer_batch_max_docs）；建议合并批次调拨——查看 库存→调拨线路与费用`,
      severity: "medium",
      why: [
        { label: "30 天单数", value: `${l.docCount30} 单`, source: "report/transfer-routes" },
        { label: "零散上限", value: `${model.params.batchMaxDocs} 单（transfer_batch_max_docs）`, source: "sys_params" },
      ],
      paramsSnapshot: { laneKey: l.laneKey, docCount30: l.docCount30, batchMaxDocs: model.params.batchMaxDocs },
    });
  }
  return out;
}

/**
 * 一次性回填历史行的 dedupe_key —— 实现已上收到 alerts/engine.backfillAlertDedupeKeys（各看门狗共用）。
 * 保留本导出名：既有调用方与测试按本名引用。
 */
export function backfillDedupeKeys(db: AnyDb): Promise<number> {
  return backfillAlertDedupeKeys(db, ALERT_CATEGORY);
}

export async function run(db: AnyDb, opts?: { now?: Date; asOf?: string }): Promise<TransferCostWatchdogSummary> {
  const now = opts?.now ?? new Date();
  const backfilled = await backfillDedupeKeys(db);
  const model = await refreshTransferRoutes(db, { asOf: opts?.asOf });
  const signals = buildSignals(model);
  const candidates: AlertCandidate[] = signals.map((s) => ({
    refKey: s.refKey,
    dedupeKey: dedupeKeyOf(s.refKey),
    title: s.title,
    detail: s.detail,
    severity: s.severity,
    ownerRole: "warehouse",
    actionHref: TRANSFER_COST_ACTION_HREF,
    sourceRule: TRANSFER_COST_SOURCE_RULE,
    paramsSnapshot: { ...s.paramsSnapshot, asOf: model.asOf },
    why: s.why,
  }));
  const res = await upsertAlerts(db, {
    category: ALERT_CATEGORY, candidates, now,
    autoCloseAfterDays: 0, // 不再命中即关：费用/单据事实变化不是数据缺口
    suppressManuallyClosedDays: MANUAL_CLOSE_SUPPRESS_DAYS,
  });
  return {
    opened: res.opened,
    refreshed: res.refreshed,
    autoClosed: res.autoClosed,
    suppressed: res.suppressed,
    backfilled,
    hits: signals.map((s) => s.refKey).sort(),
    anomalyCount: model.anomalies.length,
    scatteredLaneCount: model.summary.scatteredLaneCount,
  };
}
