/**
 * 数据产品放行门禁看门狗。
 *
 * A2/A3 的实时失效已由 read model fail-closed，但如果只在决策工作室里降级，责任人必须
 * 主动打开页面才会知道。这里把“已批准但当前无效”变成幂等系统告警；恢复、撤回或替换
 * 放行后自动关闭。它只通知与止损，不修改任何业务事实或正式单据。
 *
 * W1（路线图）：告警写入统一走 alerts/engine.upsertAlerts——去重键幂等
 * （dedupeKey = data_product_gate:<productId>:<releaseId>）、责任角色取
 * rules/task-triggers.ALERT_OWNER_ROLE（唯一权威；通知按产品 ownerRoles 分派的口径不变，
 * 见 jobs/system-alert-notify）、动作链接直达该产品门禁、sourceRule/paramsSnapshot/why 同行落库、
 * 事件进 alert_events 台账。autoCloseAfterDays=0：恢复/撤回/替换放行是硬事实，不再命中即刻关闭——与迁移前一致。
 * 事务与 advisory lock 保持不变（pg-boss 之外还要防 CLI/手工重叠）。
 */
import { sql } from "drizzle-orm";

import { DATA_PRODUCTS } from "@/components/data-products";
import type { AnyDb } from "@/server/import/staging";
import { backfillAlertDedupeKeys, upsertAlerts, type AlertCandidate } from "@/server/modules/alerts/engine";
import {
  loadDataProductReleaseReadiness,
  type DataProductReleaseReadiness,
} from "@/server/modules/report/data-product-release";
import {
  loadDataSourceReadiness,
  type DataSourceReadiness,
} from "@/server/modules/report/data-source-readiness";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";

export const ALERT_CATEGORY = "data_product_gate";
export const DATA_PRODUCT_GATE_SOURCE_RULE = "report/data-product-release（放行现时有效性）";
const LOCK_KEY = "data-product-gate-watchdog/v1";

export interface DataProductGateWatchdogSummary {
  opened: number;
  autoClosed: number;
  /** 已开告警本轮再次命中（等级/门禁文案刷新） */
  refreshed: number;
  /** 本轮回填 dedupe_key 的历史行数 */
  backfilled: number;
  invalidatedProducts: string[];
}

function alertRef(row: DataProductReleaseReadiness): string {
  return `${row.productId}:${row.activeRelease!.id}`;
}

/** 动作链接：决策工作室就绪度页锚到该产品（与通知 href 同源） */
export function dataProductGateHref(productId: string): string {
  return `/report/decision-studio?tab=readiness&product=${encodeURIComponent(productId)}#data-product-${encodeURIComponent(productId)}`;
}

function invalidatedReleases(
  readiness: readonly DataProductReleaseReadiness[],
): DataProductReleaseReadiness[] {
  return readiness.filter((row) => row.activeRelease != null && !row.activeReleaseCurrent);
}

export async function runDataProductGateWatchdog(
  db: AnyDb,
  opts?: { dataSources?: readonly DataSourceReadiness[]; now?: Date },
): Promise<DataProductGateWatchdogSummary> {
  const now = opts?.now ?? new Date();

  return db.transaction(async (tx: AnyDb) => {
    // pg-boss normally serializes this job; the advisory lock also protects CLI/manual overlap.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
    const backfilled = await backfillAlertDedupeKeys(tx, ALERT_CATEGORY);

    const dataSources = opts?.dataSources ?? await loadDataSourceReadiness(tx);
    const readiness = await loadDataProductReleaseReadiness(dataSources, undefined, tx);
    const invalidated = invalidatedReleases(readiness);

    const candidates: AlertCandidate[] = [];
    for (const row of invalidated) {
      const product = DATA_PRODUCTS.find((item) => item.id === row.productId);
      if (!product || !row.activeRelease) continue;
      const refKey = alertRef(row);
      candidates.push({
        refKey,
        dedupeKey: `${ALERT_CATEGORY}:${refKey}`,
        title: `数据产品「${product.title}」已从 ${row.activeRelease.targetLevel} 自动降级`,
        detail: `${row.gate} 当前有效等级 ${row.effectiveLevel}。责任人：${product.owner}；`
          + `请先停止依赖旧建议/草稿，打开决策工作室核对逐流证据，并撤回或重新验收放行。`,
        severity: row.activeRelease.targetLevel === "A3" ? "high" : "medium",
        ownerRole: ALERT_OWNER_ROLE[ALERT_CATEGORY],
        actionHref: dataProductGateHref(row.productId),
        sourceRule: DATA_PRODUCT_GATE_SOURCE_RULE,
        paramsSnapshot: {
          productId: row.productId,
          releaseId: row.activeRelease.id,
          targetLevel: row.activeRelease.targetLevel,
          effectiveLevel: row.effectiveLevel,
          gate: row.gate,
          owner: product.owner,
          ownerRoles: [...product.ownerRoles],
        },
        why: [
          { label: "已批准放行", value: `${row.activeRelease.targetLevel}（放行 #${row.activeRelease.id}）`, source: "data_product_releases" },
          { label: "当前有效等级", value: String(row.effectiveLevel), source: "report/data-product-release" },
          { label: "门禁判定", value: row.gate, source: DATA_PRODUCT_GATE_SOURCE_RULE },
        ],
      });
    }

    const res = await upsertAlerts(tx, {
      category: ALERT_CATEGORY,
      candidates,
      now,
      autoCloseAfterDays: 0, // 恢复/撤回/替换放行即关：门禁有效性是硬事实，不需要数据缺口迟滞
    });

    return {
      opened: res.opened,
      autoClosed: res.autoClosed,
      refreshed: res.refreshed,
      backfilled,
      invalidatedProducts: invalidated.map((row) => row.productId).sort(),
    };
  });
}
