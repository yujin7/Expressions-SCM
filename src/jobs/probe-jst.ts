import {
  JstApiError,
  JstClient,
  jstConfigFromEnv,
  jstLiveEvidenceBinding,
} from "@/server/integrations/jst";
import { IntegrationHttpError } from "@/server/integrations/http";
import { jstSyncActorId } from "@/server/integrations/jst-sync";
import { shanghaiToday } from "./reconcile-jst";

type JstProbeClient = Pick<
  JstClient,
  "queryShopsPage" | "queryWarehousesPage" | "queryOutboundOrdersPage" | "queryInventoryPage"
>;

type ProbeExercise =
  | { status: "succeeded"; rows: number; hasMore: boolean | null }
  | { status: "failed"; error: string };

function safeProbeError(error: unknown): string {
  if (error instanceof JstApiError) return `api_code_${error.code}`;
  if (error instanceof IntegrationHttpError) {
    return error.status === null ? "network_or_timeout" : `http_${error.status}`;
  }
  return "unexpected_response";
}

async function exercise(
  run: () => Promise<{ rows: unknown[]; hasNext: boolean | null }>,
): Promise<ProbeExercise> {
  try {
    const result = await run();
    return {
      status: "succeeded",
      rows: result.rows.length,
      hasMore: result.hasNext,
    };
  } catch (error) {
    return { status: "failed", error: safeProbeError(error) };
  }
}

/**
 * Minimal, read-only live probe. It validates the signed transport and the four API permission
 * surfaces needed by SCM without persisting vendor rows, exposing identifiers, advancing a
 * checkpoint, or marking UAT complete.
 */
export async function probeJstReadiness(
  options: {
    env?: NodeJS.ProcessEnv;
    client?: JstProbeClient;
    bizDate?: string;
  } = {},
) {
  const env = options.env ?? process.env;
  let config: ReturnType<typeof jstConfigFromEnv>;
  try {
    config = jstConfigFromEnv(env);
  } catch {
    return {
      status: "skipped" as const,
      reason: "JST_BASE_URL 不是获准的聚水潭官方 HTTPS API 基址",
    };
  }
  const actorId = jstSyncActorId(env);
  if (!config) {
    const missing = ["JST_APP_KEY", "JST_APP_SECRET", "JST_ACCESS_TOKEN"]
      .filter((key) => !env[key]?.trim());
    return {
      status: "skipped" as const,
      reason: `缺少 ${missing.join("/")}`,
    };
  }
  if (actorId === null) {
    return {
      status: "skipped" as const,
      reason: "缺少有效 JST_SYNC_ACTOR_ID",
    };
  }

  const client = options.client ?? new JstClient(config);
  const bizDate = options.bizDate ?? shanghaiToday(-1);
  const requestDay = {
    modified_begin: `${bizDate} 00:00:00`,
    modified_end: `${bizDate} 23:59:59`,
  };
  const shops = await exercise(() => client.queryShopsPage(1, 1));
  const warehouses = await exercise(() => client.queryWarehousesPage(1, 1));
  const outboundSales = await exercise(() => client.queryOutboundOrdersPage({
    ...requestDay,
    date_type: 2,
    start_ts: "1",
    page_index: 1,
    page_size: 1,
    is_get_total: false,
  }));
  const inventory = await exercise(() => client.queryInventoryPage({
    ...requestDay,
    page_index: 1,
    page_size: 1,
    has_lock_qty: true,
  }));
  const exercises = { shops, warehouses, outboundSales, inventory };
  const passed = Object.values(exercises).filter((item) => item.status === "succeeded").length;
  const requiredChecks: string[] = [];
  if (shops.status === "failed") requiredChecks.push("确认基础店铺查询权限与商家授权状态");
  if (warehouses.status === "failed") requiredChecks.push("确认仓库查询权限与仓库授权范围");
  if (outboundSales.status === "failed") requiredChecks.push("确认销售出库查询权限、生产 IP 白名单与 token 有效期");
  if (inventory.status === "failed") requiredChecks.push("确认库存查询权限；未通过前保持库存观察流关闭");
  requiredChecks.push(
    "探针不等于 UAT：仍需逐 SKU 控制总量、别名清零、失败重放与连续 7 天恢复演练",
  );

  return {
    status: passed === 4 ? "succeeded" as const : "partial" as const,
    authentication: passed > 0 ? "validated_by_signed_call" as const : "not_validated" as const,
    actor: { configured: true, id: actorId },
    bizDate,
    exercises,
    expectedLiveVerificationBinding: jstLiveEvidenceBinding(env),
    writesPerformed: false as const,
    requiredChecks,
  };
}
