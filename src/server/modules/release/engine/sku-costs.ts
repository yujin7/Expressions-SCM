/** SKU 成本 staging → sku_costs：财务权限、预演、版本预检、事务审计。 */
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dCmp, dQty } from "@/server/core/decimal";
import { requireAnyRole } from "@/server/modules/outsource/common";
import {
  aliasCache,
  commitRows,
  loadSkuIdByCode,
  loadStagedRows,
  markBlocked,
  resolveDb,
  type AnyDb,
  type ReleaseUser,
} from "./common";
import { assertImportPreflight, type PreflightOverrides } from "./preflight";

export interface ReleaseSkuCostsResult {
  dryRun: boolean;
  upserted: number;
  blocked: { stagingRowId: number; skuCode: string | null; reason: string }[];
  unresolvedSku: number;
  conflictingSku: number;
}

interface Payload {
  skuCode?: string | null;
  unitCost?: string | number | null;
}

export async function releaseSkuCosts(
  user: ReleaseUser,
  args: { jobIds?: number[]; preflightOverrides?: PreflightOverrides; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseSkuCostsResult> {
  requireAnyRole(user, "finance");
  const db = await resolveDb(dbArg);
  await assertImportPreflight(db, user, args);
  const rows = await loadStagedRows(db, "sku_cost", args.jobIds);
  const resolve = aliasCache(db);
  const codes = rows
    .map((row) => (row.payload as Payload).skuCode)
    .filter((code): code is string => typeof code === "string" && code.trim() !== "");
  const skuByCode = await loadSkuIdByCode(db, codes);

  const blocked: ReleaseSkuCostsResult["blocked"] = [];
  const unresolved = new Set<string>();
  const conflicts = new Set<number>();
  const blockedReasons = new Map<number, string>();
  const plans = new Map<number, { skuCode: string; unitCost: string; rowIds: number[] }>();

  for (const row of rows) {
    const payload = row.payload as Payload;
    const skuCode = typeof payload.skuCode === "string" ? payload.skuCode.trim() : "";
    const rawCost = payload.unitCost == null ? "" : String(payload.unitCost).trim();
    let unitCost: string | null = null;
    try {
      unitCost = /^\d+(\.\d+)?$/.test(rawCost) ? dQty(rawCost) : null;
      if (unitCost != null && dCmp(unitCost, "0") <= 0) unitCost = null;
    } catch {
      unitCost = null;
    }
    if (!skuCode || unitCost == null) {
      const reason = "载荷缺字段或单位成本非法（须为正数、最多按 4 位小数落库）";
      blocked.push({ stagingRowId: row.id, skuCode: skuCode || null, reason });
      blockedReasons.set(row.id, reason);
      continue;
    }
    const skuId = (await resolve("sku_code", skuCode)) ?? skuByCode.get(skuCode) ?? null;
    if (skuId == null) {
      unresolved.add(skuCode);
      const reason = `SKU 别名未认领：${skuCode}`;
      blocked.push({ stagingRowId: row.id, skuCode, reason });
      blockedReasons.set(row.id, reason);
      continue;
    }

    const existing = plans.get(skuId);
    if (!existing) {
      plans.set(skuId, { skuCode, unitCost, rowIds: [row.id] });
      continue;
    }
    if (dCmp(existing.unitCost, unitCost) === 0) {
      existing.rowIds.push(row.id);
      continue;
    }
    conflicts.add(skuId);
    existing.rowIds.push(row.id);
  }
  for (const skuId of conflicts) {
    const plan = plans.get(skuId);
    if (!plan) continue;
    const reason = "同一 SKU 在文件内存在互相矛盾的成本";
    for (const rowId of plan.rowIds) {
      blockedReasons.set(rowId, reason);
      blocked.push({ stagingRowId: rowId, skuCode: plan.skuCode, reason });
    }
    plans.delete(skuId);
  }

  const base = {
    upserted: plans.size,
    blocked,
    unresolvedSku: unresolved.size,
    conflictingSku: conflicts.size,
  };
  if (args.dryRun) return { dryRun: true, ...base };

  await db.transaction(async (tx: AnyDb) => {
    for (const [skuId, plan] of plans) {
      const [saved] = await tx
        .insert(schema.skuCosts)
        .values({
          skuId,
          unitCost: plan.unitCost,
          updatedBy: user.id,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.skuCosts.skuId,
          set: {
            unitCost: plan.unitCost,
            updatedBy: user.id,
            updatedAt: new Date(),
          },
        })
        .returning({ id: schema.skuCosts.id });
      await commitRows(tx, plan.rowIds, saved.id);
    }
    for (const [rowId, reason] of blockedReasons) await markBlocked(tx, rowId, reason);
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_sku_cost",
      action: "release",
      after: {
        jobIds: args.jobIds ?? null,
        upserted: plans.size,
        blocked: blockedReasons.size,
        unresolvedSku: unresolved.size,
        conflictingSku: conflicts.size,
      },
    });
  });

  return { dryRun: false, ...base };
}
