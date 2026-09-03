import type { AnyDb } from "@/server/core/svc";
import { upsertAlerts, type AlertCandidate } from "@/server/modules/alerts/engine";
import { refreshInventoryAlerts } from "@/server/modules/report/inventory-alerts";
import { refreshSalesSpike } from "@/server/modules/report/sales-spike";

/**
 * 预警看门狗（D56/D57）：重建读模型 → 投影为 system_alerts（去重键幂等、迟滞 3 天自动关闭）。
 * 断货/低于阈值只对 S/A/B 级开告警，C 级仅列表；爆单已映射按 SKU、未映射按平台 SKU 各自开告警。
 */
export async function runInventoryCoverWatchdog(db: AnyDb, now = new Date()) {
  const model = await refreshInventoryAlerts(db);
  const candidates: AlertCandidate[] = model.rows
    .filter((r) => (r.primary === "out_of_stock" || r.status === "alert") && r.tier !== "C" && r.tier != null)
    .map((r) => ({
      refKey: r.code,
      dedupeKey: `inventory_cover:${r.skuId}`,
      title: r.primary === "out_of_stock" ? `${r.tier} 级 ${r.code} 已断货（有需求无在库）` : `${r.tier} 级 ${r.code} 可销 ${r.coverDays ?? "—"} 天 < 阈值 ${r.alertDays} 天`,
      detail: `在库 ${r.onHand}；主日销 ${r.primaryDaily ?? "—"}（${r.primaryDailySource ?? "无"}）；阈值 = ${r.alertBasis}${r.usedDefault ? "（含缺省周期）" : ""}`,
      severity: r.primary === "out_of_stock" || r.tier === "S" ? "high" : "medium",
      ownerRole: "pmc",
      actionHref: `/inventory/alerts?tab=cover&cover_q=${encodeURIComponent(r.code)}`,
      sourceRule: "rules/alert-threshold + rules/alert-priority",
      paramsSnapshot: {
        ...model.params, coverDays: r.coverDays, alertDays: r.alertDays, primaryDailySource: r.primaryDailySource,
        priorityScore: r.priorityScore,
        // 最晚下单日（闭环审计 #9，待办真实截止日）= 今天 + 在库可销天数 − 交期（阈值 − 缓冲）；断货/无日销 → 今天（窗口已过）
        orderByDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
          new Date(now.getTime() + Math.max(0, Math.floor((r.coverDays ?? 0) - (r.alertDays - model.params.bufferDays))) * 86_400_000),
        ),
      },
    }));
  const res = await upsertAlerts(db, { category: "inventory_cover", candidates, now });
  return { category: "inventory_cover", rows: model.rows.length, candidates: candidates.length, ...res };
}

export async function runSalesSpikeWatchdog(db: AnyDb, now = new Date()) {
  const model = await refreshSalesSpike(db);
  const candidates: AlertCandidate[] = [
    ...model.hits.map((h) => ({
      refKey: h.code ?? String(h.skuId),
      dedupeKey: `sales_spike:sku:${h.skuId}`,
      title: `爆单 ${h.code}：近 ${h.days.length} 天 ${h.days.map((d) => d.qty).join("/")} 件，较前 7 日日均 +${h.risePct ?? "—"}%`,
      detail: `店铺 ${h.shopName}；基线 ${h.baseline} 件/日；阈值 ${h.threshold}；截止 ${h.anchorDate}`,
      severity: "high" as const,
      ownerRole: "ops",
      actionHref: `/inventory/alerts?tab=spike`,
      sourceRule: "rules/sales-spike",
      paramsSnapshot: { ...model.params, anchorDate: h.anchorDate },
    })),
    ...model.unmappedHits.map((h) => ({
      refKey: `${h.shopName}|${h.platformSkuId}`,
      dedupeKey: `sales_spike:platform:${h.shopName}|${h.platformSkuId}`,
      title: `爆单（未映射平台 SKU ${h.platformSkuId}）：近 ${h.days.length} 天 ${h.days.map((d) => d.qty).join("/")} 件，+${h.risePct ?? "—"}%`,
      detail: `店铺 ${h.shopName}；先认领身份再评估备货；基线 ${h.baseline}；截止 ${h.anchorDate}`,
      severity: "medium" as const,
      ownerRole: "ops",
      actionHref: h.href,
      sourceRule: "rules/sales-spike",
      paramsSnapshot: { ...model.params, anchorDate: h.anchorDate },
    })),
  ];
  const res = await upsertAlerts(db, { category: "sales_spike", candidates, now });
  return { category: "sales_spike", state: model.state, hits: model.hits.length, unmapped: model.unmappedHits.length, ...res };
}
