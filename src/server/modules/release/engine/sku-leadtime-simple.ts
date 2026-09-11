/**
 * 放行流水线：简版周期补录表（#2）staging → `sku_params`。
 *
 * 上传只入 staging（本仓铁律：写主档必须过放行工作台的人工闸），所以这条回路
 * 必须有自己的放行动作，否则文件传进来就永远停在 staging——那正是既有
 * `sku_leadtime`（交期参考）的现状：`releaseSkuParams` 存在，但没有任何路由或页面调用它。
 *
 * 写入口径与页面逐行 PATCH / 批量补录**完全一致**（同一套 `leadFieldsFor`）：
 *  - 成品/半成品收 加工 + 在途；原料/包材收 采购；不适用的字段整行不写并记原因；
 *  - 缺省只填空值；`overwrite=true` 才覆盖已有值（预演里分别报数）；
 *  - 未解析到 SKU 的行不写、记 unresolvedSku 并把原因写回 staging 行；
 *  - 同一编码在文件里出现多次且值不一致 → 整个编码阻塞（不猜哪一行是对的）。
 */
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { leadFieldsFor, type LeadField } from "@/server/modules/master/sku-supply-params-fill";
import { SKU_LEADTIME_SIMPLE_TEMPLATE } from "@/lib/supply-params-csv";
import { inArray } from "drizzle-orm";
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

export interface ReleaseSkuLeadtimeSimpleResult {
  dryRun: boolean;
  /** 写入的 SKU 数 */
  upserted: number;
  /** 补空字段数 */
  filled: number;
  /** 覆盖已有值的字段数 */
  overridden: number;
  /** 值与现状一致、无需写入的 SKU 数 */
  unchanged: number;
  /** 未解析到主档 SKU 的编码数 */
  unresolvedSku: number;
  /** 因类型不适用或文件内冲突而阻塞的编码数 */
  blocked: number;
}

const LEAD_FIELDS: LeadField[] = ["normalLeadDays", "logisticsLeadDays", "purchaseLeadDays"];

export async function releaseSkuLeadtimeSimple(
  user: ReleaseUser,
  args: { dryRun: boolean; overwrite?: boolean; jobIds?: number[] },
  dbArg?: AnyDb,
): Promise<ReleaseSkuLeadtimeSimpleResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, SKU_LEADTIME_SIMPLE_TEMPLATE, args.jobIds);
  const resolve = aliasCache(db);

  /* 文件内按编码归并；同编码不同值 → 阻塞该编码（不做"首见为准"，
     这份表是人手填的，两行不一致意味着有人填错了，猜一个只会把错的写进主档） */
  const byCode = new Map<string, { values: Partial<Record<LeadField, number>>; rowIds: number[]; conflict: boolean }>();
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>;
    const code = typeof p.skuCode === "string" ? p.skuCode.trim() : null;
    if (!code) continue;
    const entry = byCode.get(code) ?? { values: {}, rowIds: [], conflict: false };
    entry.rowIds.push(r.id);
    for (const f of LEAD_FIELDS) {
      const v = p[f];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const prior = entry.values[f];
      if (prior !== undefined && prior !== v) entry.conflict = true;
      entry.values[f] = v;
    }
    byCode.set(code, entry);
  }

  const codes = [...byCode.keys()];
  const skuByCode = await loadSkuIdByCode(db, codes);
  const resolvedIds: number[] = [];
  const resolvedCode = new Map<number, string>();
  let unresolvedSku = 0;
  let blocked = 0;
  const blockedRowIds: { rowId: number; reason: string }[] = [];

  for (const [code, entry] of byCode) {
    if (entry.conflict) {
      blocked += 1;
      for (const id of entry.rowIds) blockedRowIds.push({ rowId: id, reason: `文件内同编码 ${code} 的周期值不一致，整项阻塞` });
      continue;
    }
    const skuId = (await resolve("sku_code", code)) ?? skuByCode.get(code) ?? null;
    if (skuId == null) {
      unresolvedSku += 1;
      for (const id of entry.rowIds) blockedRowIds.push({ rowId: id, reason: `未解析到主档 SKU：${code}` });
      continue;
    }
    resolvedIds.push(skuId);
    resolvedCode.set(skuId, code);
  }

  const skuTypes: { id: number; skuType: string }[] = resolvedIds.length
    ? await db.select({ id: schema.skus.id, skuType: schema.skus.skuType }).from(schema.skus).where(inArray(schema.skus.id, resolvedIds))
    : [];
  const typeById = new Map(skuTypes.map((s) => [s.id, s.skuType]));
  const existing: { skuId: number; normalLeadDays: number | null; logisticsLeadDays: number | null; purchaseLeadDays: number | null }[] =
    resolvedIds.length
      ? await db
        .select({
          skuId: schema.skuParams.skuId,
          normalLeadDays: schema.skuParams.normalLeadDays,
          logisticsLeadDays: schema.skuParams.logisticsLeadDays,
          purchaseLeadDays: schema.skuParams.purchaseLeadDays,
        })
        .from(schema.skuParams)
        .where(inArray(schema.skuParams.skuId, resolvedIds))
      : [];
  const paramsById = new Map(existing.map((r) => [r.skuId, r]));

  const plans: { skuId: number; code: string; set: Partial<Record<LeadField, number>>; before: Record<LeadField, number | null>; rowIds: number[] }[] = [];
  let filled = 0;
  let overridden = 0;
  let unchanged = 0;

  for (const skuId of resolvedIds) {
    const code = resolvedCode.get(skuId)!;
    const entry = byCode.get(code)!;
    const applicable = leadFieldsFor(typeById.get(skuId) ?? "");
    const prev = paramsById.get(skuId);
    const before: Record<LeadField, number | null> = {
      normalLeadDays: prev?.normalLeadDays ?? null,
      logisticsLeadDays: prev?.logisticsLeadDays ?? null,
      purchaseLeadDays: prev?.purchaseLeadDays ?? null,
    };
    const set: Partial<Record<LeadField, number>> = {};
    let sawInapplicable = false;
    for (const f of LEAD_FIELDS) {
      const next = entry.values[f];
      if (next === undefined) continue;
      if (!applicable.includes(f)) { sawInapplicable = true; continue; }
      if (before[f] === next) continue;
      if (before[f] != null) {
        if (!args.overwrite) continue;
        overridden += 1;
      } else {
        filled += 1;
      }
      set[f] = next;
    }
    if (Object.keys(set).length === 0) {
      if (sawInapplicable) {
        blocked += 1;
        for (const id of entry.rowIds) blockedRowIds.push({ rowId: id, reason: `${code} 的类型不适用该周期字段（成品/半成品填加工+在途，原料/包材填采购）` });
      } else {
        unchanged += 1;
      }
      continue;
    }
    plans.push({ skuId, code, set, before, rowIds: entry.rowIds });
  }

  const result: ReleaseSkuLeadtimeSimpleResult = {
    dryRun: args.dryRun,
    upserted: plans.length,
    filled,
    overridden,
    unchanged,
    unresolvedSku,
    blocked,
  };
  if (args.dryRun) return result;

  await db.transaction(async (tx: AnyDb) => {
    for (const plan of plans) {
      await tx
        .insert(schema.skuParams)
        .values({ skuId: plan.skuId, ...plan.set, updatedBy: user.id, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.skuParams.skuId,
          set: { ...plan.set, updatedBy: user.id, updatedAt: new Date() },
        });
      await commitRows(tx, plan.rowIds, plan.skuId);
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_sku_leadtime_simple",
      action: "release",
      after: { upserted: plans.length, filled, overridden, unchanged, unresolvedSku, blocked, codes: plans.slice(0, 50).map((p) => p.code) },
    });
  });
  for (const b of blockedRowIds) await markBlocked(db, b.rowId, b.reason);
  return result;
}
