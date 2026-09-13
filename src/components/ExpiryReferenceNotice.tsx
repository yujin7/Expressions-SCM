"use client";

import { Alert, Button } from "antd";
import LoadErrorAlert from "./LoadErrorAlert";
import type { useExpiryReference } from "./useExpiryReference";

/** R15 stays informational. Qualification/approval/posting retain their existing server guards. */
export default function ExpiryReferenceNotice({ read }: { read: ReturnType<typeof useExpiryReference> }) {
  if (read.phase === "idle") return null;
  if (read.phase === "error") return <LoadErrorAlert subject="效期参考" error={read.error} onRetry={read.retry} />;
  if (read.phase === "loading" || !read.data) return <Alert type="info" showIcon message="正在读取当前仓库与 SKU 的效期参考…" style={{ marginBottom: 12 }} />;
  const { items, today } = read.data;
  const exceptions = items.filter(i => i.nearBatches > 0 || !i.skuKnown || !i.referenceRows || i.undatedPositiveRows > 0 || i.stocktakeDates.some(d => d > today));
  const missing = items.filter(i => !i.skuKnown || !i.referenceRows).length;
  const undated = items.filter(i => i.undatedPositiveRows > 0).length;
  const risk = items.filter(i => i.nearBatches > 0).length;
  const dates = [...new Set(items.flatMap(i => i.stocktakeDates))].sort();
  return <Alert type={exceptions.length ? "warning" : "info"} showIcon style={{ marginBottom: 12 }}
    message={`效期盘点参考 · ${items.length} 个 SKU · ${risk} 个命中临期/过期${missing ? ` · ${missing} 个缺参考` : ""}${undated ? ` · ${undated} 个效期不全` : ""}`}
    description={<div style={{ overflowWrap: "anywhere" }}>
      <div>非实时库存；按各仓最新盘点期核对。盘点日期：{dates.length ? dates.length === 1 ? dates[0] : `${dates[0]}～${dates.at(-1)}` : "暂无"}；效期计算日：{today}。</div>
      <div>未命中不代表可出库；请核对实物批次、效期及当前库存。本提示不单独拦截建单。</div>
      {exceptions.length > 0 && <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer" }}>查看 {exceptions.length} 个需核对 SKU 的明细</summary>
        <ul style={{ margin: "8px 0 0", paddingLeft: 20, maxHeight: 200, overflowY: "auto" }}>
          {exceptions.map(i => <li key={i.skuId} style={{ marginBottom: 6 }}>
            {i.skuCode}：{!i.skuKnown ? "SKU 主档未找到" : !i.referenceRows ? "当前盘点期未观察到该 SKU，不能据此认定无风险" : <>
              {i.nearBatches > 0 ? <>临期参考 {i.nearQtyExact} {i.baseUom || "（单位待核对）"}（含已过期 {i.expiredQtyExact}；最短剩余 {i.minDaysLeft} 天；阈值 {i.thresholdDays} 天）</> : "有日期的参考批次未命中临期"}
              {i.undatedPositiveRows > 0 && `；${i.undatedPositiveRows} 条正库存记录缺少效期`}
              {i.stocktakeAgeDays !== null && `；最早观测距计算日 ${i.stocktakeAgeDays} 天`}
              {i.stocktakeDates.some(d => d > today) && "；存在未来盘点日期，请核对来源"}
            </>}
          </li>)}
        </ul>
      </details>}
      <Button size="small" style={{ marginTop: 8 }} onClick={read.retry}>刷新效期参考</Button>
    </div>} />;
}
