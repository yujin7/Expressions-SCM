/** release 流水线：snapshots（自 engine.ts 拆出，行为未变） */
import { inArray } from "drizzle-orm";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";

import type { BomBlock, BomLine } from "@/server/import/adapters/bom";
import type { SpuCluster } from "@/server/import/adapters/bom-spu";
import { type AnyDb, type ReleaseUser, resolveDb, loadStagedRows, commitRows, markBlocked, aliasCache, loadSkuIdByCode } from "./common";

export interface ReleaseSnapshotsResult {
  dryRun: boolean;
  bizDate: string;
  upserts: number; // (仓库,SKU) 键数
  rowsCommitted: number;
  zeroSkipped: number;
  blocked: { stagingRowId: number; reason: string }[];
}

/**
 * 电商部库存明细（stock_opening_candidate）→ stock_snapshots 周期刷新。
 * 铁律：只吃快照仓——实时仓行阻塞（期初仅建账期执行，日常实时仓走单据过账，
 * 快照旁路会造成双套账）；SKU/仓库别名未解析→阻塞不猜；同键 upsert（重导幂等）。
 */
export async function releaseSnapshots(
  user: ReleaseUser,
  args: { jobIds?: number[]; bizDate: string; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseSnapshotsResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, "stock_opening_candidate", args.jobIds);
  const resolve = aliasCache(db);

  interface Payload { warehouseRaw?: string; skuCode?: string; qty?: number }
  const codeList = rows.map((r) => (r.payload as Payload).skuCode).filter((c): c is string => typeof c === "string");
  const skuByCode = await loadSkuIdByCode(db, codeList);
  const whRows: { id: number; accountingMode: string }[] = await db
    .select({ id: schema.warehouses.id, accountingMode: schema.warehouses.accountingMode })
    .from(schema.warehouses);
  const whMode = new Map(whRows.map((w) => [w.id, w.accountingMode]));

  const blocked: ReleaseSnapshotsResult["blocked"] = [];
  const zeroRows: number[] = [];
  const agg = new Map<string, { warehouseId: number; skuId: number; qty: number; rowIds: number[] }>();

  for (const r of rows) {
    const p = r.payload as Payload;
    const whRaw = p.warehouseRaw ?? "";
    const skuCode = p.skuCode ?? "";
    const warehouseId = whRaw ? await resolve("warehouse", whRaw) : null;
    if (warehouseId == null) {
      blocked.push({ stagingRowId: r.id, reason: `仓库别名未认领：${whRaw || "(空)"}` });
      continue;
    }
    if (whMode.get(warehouseId) === "realtime") {
      blocked.push({ stagingRowId: r.id, reason: "实时仓不吃快照——日常出入走单据过账（防双套账）" });
      continue;
    }
    const skuId = (await resolve("sku_code", skuCode)) ?? skuByCode.get(skuCode) ?? null;
    if (skuId == null) {
      blocked.push({ stagingRowId: r.id, reason: `SKU 别名未认领且无同码主档：${skuCode}` });
      continue;
    }
    if (typeof p.qty !== "number" || !Number.isFinite(p.qty)) {
      blocked.push({ stagingRowId: r.id, reason: "数量非法" });
      continue;
    }
    if (p.qty === 0) {
      zeroRows.push(r.id);
      continue;
    }
    const key = `${warehouseId}|${skuId}`;
    const e = agg.get(key) ?? { warehouseId, skuId, qty: 0, rowIds: [] };
    e.qty += p.qty;
    e.rowIds.push(r.id);
    agg.set(key, e);
  }

  if (args.dryRun) {
    return {
      dryRun: true,
      bizDate: args.bizDate,
      upserts: agg.size,
      rowsCommitted: [...agg.values()].reduce((a, e) => a + e.rowIds.length, 0) + zeroRows.length,
      zeroSkipped: zeroRows.length,
      blocked,
    };
  }

  let rowsCommitted = 0;
  await db.transaction(async (tx: AnyDb) => {
    for (const e of agg.values()) {
      const [row] = await tx
        .insert(schema.stockSnapshots)
        .values({ warehouseId: e.warehouseId, skuId: e.skuId, bizDate: args.bizDate, qty: String(e.qty) })
        .onConflictDoUpdate({
          target: [schema.stockSnapshots.warehouseId, schema.stockSnapshots.skuId, schema.stockSnapshots.bizDate],
          set: { qty: String(e.qty) },
        })
        .returning({ id: schema.stockSnapshots.id });
      await commitRows(tx, e.rowIds, row.id);
      rowsCommitted += e.rowIds.length;
    }
    if (zeroRows.length > 0) {
      await tx
        .update(schema.stagingRows)
        .set({ status: "committed", targetId: null, errorMsg: "数量0——快照不落行" })
        .where(inArray(schema.stagingRows.id, zeroRows));
      rowsCommitted += zeroRows.length;
    }
    for (const b of blocked) await markBlocked(tx, b.stagingRowId, b.reason);
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_snapshot",
      action: "release",
      after: { jobIds: args.jobIds ?? null, bizDate: args.bizDate, upserts: agg.size, rowsCommitted, zeroSkipped: zeroRows.length, blocked: blocked.length },
    });
  });

  return { dryRun: false, bizDate: args.bizDate, upserts: agg.size, rowsCommitted, zeroSkipped: zeroRows.length, blocked };
}

/* ══ 7) releaseStatus（UI 汇总） ═════════════════════════ */

