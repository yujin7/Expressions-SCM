/**
 * E5-03 批量审批。
 *
 * 现状：我的待办里 20 张单，逐张点开、逐张批。带复核清单的批量通过是审批 UX 的第一课。
 *
 * 设计纪律：
 * - **逐单独立事务**：一单失败不拖累其他单（版本冲突、状态已变、无权限都属常见），
 *   返回逐单结果供 UI 展示「成功/失败分列 + 失败原因 + 可重试」，不做全或无。
 * - 复用各单据既有 approve 服务（含审批配置、幂等键、writeAudit），**不新开审批路径**——
 *   批量只是循环，权限与幂等语义与单张审批完全一致。
 * - 上限 100 单，防误操作与长事务。
 */
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { approveBh } from "@/server/modules/outsource/bh";
import { approveWo } from "@/server/modules/outsource/wo";
import { approvePo, approvePc } from "@/server/modules/outsource/po";
import { approveJg } from "@/server/modules/outsource/jg";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

export const BATCH_APPROVE_MAX = 100;

export interface BatchApproveItem {
  docType: string;
  id: number;
  version: number;
}
export interface BatchApproveOutcome {
  docType: string;
  id: number;
  ok: boolean;
  status?: string;
  idempotent?: boolean;
  error?: string;
}
export interface BatchApproveResult {
  approved: number;
  failed: number;
  outcomes: BatchApproveOutcome[];
}

type Approver = (user: SessionUser, id: number, input: unknown, db?: AnyDb) => Promise<{ status: string; idempotent: boolean }>;

/** 支持批量的单据类型 → 既有审批服务（不新增审批逻辑） */
const APPROVERS: Record<string, Approver> = {
  bh: approveBh,
  wo: approveWo,
  po: approvePo,
  pc: approvePc,
  jg: approveJg,
};

export async function batchApprove(
  user: SessionUser,
  input: { items: BatchApproveItem[]; comment?: string },
  dbArg?: AnyDb,
): Promise<BatchApproveResult> {
  const items = Array.isArray(input?.items) ? input.items : [];
  if (items.length === 0) throw new ApiError(400, "未选择任何单据");
  if (items.length > BATCH_APPROVE_MAX) throw new ApiError(400, `一次最多批量审批 ${BATCH_APPROVE_MAX} 单（当前 ${items.length}）`);

  const comment = String(input?.comment ?? "").trim().slice(0, 300) || undefined;
  const outcomes: BatchApproveOutcome[] = [];

  for (const it of items) {
    const docType = String(it?.docType ?? "").toLowerCase();
    const fn = APPROVERS[docType];
    if (!fn) {
      outcomes.push({ docType, id: it?.id, ok: false, error: `不支持批量审批的单据类型：${docType}` });
      continue;
    }
    if (!Number.isInteger(it?.id) || !Number.isInteger(it?.version)) {
      outcomes.push({ docType, id: it?.id, ok: false, error: "单据标识或版本无效" });
      continue;
    }
    try {
      // 逐单独立调用：任一失败不影响其余（各自事务在服务内部）
      const r = await fn(user, it.id, { action: "approve", version: it.version, comment }, dbArg);
      outcomes.push({ docType, id: it.id, ok: true, status: r.status, idempotent: r.idempotent });
    } catch (e) {
      outcomes.push({ docType, id: it.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    approved: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  };
}
