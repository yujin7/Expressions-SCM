/** release 流水线：finished-moq（自 engine.ts 拆出，行为未变） */
import { eq, inArray } from "drizzle-orm";

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

export interface ReleaseMoqResult {
  dryRun: boolean;
  updated: number;
  created: number;
  unresolvedSku: number;
}

/**
 * 从 sku_leadtime staging（生产周期明细）提取「成品起订量」→ uom_convs.moq。
 * R11 建议量即刻受益；行保持 staging（周期字段本体仍按裁决 1.1 落表）。
 * 幂等：同 SKU 重放=覆盖 moq；不动已有换算行的其他字段。
 */
export async function releaseFinishedMoq(
  user: ReleaseUser,
  args: { dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseMoqResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, "sku_leadtime");
  const resolve = aliasCache(db);

  const moqByCode = new Map<string, number>();
  for (const r of rows) {
    const p = r.payload as { skuCode?: string | null; moq?: unknown };
    const code = typeof p.skuCode === "string" ? p.skuCode : null;
    const moq = typeof p.moq === "number" && Number.isFinite(p.moq) ? p.moq : null;
    if (!code || moq == null || moq <= 0) continue;
    if (!moqByCode.has(code)) moqByCode.set(code, moq); // 首见为准
  }

  let updated = 0, created = 0, unresolvedSku = 0;
  const plans: { skuId: number; moq: number }[] = [];
  const codeList = [...moqByCode.keys()];
  const skuByCode = await loadSkuIdByCode(db, codeList);
  for (const [code, moq] of moqByCode) {
    const skuId = (await resolve("sku_code", code)) ?? skuByCode.get(code) ?? null;
    if (skuId == null) { unresolvedSku++; continue; }
    plans.push({ skuId, moq });
  }

  const existing: { id: number; skuId: number }[] = plans.length
    ? await db
        .select({ id: schema.uomConvs.id, skuId: schema.uomConvs.skuId })
        .from(schema.uomConvs)
        .where(inArray(schema.uomConvs.skuId, plans.map((p) => p.skuId)))
    : [];
  const firstConvBySku = new Map<number, number>();
  for (const e of existing) if (!firstConvBySku.has(e.skuId)) firstConvBySku.set(e.skuId, e.id);
  for (const p of plans) {
    if (firstConvBySku.has(p.skuId)) updated++;
    else created++;
  }
  if (args.dryRun) return { dryRun: true, updated, created, unresolvedSku };

  await db.transaction(async (tx: AnyDb) => {
    await assertRowsReleaseable(tx, rows.map((row) => row.id));
    for (const p of plans) {
      const convId = firstConvBySku.get(p.skuId);
      if (convId != null) {
        await tx.update(schema.uomConvs).set({ moq: String(p.moq) }).where(eq(schema.uomConvs.id, convId));
      } else {
        await tx.insert(schema.uomConvs).values({
          skuId: p.skuId,
          purchaseUom: "基础单位",
          factor: "1",
          moq: String(p.moq),
        });
      }
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_finished_moq",
      action: "release",
      after: { updated, created, unresolvedSku },
    });
  });
  return { dryRun: false, updated, created, unresolvedSku };
}
