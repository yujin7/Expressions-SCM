/**
 * 用友只读观测同步的调度入口。
 *
 * 与 sync-jst 同一纪律：**配置缺失一律 skipped，绝不伪造成功**。
 * 另加一条用友特有的：8 条契约在控制台逐条授权前会返回 310037，
 * 这属于"等授权"而非故障——汇总里单列 blockedByConsoleGrant，
 * 让运维一眼看出"代码没问题，是还没在开放平台勾接口"，
 * 而不是被一串红色报错淹没后去查代码。
 */
import type { AnyDb } from "@/server/import/staging";
import {
  yonyouConfigFromEnv,
  yonyouSyncEnabled,
} from "@/server/integrations/yonyou";
import { YonyouClient } from "@/server/integrations/yonyou-client";
import { syncYonyouContract, type YonyouSyncSummary } from "@/server/integrations/yonyou-sync";
import type { YonyouReadContractName } from "@/server/integrations/yonyou-contracts";
import { shanghaiToday } from "./reconcile-jst";

export type YonyouSyncJobResult =
  | { status: "skipped"; reason: string; scopeKey: string }
  | {
    status: "succeeded";
    scopeKey: string;
    results: YonyouSyncSummary[];
    /** 仍在等控制台授权的契约名；非空即代表本轮没真正取到数。 */
    awaitingConsoleGrant: string[];
  };

/** 同步执行人：审计要有真实归属，缺失或非法一律跳过而不是记到 0 号用户头上。 */
export function yonyouSyncActorId(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.YY_SYNC_ACTOR_ID?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * 拉取全部**已批准**契约。批准范围来自 YY_APPROVED_API_CONTRACTS，
 * 与客户端的双重白名单一致——这里不另立一份契约清单。
 */
export async function runYonyouSync(
  db: AnyDb,
  scopeKey = shanghaiToday(-1),
): Promise<YonyouSyncJobResult> {
  const config = yonyouConfigFromEnv();
  if (!config) {
    return {
      status: "skipped",
      reason: "用友机器配置不完整（缺 AppKey/密钥/租户/组织/契约/端点之一）",
      scopeKey,
    };
  }
  if (!yonyouSyncEnabled()) {
    return { status: "skipped", reason: "YY_SYNC_ENABLED 未开启", scopeKey };
  }
  const actorId = yonyouSyncActorId();
  if (actorId === null) {
    return { status: "skipped", reason: "缺少有效 YY_SYNC_ACTOR_ID", scopeKey };
  }

  const client = new YonyouClient(config);
  const results: YonyouSyncSummary[] = [];
  const awaitingConsoleGrant: string[] = [];

  for (const contract of config.approvedApiContracts) {
    const summary = await syncYonyouContract(db, {
      client,
      contract: contract as YonyouReadContractName,
      actorId,
      scopeKey,
      sourceAsOf: scopeKey,
    });
    results.push(summary);
    if (summary.blockedByConsoleGrant) awaitingConsoleGrant.push(contract);
  }

  return { status: "succeeded", scopeKey, results, awaitingConsoleGrant };
}
