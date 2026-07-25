/** release 流水线：batch-stocks（自 engine.ts 拆出，行为未变） */
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

export interface ReleaseBatchStocksResult {
  dryRun: boolean;
  created: number;
  blocked: { stagingRowId: number; skuCode: string | null; reason: string }[];
  unresolved: { sku: number; warehouse: number };
  /** 顺带回填的主档保质期（D13）——见下方 shelfLife 段注释 */
  shelfLife: {
    /** 实际写入 skus.shelf_life_days 的 SKU 数（仅填空，不覆盖已有值） */
    filled: number;
    /** 同一 SKU 在文件里出现互相矛盾的保质期 → 不猜，跳过并列出 */
    conflicted: string[];
  };
}

export async function releaseBatchStocks(
  user: ReleaseUser,
  args: { jobIds?: number[]; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseBatchStocksResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, "batch_stock", args.jobIds);
  const resolve = aliasCache(db);

  interface Payload {
    sheetWarehouse?: string | null;
    skuCode?: string | null;
    prodDate?: string | null;
    expiryDate?: string | null;
    qty?: number;
    stocktakeDate?: string | null;
    shelfLifeDays?: number | null;
  }
  const codeList = rows
    .map((r) => (r.payload as Payload).skuCode)
    .filter((c): c is string => typeof c === "string");
  const skuByCode = await loadSkuIdByCode(db, codeList);

  const blocked: ReleaseBatchStocksResult["blocked"] = [];
  const unresolvedSku = new Set<string>();
  const unresolvedWh = new Set<string>();
  const plans: { rowId: number; values: typeof schema.batchStocks.$inferInsert }[] = [];
  /* ── D13 保质期回填 ──
     适配器早已从效期文件解析出保质期并落进 staging，但此前从未写回主档，
     导致 skus.shelf_life_days 全表为空（实测 1026/1026 在售成品），
     「我们的临期阈值够不够渠道用」这个问题因此根本无法回答（见 report/data-health 结构性告警）。
     此处顺带回填，纪律三条：
       ① 只填空，不覆盖人工已设的值（主档以人为准）；
       ② 同一 SKU 若文件内出现互相矛盾的保质期 → 记 conflicted 不猜（《绝不猜》）；
       ③ 与批次写入同事务、同审计。 ── */
  const shelfBySku = new Map<number, { days: number; code: string; conflict: boolean }>();

  for (const r of rows) {
    const p = r.payload as Payload;
    const skuCode = p.skuCode ?? null;
    if (!skuCode) {
      blocked.push({ stagingRowId: r.id, skuCode: null, reason: "缺商品编码" });
      continue;
    }
    // sku_code 别名优先，编码精确匹配兜底（精确匹配非猜测）
    const skuId = (await resolve("sku_code", skuCode)) ?? skuByCode.get(skuCode) ?? null;
    if (skuId == null) {
      unresolvedSku.add(skuCode);
      blocked.push({ stagingRowId: r.id, skuCode, reason: "SKU 别名未认领且无同码主档" });
      continue;
    }
    // 保质期候选：只在 skuId 已确定后收集；矛盾即打标不猜
    if (typeof p.shelfLifeDays === "number" && p.shelfLifeDays > 0) {
      const prev = shelfBySku.get(skuId);
      if (!prev) shelfBySku.set(skuId, { days: p.shelfLifeDays, code: skuCode, conflict: false });
      else if (prev.days !== p.shelfLifeDays) prev.conflict = true;
    }

    const whRaw = p.sheetWarehouse ?? "";
    const warehouseId = whRaw ? await resolve("warehouse", whRaw) : null;
    if (warehouseId == null) {
      unresolvedWh.add(whRaw || "(空)");
      blocked.push({ stagingRowId: r.id, skuCode, reason: `仓库别名未认领：${whRaw || "(空)"}` });
      continue;
    }
    if (!p.stocktakeDate) {
      blocked.push({ stagingRowId: r.id, skuCode, reason: "缺盘点所属期间" });
      continue;
    }
    if (typeof p.qty !== "number" || !Number.isFinite(p.qty)) {
      blocked.push({ stagingRowId: r.id, skuCode, reason: "盘点数量非法" });
      continue;
    }
    // RT4-F8：日期格式行级校验——畸形值直插 date 列会令整批事务回滚
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    if ((p.prodDate && !ISO.test(p.prodDate)) || (p.expiryDate && !ISO.test(p.expiryDate)) || !ISO.test(p.stocktakeDate)) {
      blocked.push({ stagingRowId: r.id, skuCode, reason: "日期格式非法（须 YYYY-MM-DD）" });
      continue;
    }
    plans.push({
      rowId: r.id,
      values: {
        skuId,
        warehouseId,
        batchNo: null,
        prodDate: p.prodDate ?? null,
        expiryDate: p.expiryDate ?? null,
        qty: String(p.qty),
        stocktakeDate: p.stocktakeDate,
        source: "expiry_import",
      },
    });
  }

  const unresolved = { sku: unresolvedSku.size, warehouse: unresolvedWh.size };
  const shelfConflicted = [...shelfBySku.values()].filter((v) => v.conflict).map((v) => v.code).sort();
  const shelfCandidates = [...shelfBySku.entries()].filter(([, v]) => !v.conflict);
  if (args.dryRun) {
    // dry-run 预览：报「候选数」而非「将写入数」——真正写几条取决于当前哪些主档为空
    return {
      dryRun: true, created: plans.length, blocked, unresolved,
      shelfLife: { filled: shelfCandidates.length, conflicted: shelfConflicted },
    };
  }

  // RT4-F7：同自然键先聚合（同键两行=同期同效期两笔实物，dAdd 求和），
  // 跨轮重放 = 整键覆盖（与快照 upsert 同口径），不再重复插行。
  const aggBatch = new Map<string, { values: typeof schema.batchStocks.$inferInsert; rowIds: number[] }>();
  for (const plan of plans) {
    const v = plan.values;
    const key = [v.skuId, v.warehouseId, v.stocktakeDate, v.prodDate ?? "", v.expiryDate ?? "", v.batchNo ?? ""].join("|");
    const a = aggBatch.get(key);
    if (a) {
      a.values.qty = dAdd(String(a.values.qty), String(v.qty));
      a.rowIds.push(plan.rowId);
    } else {
      aggBatch.set(key, { values: { ...v }, rowIds: [plan.rowId] });
    }
  }
  let shelfFilled = 0;
  await db.transaction(async (tx: AnyDb) => {
    for (const a of aggBatch.values()) {
      const [row] = await tx
        .insert(schema.batchStocks)
        .values(a.values)
        .onConflictDoUpdate({
          target: [
            schema.batchStocks.skuId,
            schema.batchStocks.warehouseId,
            schema.batchStocks.stocktakeDate,
            schema.batchStocks.prodDate,
            schema.batchStocks.expiryDate,
            schema.batchStocks.batchNo,
          ],
          set: { qty: a.values.qty },
        })
        .returning({ id: schema.batchStocks.id });
      await commitRows(tx, a.rowIds, row.id);
    }
    for (const bl of blocked) await markBlocked(tx, bl.stagingRowId, bl.reason);

    /* D13 保质期回填：只填空（IS NULL / <=0），不覆盖人工已设值 */
    for (const [skuId, v] of shelfCandidates) {
      const res = await tx
        .update(schema.skus)
        .set({ shelfLifeDays: v.days })
        .where(
          and(
            eq(schema.skus.id, skuId),
            sql`(${schema.skus.shelfLifeDays} is null or ${schema.skus.shelfLifeDays} <= 0)`,
          ),
        )
        .returning({ id: schema.skus.id });
      shelfFilled += res.length;
    }

    await writeAudit(tx, {
      userId: user.id,
      entity: "release_batch_stock",
      action: "release",
      after: {
        jobIds: args.jobIds ?? null, created: plans.length, blocked: blocked.length, unresolved,
        shelfLifeFilled: shelfFilled, shelfLifeConflicted: shelfConflicted.length,
      },
    });
  });
  return {
    dryRun: false, created: plans.length, blocked, unresolved,
    shelfLife: { filled: shelfFilled, conflicted: shelfConflicted },
  };
}

/* ══ 6) releaseSalesMonthly（月销量 upsert） ══════════════ */

