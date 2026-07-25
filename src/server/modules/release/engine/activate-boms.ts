/** release 流水线：activate-boms（自 engine.ts 拆出，行为未变） */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dAdd } from "@/server/core/decimal";
import { resolveAlias, type DimDb } from "@/server/modules/dimension/resolver";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import type { BomBlock, BomLine } from "@/server/import/adapters/bom";
import type { SpuCluster } from "@/server/import/adapters/bom-spu";
import {
  type AnyDb, type ReleaseUser, type StagedRow,
  resolveDb, loadStagedRows, commitRows, markBlocked, aliasCache,
  nextSpuCodeIn, loadReleasedSpuIndex, loadSkuIdByCode, isBomBlockPayload,
} from "./common";

export interface ActivateBomsResult {
  dryRun: boolean;
  activated: number;
  alreadyActive: number;
  skippedRetired: number;
  /** 10% 抽样复核清单（§4.3）：按产品编码排序取每第 10 个，人工抽检留痕 */
  sample: { bomId: number; productCode: string; versionNo: string }[];
}

/** 批量生效审批（§4.3）：一次审批 + 逐 BOM approvals 行；PMC 审批人（admin 豁免角色不豁免 SoD） */
export async function activateReleasedBoms(
  approver: ReleaseUser,
  args: { releaseRunId?: number; bomIds?: number[]; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ActivateBomsResult> {
  const db = await resolveDb(dbArg);
  const isAdmin = approver.roles.includes("admin");
  if (!isAdmin && !(approver.roles.includes("pmc") && approver.isApprover)) {
    throw new ApiError(403, "仅 PMC 审批人或管理员可批量生效 BOM");
  }

  let bomIds = args.bomIds ?? [];
  // 收口（红队第五轮）：直接传 bomIds 时逐一验证属于某放行批次候选集合
  // （audit_logs entity='release_bom' 的 after.candidateBomIds）——本接口只服务放行链
  // 批审，外部 draft BOM 不得借道绕过单据页逐一审批。releaseRunId 路径不受影响。
  if (bomIds.length > 0) {
    const runs: { after: unknown }[] = await db
      .select({ after: schema.auditLogs.after })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entity, "release_bom"));
    const candidateSet = new Set<number>();
    for (const r of runs) {
      const a = r.after as { candidateBomIds?: unknown } | null;
      if (Array.isArray(a?.candidateBomIds)) {
        for (const id of a.candidateBomIds) if (typeof id === "number") candidateSet.add(id);
      }
    }
    const offending = bomIds.filter((id) => !candidateSet.has(id));
    if (offending.length > 0) {
      throw new ApiError(
        400,
        `非放行候选 BOM，请走单据页逐一生效审批（ID：${offending.slice(0, 5).join("/")}${offending.length > 5 ? " 等" : ""}）`,
      );
    }
  }
  if (bomIds.length === 0 && args.releaseRunId != null) {
    const [run] = await db
      .select({ entity: schema.auditLogs.entity, after: schema.auditLogs.after })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.id, args.releaseRunId));
    if (!run || run.entity !== "release_bom") throw new ApiError(404, "放行批次不存在");
    const after = run.after as { candidateBomIds?: number[] } | null;
    bomIds = after?.candidateBomIds ?? [];
  }
  if (bomIds.length === 0) throw new ApiError(400, "需提供 releaseRunId 或 bomIds");

  const boms: { id: number; productSkuId: number; versionNo: string; status: string; createdBy: number | null; productCode: string }[] =
    await db
      .select({
        id: schema.boms.id,
        productSkuId: schema.boms.productSkuId,
        versionNo: schema.boms.versionNo,
        status: schema.boms.status,
        createdBy: schema.boms.createdBy,
        productCode: schema.skus.code,
      })
      .from(schema.boms)
      .innerJoin(schema.skus, eq(schema.boms.productSkuId, schema.skus.id))
      .where(inArray(schema.boms.id, bomIds));

  const toActivate = boms.filter((b) => b.status === "draft").sort((a, b) => (a.productCode < b.productCode ? -1 : 1));
  const alreadyActive = boms.filter((b) => b.status === "active").length;
  const skippedRetired = boms.filter((b) => b.status === "retired").length;

  // SoD：审批人 ≠ 放行操作者（逐 BOM createdBy 校验；admin 亦不得自批）
  const selfMade = toActivate.filter((b) => b.createdBy != null && b.createdBy === approver.id);
  if (selfMade.length > 0) {
    throw new ApiError(403, `职责分离：不可生效本人放行的 BOM（${selfMade.length} 个）`);
  }

  const sample = toActivate
    .filter((_, i) => i % 10 === 0)
    .map((b) => ({ bomId: b.id, productCode: b.productCode, versionNo: b.versionNo }));

  if (args.dryRun) {
    return { dryRun: true, activated: toActivate.length, alreadyActive, skippedRetired, sample };
  }

  const today = todayShanghai();
  await db.transaction(async (tx: AnyDb) => {
    for (const b of toActivate) {
      await tx
        .insert(schema.approvals)
        .values({
          docType: "bom",
          docId: b.id,
          node: 1,
          cycle: 0,
          approverId: approver.id,
          action: "approve",
          comment: `批量生效 run#${args.releaseRunId ?? "manual"}`,
        })
        .onConflictDoNothing();
      // 与 activateBom 同序：先退旧生效版本，再置本版本 active（部分唯一索引要求）
      await tx
        .update(schema.boms)
        .set({ status: "retired", updatedAt: new Date() })
        .where(and(eq(schema.boms.productSkuId, b.productSkuId), eq(schema.boms.status, "active")));
      await tx
        .update(schema.boms)
        .set({ status: "active", effectiveDate: today, approvedBy: approver.id, updatedAt: new Date() })
        .where(eq(schema.boms.id, b.id));
    }
    await writeAudit(tx, {
      userId: approver.id,
      entity: "release_bom_activate",
      action: "activate",
      after: {
        releaseRunId: args.releaseRunId ?? null,
        activated: toActivate.length,
        alreadyActive,
        skippedRetired,
        sample: sample.map((s) => s.productCode),
      },
    });
  });

  return { dryRun: false, activated: toActivate.length, alreadyActive, skippedRetired, sample };
}

/* ══ 4) releaseFeeRefs（加工费候选 → processing_fee_refs） ═ */

