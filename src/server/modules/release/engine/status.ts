/** release 流水线：status（自 engine.ts 拆出，行为未变） */
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";

import { ApiError } from "@/server/modules/master/common";


import { type AnyDb, type ReleaseUser, resolveDb } from "./common";

export interface ReleaseStatusTable {
  targetTable: string;
  staged: number; // pending + validated（待放行）
  committed: number;
  error: number; // 拒收道
  blockedReasons: { reason: string; count: number }[];
}

export async function releaseStatus(jobId?: number, dbArg?: AnyDb): Promise<{ tables: ReleaseStatusTable[] }> {
  const db = await resolveDb(dbArg);
  const where = jobId != null ? eq(schema.stagingRows.importJobId, jobId) : undefined;
  const rows: { targetTable: string | null; status: string; errorMsg: string | null }[] = await db
    .select({
      targetTable: schema.stagingRows.targetTable,
      status: schema.stagingRows.status,
      errorMsg: schema.stagingRows.errorMsg,
    })
    .from(schema.stagingRows)
    .where(where);

  const byTable = new Map<string, { staged: number; committed: number; error: number; reasons: Map<string, number> }>();
  for (const r of rows) {
    const t = r.targetTable ?? "(unknown)";
    let agg = byTable.get(t);
    if (!agg) {
      agg = { staged: 0, committed: 0, error: 0, reasons: new Map() };
      byTable.set(t, agg);
    }
    if (r.status === "committed") agg.committed++;
    else if (r.status === "error") agg.error++;
    else agg.staged++;
    if (r.status !== "committed" && r.errorMsg) {
      agg.reasons.set(r.errorMsg, (agg.reasons.get(r.errorMsg) ?? 0) + 1);
    }
  }
  const tables = [...byTable.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([targetTable, agg]) => ({
      targetTable,
      staged: agg.staged,
      committed: agg.committed,
      error: agg.error,
      blockedReasons: [...agg.reasons.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 20)
        .map(([reason, count]) => ({ reason, count })),
    }));
  return { tables };
}

/* ══ 路由守卫（release 模块自持，不借用他模块私有件） ═════ */

/** 写守卫：getFreshSessionUser 回查 DB + requireRole("pmc")（admin 兜底） */
export async function guardRelease(): Promise<ReleaseUser> {
  let user: ReleaseUser;
  try {
    const { getFreshSessionUser } = await import("@/server/core/dto");
    user = await getFreshSessionUser();
  } catch {
    throw new ApiError(401, "未登录或账号已停用");
  }
  if (!user.roles.includes("admin") && !user.roles.includes("pmc")) {
    throw new ApiError(403, "无权限执行此操作：需要生产计划（PMC）或管理员角色");
  }
  return user;
}

/** 生效审批守卫：仅回查新鲜身份；角色/审批人/SoD 语义在 activateReleasedBoms 内强制 */
export async function guardReleaseApprover(): Promise<ReleaseUser> {
  try {
    const { getFreshSessionUser } = await import("@/server/core/dto");
    return await getFreshSessionUser();
  } catch {
    throw new ApiError(401, "未登录或账号已停用");
  }
}

/* ══ 8) releaseTransitRefs（在途参考层，D16 执行面） ═══════ */

