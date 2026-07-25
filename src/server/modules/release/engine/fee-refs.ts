/** release 流水线：fee-refs（自 engine.ts 拆出，行为未变） */
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

export interface ReleaseFeeRefsResult {
  dryRun: boolean;
  created: number;
  existing: number;
  blocked: { stagingRowId: number; productCode: string | null; supplierRaw: string; reason: string }[];
}

export async function releaseFeeRefs(
  user: ReleaseUser,
  args: { jobIds?: number[]; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseFeeRefsResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, "processing_fee_candidate", args.jobIds);
  const resolve = aliasCache(db);
  const today = todayShanghai();

  const blocked: ReleaseFeeRefsResult["blocked"] = [];
  // key = skuId|supplierId：同批内去重，重复候选行共同提交到同一参考价行
  const plans = new Map<string, { skuId: number; supplierId: number; rowIds: number[] }>();

  const codeSet: string[] = [];
  for (const r of rows) {
    const p = r.payload as { productCode?: string | null };
    if (typeof p.productCode === "string") codeSet.push(p.productCode);
  }
  const skuByCode = await loadSkuIdByCode(db, codeSet);

  for (const r of rows) {
    const p = r.payload as { productCode: string | null; supplierRaw: string };
    const supplierRaw = p.supplierRaw ?? "";
    if (!p.productCode) {
      blocked.push({ stagingRowId: r.id, productCode: null, supplierRaw, reason: "无产品编码" });
      continue;
    }
    const skuId = skuByCode.get(p.productCode);
    if (skuId == null) {
      blocked.push({ stagingRowId: r.id, productCode: p.productCode, supplierRaw, reason: "SKU 未放行" });
      continue;
    }
    const supplierId = await resolve("supplier_oem", supplierRaw);
    if (supplierId == null) {
      blocked.push({ stagingRowId: r.id, productCode: p.productCode, supplierRaw, reason: "供应商别名未认领" });
      continue;
    }
    const key = `${skuId}|${supplierId}`;
    const plan = plans.get(key);
    if (plan) plan.rowIds.push(r.id);
    else plans.set(key, { skuId, supplierId, rowIds: [r.id] });
  }

  // 既有行（UNIQUE sku,supplier,date）——upsert-by-key 幂等
  let created = 0;
  let existing = 0;
  const inserts: { skuId: number; supplierId: number; rowIds: number[]; existingId: number | null }[] = [];
  for (const plan of plans.values()) {
    const [dup] = await db
      .select({ id: schema.processingFeeRefs.id })
      .from(schema.processingFeeRefs)
      .where(
        and(
          eq(schema.processingFeeRefs.skuId, plan.skuId),
          eq(schema.processingFeeRefs.supplierId, plan.supplierId),
          eq(schema.processingFeeRefs.effectiveDate, today),
        ),
      );
    if (dup) existing++;
    else created++;
    inserts.push({ ...plan, existingId: dup?.id ?? null });
  }

  if (args.dryRun) return { dryRun: true, created, existing, blocked };

  await db.transaction(async (tx: AnyDb) => {
    for (const ins of inserts) {
      let refId = ins.existingId;
      if (refId == null) {
        const [ref] = await tx
          .insert(schema.processingFeeRefs)
          .values({
            skuId: ins.skuId,
            supplierId: ins.supplierId,
            feeRate: null, // BOM 文件常缺价——待采购补录；本引擎响应中一律不出现 feeRate
            effectiveDate: today,
            source: "bom_import",
          })
          .onConflictDoNothing()
          .returning({ id: schema.processingFeeRefs.id });
        refId =
          ref?.id ??
          (
            await tx
              .select({ id: schema.processingFeeRefs.id })
              .from(schema.processingFeeRefs)
              .where(
                and(
                  eq(schema.processingFeeRefs.skuId, ins.skuId),
                  eq(schema.processingFeeRefs.supplierId, ins.supplierId),
                  eq(schema.processingFeeRefs.effectiveDate, today),
                ),
              )
          )[0]!.id;
      }
      await commitRows(tx, ins.rowIds, refId);
    }
    for (const bl of blocked) await markBlocked(tx, bl.stagingRowId, bl.reason);
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_fee_ref",
      action: "release",
      after: { jobIds: args.jobIds ?? null, created, existing, blocked: blocked.length },
    });
  });
  return { dryRun: false, created, existing, blocked };
}

/* ══ 5) releaseBatchStocks（效期盘点 → batch_stocks 参考层） ═ */

