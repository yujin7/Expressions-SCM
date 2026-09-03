import type { AnyDb } from "@/server/core/svc";
import { upsertAlerts, type AlertCandidate, type AlertWhy } from "@/server/modules/alerts/engine";
import { refreshInventoryAlerts, type InventoryAlertRow } from "@/server/modules/report/inventory-alerts";
import { refreshSalesSpike, type SpikeHit } from "@/server/modules/report/sales-spike";
import { ALERT_KIND_LABELS } from "@/server/rules/alert-priority";

/**
 * 预警看门狗（D56/D57）：重建读模型 → 投影为 system_alerts（去重键幂等、迟滞 3 天自动关闭）。
 * 断货/低于阈值只对 S/A/B 级开告警，C 级仅列表；爆单已映射按 SKU、未映射按平台 SKU 各自开告警。
 *
 * 审计 #4：每条候选带 why[]（label/value/source）——阈值依据、主日销口径与窗口、优先级分拆项、等级来源、
 * 下一笔到货、爆单 reason/gaps/大促事件——全部来自读模型已算好的字段，看门狗不重算任何事实。
 * 审计 #1：在库 alert 但阈值内有确认到货的行已由读模型降为 watch，因此不再开告警（自然迟滞关闭）。
 * 审计 #7：大促预期内的爆单降为 medium 而不是丢弃——跑到自己预期 3 倍仍是新闻。
 */
const DAILY_SOURCE_LABEL: Record<NonNullable<InventoryAlertRow["primaryDailySource"]>, string> = {
  external: "外部平台净件数（支付−退款）近 30 天 ÷ 30",
  internal: "销量月表近 6 月折日",
  ledger: "实时仓流水近 30 天出库 ÷ 30（含调拨/发料）",
};

export function coverWhy(r: InventoryAlertRow): AlertWhy[] {
  const why: AlertWhy[] = [];
  why.push({
    label: "在库可销",
    value: r.coverDays == null ? `无主日销（在库 ${r.onHand}）` : `${r.coverDays} 天 = 在库 ${r.onHand} ÷ 主日销 ${r.primaryDaily}`,
    source: "core/stock-view + core/velocity",
  });
  if (r.primaryDailySource) {
    const win = r.primaryDailySource === "external" ? `净件数 ${r.net30External ?? "—"}` : r.primaryDailySource === "internal" ? `内部 ${r.daily.internal ?? "—"}/日` : `实时仓 ${r.daily.ledger ?? "—"}/日`;
    why.push({ label: "主日销口径", value: `${DAILY_SOURCE_LABEL[r.primaryDailySource]}（${win}；取外部 > 内部 > 实时仓）`, source: "report/inventory-alerts" });
  }
  why.push({ label: "阈值", value: `${r.alertDays} 天 = ${r.alertBasis}${r.usedDefault ? "（含缺省周期）" : ""}`, source: "rules/alert-threshold" });
  if (r.learnedLead) {
    const l = r.learnedLead;
    why.push({
      label: "学习交期（只观察）",
      value: `P90 ${l.p90} 天 vs 档案 ${l.archiveDays} 天，+${l.delta} 天（n=${l.samples}${l.onTimeRate != null ? `，准时率 ${Math.round(l.onTimeRate * 100)}%` : ""}，容差 ${l.toleranceDays} 天）——本周期阈值未变`,
      source: "rollup_supplier_lead",
    });
  }
  if (r.nextArrival) {
    why.push({
      label: "下一笔到货",
      value: `${r.nextArrival.source}${r.nextArrival.ref ? ` ${r.nextArrival.ref}` : ""} ${r.nextArrival.qty} 件预计 ${r.nextArrival.date}；含在途可销 ${r.coverDaysWithSupply ?? "—"} 天${r.inTransitUndated > 0 ? `；另 ${r.inTransitUndated} 件无到货日` : ""}${r.inTransitOverdue > 0 ? `；${r.inTransitOverdue} 件已逾期` : ""}`,
      source: "core/supply",
    });
  } else {
    why.push({
      label: "在途",
      value: r.inTransitUndated > 0 || r.inTransitOverdue > 0
        ? `无确认到货日的可信供给（${r.inTransitUndated > 0 ? `${r.inTransitUndated} 件无到货日` : ""}${r.inTransitUndated > 0 && r.inTransitOverdue > 0 ? "，" : ""}${r.inTransitOverdue > 0 ? `${r.inTransitOverdue} 件已逾期` : ""}）`
        : "无未结供给",
      source: "core/supply",
    });
  }
  if (r.statusBasis) why.push({ label: "供给降级", value: r.statusBasis, source: "rules/alert-threshold" });
  why.push({ label: "等级", value: `${r.tier ?? "未分层"}（${r.tierSource === "policy" ? "分层固化 sku_planning_policy" : r.tierSource === "computed" ? "近 6 月内部销量现算" : "无"}）`, source: r.tierSource === "policy" ? "sku_planning_policy" : "rules/abc" });
  why.push({
    label: "优先级分",
    value: `${r.priorityScore} = ${r.priorityFormula}：${r.priorityTerms.dailyAvg ?? "—"} × ${r.priorityTerms.gapDays}（阈值 ${r.priorityTerms.alertDays} − 可销 ${r.priorityTerms.coverDays ?? "—"}）`,
    source: "rules/alert-priority",
  });
  why.push({ label: "主预警", value: `${r.primary ? ALERT_KIND_LABELS[r.primary] : "—"}${r.tags.length ? `；标签：${r.tags.map((t) => ALERT_KIND_LABELS[t]).join("、")}` : ""}`, source: "rules/alert-priority" });
  return why;
}

export function spikeWhy(h: SpikeHit): AlertWhy[] {
  const why: AlertWhy[] = [
    { label: "判定", value: h.reason, source: "rules/sales-spike" },
    { label: "窗口", value: `最近 ${h.days.length} 天 ${h.days.map((d) => `${d.date.slice(5)}:${d.qty}`).join(" / ")}，截止 ${h.anchorDate}`, source: "jdy tmall-sku-sales-observation" },
    { label: "基线", value: `${h.baseline} 件/日（前 7 日日均），门槛 ${h.threshold}`, source: "rules/sales-spike" },
  ];
  if (h.gaps > 0) why.push({ label: "缺天", value: `判定 + 基线窗口缺 ${h.gaps} 天（按 0 计，涨幅被放大，证据打折）`, source: "rules/sales-spike" });
  if (h.expected) {
    why.push({ label: "大促预期内", value: `${h.planEventWindow ?? "大促"}（事件 #${h.planEventRef}${h.expectedUpliftPct != null ? `，预期涨幅 ${h.expectedUpliftPct}%` : "，未填预期涨幅"}）——严重度降为 medium，不丢弃`, source: "ops_plan_events" });
  }
  return why;
}

export async function runInventoryCoverWatchdog(db: AnyDb, now = new Date()) {
  const model = await refreshInventoryAlerts(db);
  const candidates: AlertCandidate[] = model.rows
    .filter((r) => (r.primary === "out_of_stock" || r.status === "alert") && r.tier !== "C" && r.tier != null)
    .map((r) => ({
      refKey: r.code,
      dedupeKey: `inventory_cover:${r.skuId}`,
      title: r.primary === "out_of_stock" ? `${r.tier} 级 ${r.code} 已断货（有需求无在库）` : `${r.tier} 级 ${r.code} 可销 ${r.coverDays ?? "—"} 天 < 阈值 ${r.alertDays} 天`,
      detail: `在库 ${r.onHand}；主日销 ${r.primaryDaily ?? "—"}（${r.primaryDailySource ?? "无"}）；阈值 = ${r.alertBasis}${r.usedDefault ? "（含缺省周期）" : ""}${r.nextArrival ? `；下一笔到货 ${r.nextArrival.date} ${r.nextArrival.qty} 件` : ""}`,
      severity: r.primary === "out_of_stock" || r.tier === "S" ? "high" : "medium",
      ownerRole: "pmc",
      actionHref: `/inventory/alerts?tab=cover&cover_q=${encodeURIComponent(r.code)}`,
      sourceRule: "rules/alert-threshold + rules/alert-priority",
      paramsSnapshot: {
        ...model.params, coverDays: r.coverDays, coverDaysWithSupply: r.coverDaysWithSupply, alertDays: r.alertDays, primaryDailySource: r.primaryDailySource,
        nextArrival: r.nextArrival, inTransitDated: r.inTransitDated, inTransitUndated: r.inTransitUndated, inTransitOverdue: r.inTransitOverdue,
        learnedLead: r.learnedLead, priorityScore: r.priorityScore, priorityTerms: r.priorityTerms, statusOnHand: r.statusOnHand, statusBasis: r.statusBasis,
        primary: r.primary, tags: r.tags,
      },
      why: coverWhy(r),
    }));
  const res = await upsertAlerts(db, { category: "inventory_cover", candidates, now });
  return { category: "inventory_cover", rows: model.rows.length, candidates: candidates.length, downgradedBySupply: model.totals.downgradedBySupply, ...res };
}

export async function runSalesSpikeWatchdog(db: AnyDb, now = new Date()) {
  const model = await refreshSalesSpike(db);
  const candidates: AlertCandidate[] = [
    ...model.hits.map((h) => ({
      refKey: h.code ?? String(h.skuId),
      dedupeKey: `sales_spike:sku:${h.skuId}`,
      title: `${h.expected ? "爆单（大促预期内）" : "爆单"} ${h.code}：近 ${h.days.length} 天 ${h.days.map((d) => d.qty).join("/")} 件，较前 7 日日均 +${h.risePct ?? "—"}%`,
      detail: `店铺 ${h.shopName}；基线 ${h.baseline} 件/日；阈值 ${h.threshold}；截止 ${h.anchorDate}${h.gaps > 0 ? `；窗口缺 ${h.gaps} 天按 0 计` : ""}${h.expected ? `；${h.planEventWindow ?? "大促"}预期内` : ""}`,
      severity: (h.expected ? "medium" : "high") as AlertCandidate["severity"],
      ownerRole: "ops",
      actionHref: `/inventory/alerts?tab=spike`,
      sourceRule: "rules/sales-spike",
      paramsSnapshot: { ...model.params, anchorDate: h.anchorDate, reason: h.reason, gaps: h.gaps, expected: h.expected, planEventRef: h.planEventRef, expectedUpliftPct: h.expectedUpliftPct, calendarPct: model.coverage.calendarPct },
      why: spikeWhy(h),
    })),
    ...model.unmappedHits.map((h) => ({
      refKey: `${h.shopName}|${h.platformSkuId}`,
      dedupeKey: `sales_spike:platform:${h.shopName}|${h.platformSkuId}`,
      title: `爆单（未映射平台 SKU ${h.platformSkuId}）：近 ${h.days.length} 天 ${h.days.map((d) => d.qty).join("/")} 件，+${h.risePct ?? "—"}%`,
      detail: `店铺 ${h.shopName}；先认领身份再评估备货；基线 ${h.baseline}；截止 ${h.anchorDate}${h.gaps > 0 ? `；窗口缺 ${h.gaps} 天按 0 计` : ""}`,
      severity: "medium" as const,
      ownerRole: "ops",
      actionHref: h.href,
      sourceRule: "rules/sales-spike",
      paramsSnapshot: { ...model.params, anchorDate: h.anchorDate, reason: h.reason, gaps: h.gaps, expected: false },
      why: spikeWhy(h),
    })),
  ];
  const res = await upsertAlerts(db, { category: "sales_spike", candidates, now });
  return { category: "sales_spike", state: model.state, hits: model.hits.length, unmapped: model.unmappedHits.length, expected: model.coverage.expectedHits, calendarPct: model.coverage.calendarPct, ...res };
}
