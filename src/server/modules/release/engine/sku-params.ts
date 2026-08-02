/** release 流水线：sku-params（自 engine.ts 拆出，行为未变） */
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";



import {
  aliasCache,
  assertRowsReleaseable,
  loadSkuIdByCode,
  loadStagedRows,
  resolveDb,
  type AnyDb,
  type ReleaseUser,
} from "./common";

export interface ReleaseSkuParamsResult {
  dryRun: boolean;
  upserted: number;
  unresolvedSku: number;
}

/**
 * 从 sku_leadtime staging 提取 常规/紧急生产周期 → sku_params（skuId UNIQUE upsert）。
 * R11 生产周期风险标注改读本表（staging 兜底过渡）；MOQ 权威仍在 uom_convs（不重复存）。
 * 幂等：同 SKU 重放=覆盖；首见为准（与 releaseFinishedMoq 同序法）。
 */
export async function releaseSkuParams(
  user: ReleaseUser,
  args: { dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseSkuParamsResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, "sku_leadtime");
  const resolve = aliasCache(db);

  const byCode = new Map<string, { normal: number | null; urgent: number | null }>();
  for (const r of rows) {
    const p = r.payload as { skuCode?: string | null; normalLeadDays?: unknown; urgentLeadDays?: unknown };
    const code = typeof p.skuCode === "string" ? p.skuCode.trim() : null;
    if (!code) continue;
    const norm = typeof p.normalLeadDays === "number" && Number.isFinite(p.normalLeadDays) && p.normalLeadDays > 0 ? Math.round(p.normalLeadDays) : null;
    const urg = typeof p.urgentLeadDays === "number" && Number.isFinite(p.urgentLeadDays) && p.urgentLeadDays > 0 ? Math.round(p.urgentLeadDays) : null;
    if (norm == null && urg == null) continue;
    if (!byCode.has(code)) byCode.set(code, { normal: norm, urgent: urg }); // 首见为准
  }

  let unresolvedSku = 0;
  const plans: { skuId: number; normal: number | null; urgent: number | null }[] = [];
  const skuByCode = await loadSkuIdByCode(db, [...byCode.keys()]);
  for (const [code, v] of byCode) {
    const skuId = (await resolve("sku_code", code)) ?? skuByCode.get(code) ?? null;
    if (skuId == null) { unresolvedSku++; continue; }
    plans.push({ skuId, normal: v.normal, urgent: v.urgent });
  }
  if (args.dryRun) return { dryRun: true, upserted: plans.length, unresolvedSku };

  await db.transaction(async (tx: AnyDb) => {
    await assertRowsReleaseable(tx, rows.map((row) => row.id));
    for (const p of plans) {
      await tx
        .insert(schema.skuParams)
        .values({ skuId: p.skuId, normalLeadDays: p.normal, urgentLeadDays: p.urgent, updatedBy: user.id })
        .onConflictDoUpdate({
          target: schema.skuParams.skuId,
          set: { normalLeadDays: p.normal, urgentLeadDays: p.urgent, updatedBy: user.id, updatedAt: new Date() },
        });
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_sku_params",
      action: "release",
      after: { upserted: plans.length, unresolvedSku },
    });
  });
  return { dryRun: false, upserted: plans.length, unresolvedSku };
}

/* ══ 9) releaseFinishedMoq（起订量 → uom_convs.moq） ══════ */
