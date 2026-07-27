/** release 流水线：snapshots（自 engine.ts 拆出，行为未变） */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { dAdd, dCmp, dQty } from "@/server/core/decimal";
import { ApiError } from "@/server/modules/master/common";

import {
  type AnyDb, type ReleaseUser, resolveDb, loadStagedRows, commitRows, aliasCache, loadSkuIdByCode,
} from "./common";
import { assertImportPreflight, type PreflightOverrides } from "./preflight";

export interface ReleaseSnapshotsResult {
  dryRun: boolean;
  jobId: number;
  bizDate: string;
  upserts: number; // (仓库,SKU) 键数
  rowsCommitted: number;
  zeroRows: number;
  sourceRows: number;
  sourceRejectedRows: number;
  controlQty: string;
  releaseDigest: string;
  blocked: { stagingRowId: number; reason: string }[];
}

const SNAPSHOT_RULES_VERSION = "snapshot-release-v2";

/**
 * 电商部库存明细（stock_opening_candidate）→ stock_snapshots 周期刷新。
 * 铁律：只吃快照仓——实时仓行阻塞（期初仅建账期执行，日常实时仓走单据过账，
 * 快照旁路会造成双套账）；SKU/仓库别名未解析→阻塞不猜；同键 upsert（重导幂等）。
 */
export async function releaseSnapshots(
  user: ReleaseUser,
  args: {
    jobIds: number[];
    bizDate: string;
    expectedDigest?: string;
    preflightOverrides?: PreflightOverrides;
    dryRun: boolean;
  },
  dbArg?: AnyDb,
): Promise<ReleaseSnapshotsResult> {
  const db = await resolveDb(dbArg);
  await assertImportPreflight(db, user, args);
  if (args.jobIds.length !== 1) {
    throw new ApiError(400, "快照刷新每次必须且只能选择一个导入任务");
  }
  const jobId = args.jobIds[0];
  const [job]: {
    id: number;
    fileHash: string | null;
    status: string;
    okRows: number;
    failRows: number;
    releasedAt: Date | null;
  }[] = await db
    .select({
      id: schema.importJobs.id,
      fileHash: schema.importJobs.fileHash,
      status: schema.importJobs.status,
      okRows: schema.importJobs.okRows,
      failRows: schema.importJobs.failRows,
      releasedAt: schema.importJobs.releasedAt,
    })
    .from(schema.importJobs)
    .where(eq(schema.importJobs.id, jobId));
  if (!job) throw new ApiError(404, "导入任务不存在");
  if (job.status !== "done") throw new ApiError(409, `导入任务状态为 ${job.status}，不能放行`);
  if (job.releasedAt != null) {
    throw new ApiError(409, "该导入任务已放行，不可重复执行；如需刷新请创建新的导入任务");
  }

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
  let zeroRows = 0;
  const agg = new Map<string, { warehouseId: number; skuId: number; qty: string; rowIds: number[] }>();

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
    if (dCmp(p.qty, 0) < 0) {
      blocked.push({ stagingRowId: r.id, reason: "数量不能为负" });
      continue;
    }
    if (dCmp(p.qty, 0) === 0) zeroRows++;
    const key = `${warehouseId}|${skuId}`;
    const e = agg.get(key) ?? { warehouseId, skuId, qty: "0.0000", rowIds: [] };
    e.qty = dAdd(e.qty, p.qty, 4);
    e.rowIds.push(r.id);
    agg.set(key, e);
  }

  const controlQty = [...agg.values()].reduce((sum, row) => dAdd(sum, row.qty, 4), "0.0000");
  const releaseDigest = createHash("sha256")
    .update(
      JSON.stringify({
        jobId,
        fileHash: job.fileHash,
        bizDate: args.bizDate,
        rulesVersion: SNAPSHOT_RULES_VERSION,
        rows: rows.map((r) => [r.id, r.rowNo, r.status, r.payload]),
      }),
    )
    .digest("hex");
  const resultBase = {
    jobId,
    bizDate: args.bizDate,
    upserts: agg.size,
    rowsCommitted: 0,
    zeroRows,
    sourceRows: job.okRows,
    sourceRejectedRows: job.failRows,
    controlQty: dQty(controlQty),
    releaseDigest,
    blocked,
  };

  if (args.dryRun) {
    return { ...resultBase, dryRun: true };
  }
  if (!args.expectedDigest || args.expectedDigest !== releaseDigest) {
    throw new ApiError(409, "预演结果已过期或未提供：请重新预演后再执行");
  }
  if (job.failRows > 0 || blocked.length > 0 || rows.length !== job.okRows) {
    throw new ApiError(
      409,
      `快照任务不完整，拒绝部分放行：源拒收 ${job.failRows}，阻塞 ${blocked.length}，待放行 ${rows.length}/${job.okRows}`,
    );
  }

  let rowsCommitted = 0;
  await db.transaction(async (tx: AnyDb) => {
    // 一次性认领放行权：并发执行只有一个事务能把 released_at 从 NULL 改为时间。
    // 失败方抛错，事务内任何快照 upsert / staging commit / 审计均不留下。
    const claimed: { id: number }[] = await tx
      .update(schema.importJobs)
      .set({ releasedAt: new Date() })
      .where(and(eq(schema.importJobs.id, jobId), isNull(schema.importJobs.releasedAt)))
      .returning({ id: schema.importJobs.id });
    if (claimed.length !== 1) {
      throw new ApiError(409, "该导入任务已放行，不可重复执行；如需刷新请创建新的导入任务");
    }

    for (const e of agg.values()) {
      const [row] = await tx
        .insert(schema.stockSnapshots)
        .values({
          warehouseId: e.warehouseId,
          skuId: e.skuId,
          importJobId: jobId,
          bizDate: args.bizDate,
          qty: e.qty,
        })
        .onConflictDoUpdate({
          target: [schema.stockSnapshots.warehouseId, schema.stockSnapshots.skuId, schema.stockSnapshots.bizDate],
          set: { qty: e.qty, importJobId: jobId },
        })
        .returning({ id: schema.stockSnapshots.id });
      await commitRows(tx, e.rowIds, row.id);
      rowsCommitted += e.rowIds.length;
    }
    await tx
      .update(schema.importJobs)
      .set({
        sourceAsOf: args.bizDate,
        scope: {
          targetTable: "stock_opening_candidate",
          mode: "full",
          warehouseIds: [...new Set([...agg.values()].map((r) => r.warehouseId))].sort((a, b) => a - b),
        },
        controlRows: rows.length,
        controlQty: dQty(controlQty),
        releaseManifest: {
          target: "stock_snapshots",
          rulesVersion: SNAPSHOT_RULES_VERSION,
          releaseDigest,
          upserts: agg.size,
          rowsCommitted,
          zeroRows,
          blocked: 0,
        },
      })
      .where(eq(schema.importJobs.id, jobId));
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_snapshot",
      action: "release",
      after: {
        jobId,
        bizDate: args.bizDate,
        releaseDigest,
        rulesVersion: SNAPSHOT_RULES_VERSION,
        upserts: agg.size,
        rowsCommitted,
        zeroRows,
        controlQty: dQty(controlQty),
        blocked: 0,
      },
    });
  });

  return { ...resultBase, dryRun: false, rowsCommitted };
}

/* ══ 7) releaseStatus（UI 汇总） ═════════════════════════ */
