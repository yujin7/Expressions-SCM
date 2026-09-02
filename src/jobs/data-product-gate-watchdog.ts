/**
 * 数据产品放行门禁看门狗。
 *
 * A2/A3 的实时失效已由 read model fail-closed，但如果只在决策工作室里降级，责任人必须
 * 主动打开页面才会知道。这里把“已批准但当前无效”变成幂等系统告警；恢复、撤回或替换
 * 放行后自动关闭。它只通知与止损，不修改任何业务事实或正式单据。
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { DATA_PRODUCTS } from "@/components/data-products";
import { systemAlerts } from "@/db/schema";
import type { AnyDb } from "@/server/import/staging";
import {
  loadDataProductReleaseReadiness,
  type DataProductReleaseReadiness,
} from "@/server/modules/report/data-product-release";
import {
  loadDataSourceReadiness,
  type DataSourceReadiness,
} from "@/server/modules/report/data-source-readiness";

const ALERT_CATEGORY = "data_product_gate";
const LOCK_KEY = "data-product-gate-watchdog/v1";

export interface DataProductGateWatchdogSummary {
  opened: number;
  autoClosed: number;
  invalidatedProducts: string[];
}

function alertRef(row: DataProductReleaseReadiness): string {
  return `${row.productId}:${row.activeRelease!.id}`;
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

    const dataSources = opts?.dataSources ?? await loadDataSourceReadiness(tx);
    const readiness = await loadDataProductReleaseReadiness(dataSources, undefined, tx);
    const invalidated = invalidatedReleases(readiness);
    const invalidByRef = new Map(invalidated.map((row) => [alertRef(row), row]));

    const openAlerts: { id: number; refKey: string | null }[] = await tx
      .select({ id: systemAlerts.id, refKey: systemAlerts.refKey })
      .from(systemAlerts)
      .where(and(
        eq(systemAlerts.category, ALERT_CATEGORY),
        eq(systemAlerts.status, "open"),
      ));
    const openRefs = new Set(openAlerts.map((row) => row.refKey).filter((key): key is string => key != null));

    let opened = 0;
    for (const row of invalidated) {
      const refKey = alertRef(row);
      if (openRefs.has(refKey)) continue;
      const product = DATA_PRODUCTS.find((item) => item.id === row.productId);
      if (!product || !row.activeRelease) continue;
      await tx.insert(systemAlerts).values({
        category: ALERT_CATEGORY,
        refKey,
        title: `数据产品「${product.title}」已从 ${row.activeRelease.targetLevel} 自动降级`,
        detail: `${row.gate} 当前有效等级 ${row.effectiveLevel}。责任人：${product.owner}；`
          + `请先停止依赖旧建议/草稿，打开决策工作室核对逐流证据，并撤回或重新验收放行。`,
        severity: row.activeRelease.targetLevel === "A3" ? "high" : "medium",
      });
      opened++;
    }

    const recovered = openAlerts.filter((row) => row.refKey != null && !invalidByRef.has(row.refKey));
    if (recovered.length > 0) {
      await tx.update(systemAlerts).set({
        status: "resolved",
        autoResolved: true,
        resolvedAt: now,
      }).where(inArray(systemAlerts.id, recovered.map((row) => row.id)));
    }

    return {
      opened,
      autoClosed: recovered.length,
      invalidatedProducts: invalidated.map((row) => row.productId).sort(),
    };
  });
}
