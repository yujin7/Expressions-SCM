import { shanghaiDayOf } from "@/server/core/business-day";
import { salesSpikeEvidenceCurrent } from "@/server/rules/sales-spike";
import type { AnyDb } from "@/server/core/svc";
import { upsertAlerts, type AlertCandidate, type AlertWhy } from "@/server/modules/alerts/engine";
import { refreshInventoryAlerts, type InventoryAlertRow } from "@/server/modules/report/inventory-alerts";
import { refreshSalesSpike, type SpikeHit } from "@/server/modules/report/sales-spike";
import { getOrderByDates } from "@/server/modules/replenish/order-by";
import { ALERT_KIND_LABELS } from "@/server/rules/alert-priority";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";

/**
 * 预警看门狗（D56/D57）：重建读模型 → 投影为 system_alerts（去重键幂等、迟滞 3 天自动关闭）。
 * 断货/低于阈值只对 S/A/B 级开告警，C 级仅列表；爆单已映射按 SKU、未映射按平台 SKU 各自开告警。
 *
 * 审计 #4：每条候选带 why[]（label/value/source）——阈值依据、主日销口径与窗口、优先级分拆项、等级来源、
 * 下一笔到货、爆单 reason/gaps/大促事件——全部来自读模型已算好的字段，看门狗不重算任何事实。
 * 审计 #1：在库 alert 但阈值内有确认到货的行已由读模型降为 watch，因此不再开告警（自然迟滞关闭）。
 * 审计 #7：大促预期内的爆单降为 medium 而不是丢弃——跑到自己预期 3 倍仍是新闻。
 * W6：paramsSnapshot.orderByDate 取补货引擎（rules/timephased）的最晚下单日，看门狗自己不再倒推；
 * 引擎无答案时才回退「今天 + 在库可销 − 交期」近似，并以 orderByDateSource 标明是哪一种。
 *
 * 责任角色（红队审计 A4）：一律取 `rules/task-triggers.ALERT_OWNER_ROLE`——**该表自称并且确实是唯一权威**
 * （待办派单、engine.closeAlert 的关闭权限、system-alert-notify 的通知受众三处都读它）。
 * 本文件此前把 sales_spike 写死成 `ops`，而表里是 `pmc`：结果待办派给 PMC、通知与关闭权限却在运营手上，
 * 谁都不完全负责。inventory_cover 当时恰好一致（pmc），但同样改为读表，免得下次改表时又漏一处。
 * 护栏：tests/architecture/alert-owner-role-authority.test.ts。
 */
const DAILY_SOURCE_LABEL: Record<NonNullable<InventoryAlertRow["primaryDailySource"]>, string> = {
  external: "外部平台净件数（支付−退款）近 30 天 ÷ 30",
  internal: "销量月表近 6 月折日",
  ledger: "实时仓流水近 30 天出库 ÷ 30（含调拨/发料）",
};

/** W6：最晚下单日的取值与来源（engine=补货引擎逐日推演；fallback=在库可销 − 交期近似） */
export interface OrderByExplain {
  date: string;
  source: "engine" | "fallback";
  shortageDate?: string | null;
  orderWindowMissed?: boolean;
}

export function coverWhy(r: InventoryAlertRow, orderBy?: OrderByExplain): AlertWhy[] {
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
  if (orderBy) {
    why.push({
      label: "最晚下单日",
      value: orderBy.source === "engine"
        ? `${orderBy.date}（补货引擎逐日推演：首次跌破安全库存 ${orderBy.shortageDate ?? "—"} 倒推总供应周期${orderBy.orderWindowMissed ? "；窗口已过" : ""}）——与补货建议页同一个数`
        : `${orderBy.date}（近似：今天 + 在库可销 − 交期；补货引擎对该 SKU 无答案——多为缺生产周期或无动销）`,
      source: orderBy.source === "engine" ? "replenish/order-by（rules/timephased）" : "report/inventory-alerts 近似",
    });
  }
  return why;
}

export function spikeWhy(h: SpikeHit): AlertWhy[] {
  const why: AlertWhy[] = [
    { label: "判定", value: h.reason, source: "rules/sales-spike" },
    { label: "窗口", value: `最近 ${h.days.length} 天 ${h.days.map((d) => `${d.date.slice(5)}:${d.qty}`).join(" / ")}，截止 ${h.anchorDate}`, source: "jdy tmall-sku-sales-observation" },
    { label: "基线", value: `${h.baseline} 件/日（前 7 日日均），门槛 ${h.threshold}`, source: "rules/sales-spike" },
  ];
  if (h.gaps > 0) why.push({ label: "证据不足", value: `窗口缺 ${h.gaps} 天，应回源核对，不作为爆单判断`, source: "rules/sales-spike" });
  if (h.expected) {
    why.push({ label: "大促预期内", value: `${h.planEventWindow ?? "大促"}（事件 #${h.planEventRef}${h.expectedUpliftPct != null ? `，预期涨幅 ${h.expectedUpliftPct}%` : "，未填预期涨幅"}）——严重度降为 medium，不丢弃`, source: "ops_plan_events" });
  }
  return why;
}

export async function runInventoryCoverWatchdog(db: AnyDb, now = new Date()) {
  const model = await refreshInventoryAlerts(db);
  const hits = model.rows.filter((r) => (r.primary === "out_of_stock" || r.status === "alert") && r.tier !== "C" && r.tier != null);
  /* W6 待办截止日 = 补货引擎的最晚下单日（时间分段推演），不再用「今天 + 在库可销 − 交期」自行倒推：
     后者忽略有确认到货日的在途与安全库存水位，与补货页给计划员看的日期对不上。
     引擎无答案（缺生产周期/无动销/视野内不短缺）时才回退近似值，并在 paramsSnapshot 与 why 里标明来源。 */
  const orderByBySku = new Map<number, { orderByDate: string | null; shortageDate: string | null; orderWindowMissed: boolean }>();
  if (hits.length > 0) {
    for (const o of await getOrderByDates(db, hits.map((r) => r.skuId))) {
      orderByBySku.set(o.skuId, { orderByDate: o.orderByDate, shortageDate: o.shortageDate, orderWindowMissed: o.orderWindowMissed });
    }
  }
  const candidates: AlertCandidate[] = hits
    .map((r) => {
      const engine = orderByBySku.get(r.skuId);
      const orderBy: OrderByExplain = engine?.orderByDate
        ? { date: engine.orderByDate, source: "engine", shortageDate: engine.shortageDate, orderWindowMissed: engine.orderWindowMissed }
        : {
            // 回退：今天 + 在库可销 − 交期（阈值 − 缓冲）；断货/无日销 → 今天（窗口已过）
            date: shanghaiDayOf(new Date(now.getTime() + Math.max(0, Math.floor((r.coverDays ?? 0) - (r.alertDays - model.params.bufferDays))) * 86_400_000)),
            source: "fallback",
          };
      return {
        refKey: r.code,
        dedupeKey: `inventory_cover:${r.skuId}`,
        title: r.primary === "out_of_stock" ? `${r.tier} 级 ${r.code} 已断货（有需求无在库）` : `${r.tier} 级 ${r.code} 可销 ${r.coverDays ?? "—"} 天 < 阈值 ${r.alertDays} 天`,
        detail: `在库 ${r.onHand}；主日销 ${r.primaryDaily ?? "—"}（${r.primaryDailySource ?? "无"}）；阈值 = ${r.alertBasis}${r.usedDefault ? "（含缺省周期）" : ""}${r.nextArrival ? `；下一笔到货 ${r.nextArrival.date} ${r.nextArrival.qty} 件` : ""}`,
        severity: r.primary === "out_of_stock" || r.tier === "S" ? "high" : "medium",
        ownerRole: ALERT_OWNER_ROLE["inventory_cover"], // = pmc（ALERT_OWNER_ROLE 是责任角色唯一权威）
        actionHref: `/inventory/alerts?tab=cover&cover_q=${encodeURIComponent(r.code)}`,
        sourceRule: "rules/alert-threshold + rules/alert-priority",
        paramsSnapshot: {
          ...model.params, coverDays: r.coverDays, coverDaysWithSupply: r.coverDaysWithSupply, alertDays: r.alertDays, primaryDailySource: r.primaryDailySource,
          nextArrival: r.nextArrival, inTransitDated: r.inTransitDated, inTransitUndated: r.inTransitUndated, inTransitOverdue: r.inTransitOverdue,
          learnedLead: r.learnedLead, priorityScore: r.priorityScore, priorityTerms: r.priorityTerms, statusOnHand: r.statusOnHand, statusBasis: r.statusBasis,
          primary: r.primary, tags: r.tags,
          // 最晚下单日（闭环审计 #9 / W6，待办真实截止日）：优先取补货引擎逐日推演结果，无答案才回退近似
          orderByDate: orderBy.date,
          orderByDateSource: orderBy.source,
          engineShortageDate: engine?.shortageDate ?? null,
        },
        why: coverWhy(r, orderBy),
      } satisfies AlertCandidate;
    });
  const res = await upsertAlerts(db, { category: "inventory_cover", candidates, now });
  return { category: "inventory_cover", rows: model.rows.length, candidates: candidates.length, downgradedBySupply: model.totals.downgradedBySupply, ...res };
}

export async function runSalesSpikeWatchdog(db: AnyDb, now = new Date()) {
  const model = await refreshSalesSpike(db);
  const current = salesSpikeEvidenceCurrent(model.anchorDate, now);
  const candidates: AlertCandidate[] = [
    ...model.hits.map((h) => ({
      refKey: h.code ?? String(h.skuId),
      dedupeKey: `sales_spike:sku:${h.skuId}`,
      title: `${h.expected ? "爆单（大促预期内）" : "爆单"} ${h.code}：近 ${h.days.length} 天 ${h.days.map((d) => d.qty).join("/")} 件，较前 7 日日均 +${h.risePct ?? "—"}%`,
      detail: `店铺 ${h.shopName}；基线 ${h.baseline} 件/日；阈值 ${h.threshold}；截止 ${h.anchorDate}${h.expected ? `；${h.planEventWindow ?? "大促"}预期内` : ""}`,
      severity: (h.expected ? "medium" : "high") as AlertCandidate["severity"],
      ownerRole: ALERT_OWNER_ROLE["sales_spike"], // = pmc（原写死 ops 与权威表冲突：待办给 pmc、通知/关闭权限给 ops）
      actionHref: `/inventory/alerts?tab=spike`,
      sourceRule: "rules/sales-spike",
      paramsSnapshot: { ...model.params, anchorDate: h.anchorDate, reason: h.reason, gaps: h.gaps, expected: h.expected, planEventRef: h.planEventRef, expectedUpliftPct: h.expectedUpliftPct, calendarPct: model.coverage.calendarPct },
      why: spikeWhy(h),
    })),
    ...model.unmappedHits.map((h) => ({
      refKey: `${h.shopName}|${h.platformSkuId}`,
      dedupeKey: `sales_spike:platform:${h.shopName}|${h.platformSkuId}`,
      title: `爆单（未映射平台 SKU ${h.platformSkuId}）：近 ${h.days.length} 天 ${h.days.map((d) => d.qty).join("/")} 件，+${h.risePct ?? "—"}%`,
      detail: `店铺 ${h.shopName}；先认领身份再评估备货；基线 ${h.baseline}；截止 ${h.anchorDate}`,
      severity: "medium" as const,
      ownerRole: ALERT_OWNER_ROLE["sales_spike"], // = pmc（同上：未映射平台 SKU 的爆单也归 PMC）
      actionHref: h.href,
      sourceRule: "rules/sales-spike",
      paramsSnapshot: { ...model.params, anchorDate: h.anchorDate, reason: h.reason, gaps: h.gaps, expected: false },
      why: spikeWhy(h),
    })),
  ];
  const eligible = new Set(current ? model.evaluations.filter((e) => e.complete).map((e) => e.dedupeKey) : []);
  const res = await upsertAlerts(db, {
    category: "sales_spike", candidates: candidates.filter((c) => eligible.has(c.dedupeKey)), now,
    autoCloseEligibleKeys: [...eligible],
  });
  return { category: "sales_spike", state: model.state, current, evaluated: eligible.size, incomplete: model.coverage.incompleteItems, hits: model.hits.length, unmapped: model.unmappedHits.length, expected: model.coverage.expectedHits, calendarPct: model.coverage.calendarPct, ...res };
}
