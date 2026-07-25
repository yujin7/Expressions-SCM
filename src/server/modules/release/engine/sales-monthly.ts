/** release 流水线：sales-monthly（自 engine.ts 拆出，行为未变） */
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

export interface ReleaseSalesMonthlyResult {
  dryRun: boolean;
  created: number;
  updated: number;
  blocked: number;
  unresolved: { sku: number; channel: number };
}

export async function releaseSalesMonthly(
  user: ReleaseUser,
  args: { jobIds?: number[]; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseSalesMonthlyResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, "sales_monthly", args.jobIds);
  const resolve = aliasCache(db);

  interface Payload { skuCode?: string | null; channelRaw?: string | null; yearMonth?: string; qty?: number }
  const codeList = rows.map((r) => (r.payload as Payload).skuCode).filter((c): c is string => typeof c === "string");
  const skuByCode = await loadSkuIdByCode(db, codeList);

  const unresolvedSku = new Set<string>();
  const unresolvedChannel = new Set<string>();
  let blockedCount = 0;
  interface Plan { rowId: number; skuId: number; channelId: number; yearMonth: string; qty: string }
  const plans: Plan[] = [];
  const blockedReasons = new Map<number, string>();

  for (const r of rows) {
    const p = r.payload as Payload;
    const skuCode = p.skuCode ?? null;
    const channelRaw = p.channelRaw ?? null;
    if (!skuCode || !channelRaw || !p.yearMonth || typeof p.qty !== "number") {
      blockedCount++;
      blockedReasons.set(r.id, "载荷缺字段（skuCode/channelRaw/yearMonth/qty）");
      continue;
    }
    const skuId = (await resolve("sku_code", skuCode)) ?? skuByCode.get(skuCode) ?? null;
    if (skuId == null) {
      unresolvedSku.add(skuCode);
      blockedCount++;
      blockedReasons.set(r.id, `SKU 别名未认领：${skuCode}`);
      continue;
    }
    const channelId = await resolve("channel", channelRaw);
    if (channelId == null) {
      unresolvedChannel.add(channelRaw);
      blockedCount++;
      blockedReasons.set(r.id, `渠道别名未认领：${channelRaw}`);
      continue;
    }
    plans.push({ rowId: r.id, skuId, channelId, yearMonth: p.yearMonth, qty: String(p.qty) });
  }

  // RT4-F2：同键（sku,channel,yearMonth）聚合后再 upsert——渠道别名归并
  // （抖音商品卡/抖音运营部→douyin 等）会让同 SKU 同月多条 staging 行同键，
  // 逐行 upsert 的"后写覆盖"会静默丢销量。聚合用 dAdd（禁 float）。
  interface Agg { skuId: number; channelId: number; yearMonth: string; qty: string; rowIds: number[] }
  const aggByKey = new Map<string, Agg>();
  for (const p of plans) {
    const key = `${p.skuId}|${p.channelId}|${p.yearMonth}`;
    const a = aggByKey.get(key);
    if (a) {
      a.qty = dAdd(a.qty, p.qty);
      a.rowIds.push(p.rowId);
    } else {
      aggByKey.set(key, { skuId: p.skuId, channelId: p.channelId, yearMonth: p.yearMonth, qty: p.qty, rowIds: [p.rowId] });
    }
  }

  // 既有键预载 → created/updated 口径
  const existingKey = new Map<string, number>(); // sku|chan|ym → id
  {
    const skuIds = [...new Set(plans.map((p) => p.skuId))];
    if (skuIds.length > 0) {
      const ex: { id: number; skuId: number; channelId: number; yearMonth: string }[] = await db
        .select({
          id: schema.salesMonthly.id,
          skuId: schema.salesMonthly.skuId,
          channelId: schema.salesMonthly.channelId,
          yearMonth: schema.salesMonthly.yearMonth,
        })
        .from(schema.salesMonthly)
        .where(inArray(schema.salesMonthly.skuId, skuIds));
      for (const e of ex) existingKey.set(`${e.skuId}|${e.channelId}|${e.yearMonth}`, e.id);
    }
  }
  let created = 0;
  let updated = 0;
  for (const key of aggByKey.keys()) {
    if (existingKey.has(key)) updated++;
    else created++;
  }

  const unresolved = { sku: unresolvedSku.size, channel: unresolvedChannel.size };
  if (args.dryRun) return { dryRun: true, created, updated, blocked: blockedCount, unresolved };

  await db.transaction(async (tx: AnyDb) => {
    for (const a of aggByKey.values()) {
      const [row] = await tx
        .insert(schema.salesMonthly)
        .values({ skuId: a.skuId, channelId: a.channelId, yearMonth: a.yearMonth, qty: a.qty })
        .onConflictDoUpdate({
          target: [schema.salesMonthly.skuId, schema.salesMonthly.channelId, schema.salesMonthly.yearMonth],
          set: { qty: a.qty },
        })
        .returning({ id: schema.salesMonthly.id });
      await commitRows(tx, a.rowIds, row.id);
    }
    for (const [rowId, reason] of blockedReasons) await markBlocked(tx, rowId, reason);
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_sales_monthly",
      action: "release",
      after: { jobIds: args.jobIds ?? null, created, updated, blocked: blockedCount, unresolved },
    });
  });
  return { dryRun: false, created, updated, blocked: blockedCount, unresolved };
}

/* ══ 6.5) releaseSnapshots（快照仓周期刷新，D20 运营环） ══ */

