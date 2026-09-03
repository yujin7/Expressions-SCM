/**
 * D60 调拨成本/数量/零散看门狗（category=transfer_cost）——沿用 jobs/freshness.ts 范式：
 * 逐 refKey 检查，命中即开 system_alerts（同 refKey 已有 open 项不重复开，幂等），
 * 不再命中则自动关闭（autoResolved）。system_alerts 属系统写入（无 id=0 伪用户），不写 audit_logs
 * （与 freshness / snapshot-age 同口径，计划 §critique #6）。
 *
 * 信号来源只消费 report/transfer-routes 读模型（rules/transfer-cost 唯一权威，强制重算不吃缓存）：
 * - refKey `doc:<docNo>`：费用偏差 alert（severity high）/ watch（medium）、数量异常 watch（medium）；
 * - refKey `lane:<from>><to>:<type>`：零散线路（30 天 > transfer_batch_max_docs 单，medium）。
 * 本文件只导出 run，不在 interval-runner/scheduler 登记（由编排方登记：建议 "15 11,17 * * *"）。
 *
 * system_alerts 不经金额剥离、任何角色都可读：title/detail 只能用读模型的**不带数值**判定文案
 * （feeReason/qtyReason），绝不拼 feePctDev/feeZ/unitFee/amount——偏差百分比与 σ 反推得出单位费用
 * （tests/jobs/transfer-cost-watchdog.test.ts 钉住 detail 不含 %/σ）。
 */
import { and, eq, sql } from "drizzle-orm";
import { systemAlerts } from "@/db/schema";
import type { AnyDb } from "@/server/core/svc";
import { refreshTransferRoutes, type TransferRoutesModel } from "@/server/modules/report/transfer-routes";

export const ALERT_CATEGORY = "transfer_cost";

export interface TransferCostWatchdogSummary {
  opened: number;
  autoClosed: number;
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
}

export function buildSignals(model: TransferRoutesModel): Signal[] {
  const out: Signal[] = [];
  for (const a of model.anomalies) {
    const lane = `${a.fromWarehouse}→${a.toWarehouse}（${a.transferTypeLabel}）`;
    const parts: string[] = [];
    if (a.feeLevel !== "ok") parts.push(`费用：${a.feeReason}`);
    if (a.qtyLevel === "watch") parts.push(`数量：${a.qtyReason}`);
    out.push({
      refKey: `doc:${a.docNo}`,
      title: a.level === "alert" ? `调拨成本异常：${a.docNo} ${lane}` : `调拨提醒：${a.docNo} ${lane}`,
      detail: `${parts.join("；")}（完成日 ${a.date}，件数 ${a.qty}，样本 ${a.feeSamples}${a.feeInsufficient ? "，样本不足仅提醒" : ""}）——请到 库存→调拨线路与费用→异常 复核`,
      severity: a.level === "alert" ? "high" : "medium",
    });
  }
  for (const l of model.lanes) {
    if (!l.scattered) continue;
    out.push({
      refKey: `lane:${l.laneKey}`,
      title: `零散调拨：${l.fromWarehouse}→${l.toWarehouse}（${l.transferTypeLabel}）近 30 天 ${l.docCount30} 单`,
      detail: `同线路 30 天内 ${l.docCount30} 单，超过零散上限 ${model.params.batchMaxDocs} 单（transfer_batch_max_docs）；建议合并批次调拨——查看 库存→调拨线路与费用`,
      severity: "medium",
    });
  }
  return out;
}

export async function run(db: AnyDb, opts?: { now?: Date; asOf?: string }): Promise<TransferCostWatchdogSummary> {
  const now = opts?.now ?? new Date();
  const model = await refreshTransferRoutes(db, { asOf: opts?.asOf });
  const signals = buildSignals(model);
  const hitKeys = new Set(signals.map((s) => s.refKey));

  const open: { id: number; refKey: string | null }[] = await db
    .select({ id: systemAlerts.id, refKey: systemAlerts.refKey })
    .from(systemAlerts)
    .where(and(eq(systemAlerts.category, ALERT_CATEGORY), eq(systemAlerts.status, "open")));
  const openByKey = new Map<string, number[]>();
  for (const o of open) {
    const k = o.refKey ?? "";
    openByKey.set(k, [...(openByKey.get(k) ?? []), o.id]);
  }

  // 人工关闭（autoResolved=false）的同 refKey 在 180 天内不重开：本类条件在窗口内恒成立，否则每次 cron 都会重开（审阅 must-fix）
  const manuallyClosedRows: { refKey: string | null }[] = await db
    .select({ refKey: systemAlerts.refKey })
    .from(systemAlerts)
    .where(and(eq(systemAlerts.category, ALERT_CATEGORY), eq(systemAlerts.status, "resolved"), eq(systemAlerts.autoResolved, false),
      sql`${systemAlerts.resolvedAt} >= ${new Date(now.getTime() - 180 * 24 * 3600 * 1000).toISOString()}::timestamptz`));
  const manuallyClosed = new Set(manuallyClosedRows.map((r) => r.refKey ?? ""));
  let opened = 0;
  let autoClosed = 0;
  for (const s of signals) {
    if ((openByKey.get(s.refKey) ?? []).length > 0) continue; // 幂等：已有 open 项不重复开
    if (manuallyClosed.has(s.refKey)) continue; // 人工已处理，不重开
    await db.insert(systemAlerts).values({ category: ALERT_CATEGORY, refKey: s.refKey, title: s.title, detail: s.detail, severity: s.severity });
    opened++;
  }
  for (const [k, ids] of openByKey) {
    if (hitKeys.has(k)) continue;
    for (const id of ids) {
      await db
        .update(systemAlerts)
        .set({ status: "resolved", autoResolved: true, resolvedAt: now })
        .where(eq(systemAlerts.id, id));
      autoClosed++;
    }
  }
  return {
    opened,
    autoClosed,
    hits: [...hitKeys].sort(),
    anomalyCount: model.anomalies.length,
    scatteredLaneCount: model.summary.scatteredLaneCount,
  };
}
