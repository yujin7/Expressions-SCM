/**
 * DW2 放行引擎（《04》§4）：staging 行 → 正式主档，人工闸不旁路。
 *
 * 铁律（引擎级）：
 * - dry-run 先行：所有放行函数吃 {dryRun}，dry-run 返回完整计数/冲突/待复核清单，零写入；
 * - 幂等：按编码 upsert 语义；同 job 重放行时已 committed 的行不再入选（报 existing/skipped）；
 * - 绝不猜测：别名未解析 / 歧义块（§4.3）/ 缺必填 → 该行保持未提交并记原因，
 *   §4.1/§4.3 归属人工的判定引擎一律不代劳；
 * - 审计按放行批次记 1 行/实体（计数摘要），不逐行。
 *
 * 决策备注（v1 取舍，测试与报告同步说明）：
 * - 物料 SKU 的 spuId 暂挂其父成品的 SPU（物料属产品族簇）——v1 可接受，1.1 可迁独立物料 SPU；
 * - BOM 文件不携带基础单位：成品 baseUom 一律「件」并打 attrs.needsReview=["baseUom"] 标记，
 *   物料按 uomGuess 落「个/g」，除全 count 外均打标——显式待复核，不静默瞎猜。
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";

import {
  normalizeAliasText,
  resolveAlias,
  type DimDb,
} from "@/server/modules/dimension/resolver";
import { ApiError } from "@/server/modules/master/common";
import type { BomBlock } from "@/server/import/adapters/bom";
import type { SpuCluster } from "@/server/import/adapters/bom-spu";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
export type AnyDb = any;

export interface ReleaseUser {
  id: number;
  name: string;
  roles: string[];
  isApprover: boolean;
}

export const resolveDb = async (db?: AnyDb): Promise<AnyDb> => db ?? (await getDbAsync());

/* ── 公共小件 ─────────────────────────────────────── */

export interface StagedRow {
  id: number;
  importJobId: number;
  rowNo: number;
  payload: unknown;
  status: string;
  errorMsg: string | null;
  targetTable: string | null;
  targetId: number | null;
}

/** 未放行的行 = pending/validated（error=拒收道，committed=已放行——均不入选） */
export async function loadStagedRows(db: AnyDb, targetTable: string, jobIds?: number[]): Promise<StagedRow[]> {
  const conds = [
    eq(schema.stagingRows.targetTable, targetTable),
    inArray(schema.stagingRows.status, ["pending", "validated"]),
  ];
  if (jobIds && jobIds.length > 0) conds.push(inArray(schema.stagingRows.importJobId, jobIds));
  const candidates: Array<StagedRow & { importScope: unknown }> = await db
    .select({
      id: schema.stagingRows.id,
      importJobId: schema.stagingRows.importJobId,
      rowNo: schema.stagingRows.rowNo,
      payload: schema.stagingRows.payload,
      status: schema.stagingRows.status,
      errorMsg: schema.stagingRows.errorMsg,
      targetTable: schema.stagingRows.targetTable,
      targetId: schema.stagingRows.targetId,
      importScope: schema.importJobs.scope,
    })
    .from(schema.stagingRows)
    .innerJoin(schema.importJobs, eq(schema.importJobs.id, schema.stagingRows.importJobId))
    .where(and(...conds))
    .orderBy(asc(schema.stagingRows.importJobId), asc(schema.stagingRows.rowNo));
  const blockedJobIds = [...new Set(candidates
    .filter((row) => {
      const scope = row.importScope;
      return !!scope && typeof scope === "object"
        && !Array.isArray(scope)
        && (scope as Record<string, unknown>).releaseBlocked === true;
    })
    .map((row) => row.importJobId))];
  if (blockedJobIds.length > 0) {
    throw new ApiError(
      409,
      `导入任务 ${blockedJobIds.join(", ")} 标记为 releaseBlocked，禁止进入正式放行引擎`,
    );
  }
  return candidates.map(({ importScope: _importScope, ...row }) => row);
}

function isReleaseBlockedScope(scope: unknown): boolean {
  return !!scope
    && typeof scope === "object"
    && !Array.isArray(scope)
    && (scope as Record<string, unknown>).releaseBlocked === true;
}

/**
 * Mutation-time guard shared by every release writer.
 *
 * Call this inside the writer transaction. `FOR UPDATE` locks both the staging and owning import
 * job rows, so a connector cannot toggle releaseBlocked or replace the candidate status between
 * the decision read and the destination write.
 */
export async function assertRowsReleaseable(db: AnyDb, rowIds: number[]): Promise<void> {
  const selectedIds = [...new Set(rowIds)];
  if (selectedIds.length === 0) return;
  const rows: { id: number; importJobId: number; status: string; scope: unknown }[] = [];
  for (let index = 0; index < selectedIds.length; index += 500) {
    const chunk = selectedIds.slice(index, index + 500);
    const locked = await db
      .select({
        id: schema.stagingRows.id,
        importJobId: schema.stagingRows.importJobId,
        status: schema.stagingRows.status,
        scope: schema.importJobs.scope,
      })
      .from(schema.stagingRows)
      .innerJoin(schema.importJobs, eq(schema.importJobs.id, schema.stagingRows.importJobId))
      .where(inArray(schema.stagingRows.id, chunk))
      .for("update");
    rows.push(...locked);
  }
  const found = new Set(rows.map((row) => row.id));
  const missing = selectedIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApiError(409, `放行候选已变化或不存在：staging ${missing.join(", ")}`);
  }
  const blockedJobIds = [...new Set(rows
    .filter((row) => isReleaseBlockedScope(row.scope))
    .map((row) => row.importJobId))];
  if (blockedJobIds.length > 0) {
    throw new ApiError(
      409,
      `导入任务 ${blockedJobIds.join(", ")} 标记为 releaseBlocked，禁止进入正式放行引擎`,
    );
  }
  const changed = rows.filter((row) => !["pending", "validated"].includes(row.status)).map((row) => row.id);
  if (changed.length > 0) {
    throw new ApiError(409, `放行候选状态已变化：staging ${changed.join(", ")}`);
  }
}

export async function commitRows(db: AnyDb, rowIds: number[], targetId: number | null): Promise<void> {
  if (rowIds.length === 0) return;
  await assertRowsReleaseable(db, rowIds);
  const committed: { id: number }[] = await db
    .update(schema.stagingRows)
    .set({ status: "committed", targetId, errorMsg: null })
    .where(and(
      inArray(schema.stagingRows.id, rowIds),
      inArray(schema.stagingRows.status, ["pending", "validated"]),
    ))
    .returning({ id: schema.stagingRows.id });
  if (committed.length !== new Set(rowIds).size) {
    throw new ApiError(409, "放行候选在提交时发生变化，请重新预演");
  }
}

/** 未提交行记阻塞原因（状态保持 pending——原因可见、行仍待处置） */
export async function markBlocked(db: AnyDb, rowId: number, reason: string): Promise<void> {
  await db.update(schema.stagingRows).set({ errorMsg: reason }).where(eq(schema.stagingRows.id, rowId));
}

/** 会话级别名解析缓存（只读 resolveAlias，绝不 queue——放行阶段不再制造异常队列） */
export function aliasCache(db: AnyDb) {
  const cache = new Map<string, number | null>();
  return async (aliasType: schema.AliasType, raw: string): Promise<number | null> => {
    const key = `${aliasType}\0${raw}`;
    if (cache.has(key)) return cache.get(key)!;
    const id = await resolveAlias(db as DimDb, aliasType, raw);
    cache.set(key, id);
    return id;
  };
}

/** SPU 取号：复刻 master/spu.ts 的 doc_counters 原子 upsert 模式（该函数私有，不可 import）——碰撞续取 */
export async function nextSpuCodeIn(db: AnyDb): Promise<string> {
  for (let guard = 0; guard < 100000; guard++) {
    const [row] = await db
      .insert(schema.docCounters)
      .values({ prefix: "SPU", bizDate: "GLOBAL", lastNo: 1 })
      .onConflictDoUpdate({
        target: [schema.docCounters.prefix, schema.docCounters.bizDate],
        set: { lastNo: sql`${schema.docCounters.lastNo} + 1` },
      })
      .returning({ lastNo: schema.docCounters.lastNo });
    const code = `P${String(row.lastNo).padStart(5, "0")}`;
    const [dup] = await db.select({ id: schema.spus.id }).from(schema.spus).where(eq(schema.spus.code, code));
    if (!dup) return code;
  }
  throw new ApiError(500, "SPU 取号异常：连续 10 万次碰撞");
}

/** 已放行 SPU 索引：committed spu_suggestion 行的 members → targetId（成员码 → spuId） */
export async function loadReleasedSpuIndex(db: AnyDb): Promise<Map<string, number>> {
  const rows: { payload: unknown; targetId: number | null }[] = await db
    .select({ payload: schema.stagingRows.payload, targetId: schema.stagingRows.targetId })
    .from(schema.stagingRows)
    .where(
      and(
        eq(schema.stagingRows.targetTable, "spu_suggestion"),
        eq(schema.stagingRows.status, "committed"),
        isNotNull(schema.stagingRows.targetId),
      ),
    );
  const map = new Map<string, number>();
  for (const r of rows) {
    const p = r.payload as Partial<SpuCluster>;
    if (!Array.isArray(p.members) || r.targetId == null) continue;
    for (const m of p.members) if (typeof m === "string") map.set(m, r.targetId);
  }
  return map;
}

/**
 * 编码 → skuId 索引（RT4-F6 修订：别名认领优先，稳定主码与受治理外部标识精确匹配兜底）。
 * 人工把某原始编码认领到了异码主档时，以裁决为准——否则 BOM/费用会另建
 * 分叉主档，与批次/月销（本就别名优先）指向不同 SKU。
 */
export async function loadSkuIdByCode(db: AnyDb, codes: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const uniq = [...new Set(codes)].filter((c) => c);
  const CHUNK = 500;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const candidates = new Map<string, Set<number>>();
    const rows: { id: number; code: string }[] = await db
      .select({ id: schema.skus.id, code: schema.skus.code })
      .from(schema.skus)
      .where(inArray(schema.skus.code, chunk));
    for (const row of rows) {
      const ids = candidates.get(row.code) ?? new Set<number>();
      ids.add(row.id);
      candidates.set(row.code, ids);
    }
    const identifiers: { value: string; skuId: number }[] = await db
      .select({ value: schema.skuIdentifiers.value, skuId: schema.skuIdentifiers.skuId })
      .from(schema.skuIdentifiers)
      .where(and(
        inArray(schema.skuIdentifiers.value, chunk),
        eq(schema.skuIdentifiers.active, true),
        inArray(schema.skuIdentifiers.kind, ["external", "vendor", "customer", "legacy"]),
      ));
    for (const row of identifiers) {
      const ids = candidates.get(row.value) ?? new Set<number>();
      ids.add(row.skuId);
      candidates.set(row.value, ids);
    }
    for (const [code, ids] of candidates) {
      if (ids.size === 1) map.set(code, [...ids][0]);
    }
  }
  // 别名覆盖（后写胜出）：sku_code 裁决 > 码面巧合
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const rows: { rawValue: string; targetId: number | null }[] = await db
      .select({ rawValue: schema.aliases.rawValue, targetId: schema.aliases.targetId })
      .from(schema.aliases)
      .where(and(
        eq(schema.aliases.aliasType, "sku_code"),
        eq(schema.aliases.scope, schema.GLOBAL_ALIAS_SCOPE),
        inArray(schema.aliases.rawValue, uniq.slice(i, i + CHUNK)),
      ));
    for (const r of rows) if (r.targetId != null) map.set(r.rawValue, r.targetId);
  }
  return map;
}

export interface InternalSkuIdentityResolution {
  resolved: Map<string, number>;
  ambiguous: Map<string, number[]>;
  /** Inactive INTERNAL legacy values remain reserved until an explicit human adjudication. */
  reserved: Map<string, number[]>;
}

/**
 * Production BOM identity resolver.
 *
 * Only an explicit GLOBAL sku_code adjudication, an exact canonical code, or an active
 * INTERNAL legacy identifier may resolve a source code. Vendor/customer/external scopes are
 * intentionally excluded: their identical short codes are not enterprise master identity.
 */
export async function loadInternalSkuIdentityResolution(
  db: AnyDb,
  codes: string[],
): Promise<InternalSkuIdentityResolution> {
  const originals = [...new Set(codes)].filter(Boolean);
  const normalizedByOriginal = new Map(originals.map((code) => [code, normalizeAliasText(code)]));
  const normalizedCodes = [...new Set(normalizedByOriginal.values())].filter(Boolean);
  const candidates = new Map<string, Set<number>>();
  const inactiveLegacy = new Map<string, Set<number>>();
  const adjudicated = new Map<string, number>();
  const CHUNK = 500;

  for (let index = 0; index < normalizedCodes.length; index += CHUNK) {
    const chunk = normalizedCodes.slice(index, index + CHUNK);
    const canonical: { id: number; code: string }[] = await db
      .select({ id: schema.skus.id, code: schema.skus.code })
      .from(schema.skus)
      .where(inArray(schema.skus.code, chunk));
    for (const row of canonical) {
      const key = normalizeAliasText(row.code);
      const ids = candidates.get(key) ?? new Set<number>();
      ids.add(row.id);
      candidates.set(key, ids);
    }

    const legacy: { value: string; skuId: number; active: boolean }[] = await db
      .select({
        value: schema.skuIdentifiers.value,
        skuId: schema.skuIdentifiers.skuId,
        active: schema.skuIdentifiers.active,
      })
      .from(schema.skuIdentifiers)
      .where(and(
        inArray(schema.skuIdentifiers.value, chunk),
        eq(schema.skuIdentifiers.kind, "legacy"),
        eq(schema.skuIdentifiers.scope, "INTERNAL"),
      ));
    for (const row of legacy) {
      const key = normalizeAliasText(row.value);
      const target = row.active ? candidates : inactiveLegacy;
      const ids = target.get(key) ?? new Set<number>();
      ids.add(row.skuId);
      target.set(key, ids);
    }

    const aliases: { rawValue: string; targetId: number }[] = await db
      .select({ rawValue: schema.aliases.rawValue, targetId: schema.aliases.targetId })
      .from(schema.aliases)
      .where(and(
        eq(schema.aliases.aliasType, "sku_code"),
        eq(schema.aliases.scope, schema.GLOBAL_ALIAS_SCOPE),
        inArray(schema.aliases.rawValue, chunk),
      ));
    for (const row of aliases) adjudicated.set(normalizeAliasText(row.rawValue), row.targetId);
  }

  const resolved = new Map<string, number>();
  const ambiguous = new Map<string, number[]>();
  const reserved = new Map<string, number[]>();
  for (const original of originals) {
    const key = normalizedByOriginal.get(original)!;
    const chosen = adjudicated.get(key);
    if (chosen != null) {
      resolved.set(original, chosen);
      continue;
    }
    const inactiveIds = [...(inactiveLegacy.get(key) ?? new Set<number>())].sort((a, b) => a - b);
    if (inactiveIds.length > 0) {
      reserved.set(original, inactiveIds);
      continue;
    }
    const ids = [...(candidates.get(key) ?? new Set<number>())].sort((a, b) => a - b);
    if (ids.length === 1) resolved.set(original, ids[0]);
    else if (ids.length > 1) ambiguous.set(original, ids);
  }
  return { resolved, ambiguous, reserved };
}

/* ══ 1) releaseSpus（§4.1 派生 + 人工闸） ═══════════════ */

/** BOM 块 payload 类型守卫（skus 与 boms 两条流水线共用） */
export function isBomBlockPayload(p: unknown): p is BomBlock {
  const b = p as Partial<BomBlock>;
  return !!b && Array.isArray(b.lines) && typeof b.productName === "string";
}
