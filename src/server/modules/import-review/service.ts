/**
 * 复核工作台后端（《04》§4 ③）：别名异常认领 + 导入任务总览。
 * 认领一次，永久生效（写 aliases + 关闭异常）；忽略=显式拒绝解析（歧义码等）。
 */
import { desc, eq, ne } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { aliasExceptions, importJobs, stagingRows, transitRefs } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { createImportRejectionArtifact } from "@/server/import/rejection-artifact";
import { claimAlias } from "@/server/modules/dimension/resolver";
import { ApiError } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import type { SessionUser } from "@/server/core/dto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const resolveDb = async (db?: AnyDb): Promise<AnyDb> => db ?? (await getDbAsync());

export async function listExceptions(
  opts: { status?: string; aliasType?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
) {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.status) conds.push(eq(aliasExceptions.status, opts.status as never));
  if (opts.aliasType) conds.push(eq(aliasExceptions.aliasType, opts.aliasType as never));
  const { and } = await import("drizzle-orm");
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select()
    .from(aliasExceptions)
    .where(where)
    .orderBy(aliasExceptions.aliasType, aliasExceptions.rawValue)
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  const { sql } = await import("drizzle-orm");
  const [cnt] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(aliasExceptions)
    .where(where);
  return { data: rows, total: cnt?.total ?? 0 };
}

/** 认领：为原始值指定归属 id → 写别名 + 关闭异常（审计留痕） */
export async function claimException(
  user: SessionUser,
  id: number,
  targetId: number,
  dbArg?: AnyDb,
): Promise<void> {
  const db = await resolveDb(dbArg);
  const [exc] = await db.select().from(aliasExceptions).where(eq(aliasExceptions.id, id));
  if (!exc) throw new ApiError(404, "异常不存在");
  if (exc.status !== "open") throw new ApiError(409, `该异常已处理: ${exc.status}`);
  await db.transaction(async (tx: AnyDb) => {
    await claimAlias(tx, {
      aliasType: exc.aliasType,
      rawValue: exc.rawValue,
      targetId,
      userId: user.id,
    });

    let propagatedProductRows = 0;
    let propagatedMaterialRows = 0;
    let propagatedSupplierRows = 0;
    if (exc.aliasType === "sku_code") {
      const productRows = await tx
        .update(transitRefs)
        .set({ skuId: targetId })
        .where(eq(transitRefs.skuCode, exc.rawValue))
        .returning({ id: transitRefs.id });
      const materialRows = await tx
        .update(transitRefs)
        .set({ materialSkuId: targetId })
        .where(eq(transitRefs.materialCode, exc.rawValue))
        .returning({ id: transitRefs.id });
      propagatedProductRows = productRows.length;
      propagatedMaterialRows = materialRows.length;
    } else if (exc.aliasType === "supplier_oem") {
      const supplierRows = await tx
        .update(transitRefs)
        .set({ supplierId: targetId })
        .where(eq(transitRefs.oemRaw, exc.rawValue))
        .returning({ id: transitRefs.id });
      propagatedSupplierRows = supplierRows.length;
    }

    await writeAudit(tx, {
      userId: user.id,
      entity: "alias_exception",
      entityId: id,
      action: "claim",
      after: {
        aliasType: exc.aliasType,
        rawValue: exc.rawValue,
        targetId,
        propagatedProductRows,
        propagatedMaterialRows,
        propagatedSupplierRows,
      },
    });
  });
}

/** 忽略：显式标记不解析（歧义码/垃圾值）；staging 中引用该值的行保持 pending 由导入方处置 */
export async function ignoreException(user: SessionUser, id: number, note?: string, dbArg?: AnyDb): Promise<void> {
  const db = await resolveDb(dbArg);
  const [exc] = await db.select().from(aliasExceptions).where(eq(aliasExceptions.id, id));
  if (!exc) throw new ApiError(404, "异常不存在");
  if (exc.status !== "open") throw new ApiError(409, `该异常已处理: ${exc.status}`);
  await db
    .update(aliasExceptions)
    .set({ status: "ignored", resolvedBy: user.id, resolvedAt: new Date() })
    .where(eq(aliasExceptions.id, id));
  await writeAudit(db, {
    userId: user.id, entity: "alias_exception", entityId: id, action: "ignore",
    after: { aliasType: exc.aliasType, rawValue: exc.rawValue, note: note ?? null },
  });
}

function jobVisibility(user: SessionUser) {
  if (user.roles.includes("admin")) return undefined;
  const canFinance = user.roles.includes("finance");
  const canPmc = user.roles.includes("pmc");
  if (canFinance && canPmc) return undefined;
  if (canFinance) return eq(importJobs.template, "sku_cost");
  if (canPmc) return ne(importJobs.template, "sku_cost");
  requireAnyRole(user, "finance", "pmc");
  return undefined;
}

function assertJobRole(user: SessionUser, template: string): void {
  requireAnyRole(user, template === "sku_cost" ? "finance" : "pmc");
}

export async function getAuthorizedImportJob(
  user: SessionUser,
  jobId: number,
  dbArg?: AnyDb,
) {
  const db = await resolveDb(dbArg);
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, jobId));
  if (!job) throw new ApiError(404, "导入任务不存在");
  assertJobRole(user, job.template);
  return job;
}

export async function listImportJobs(
  user: SessionUser,
  page: number,
  pageSize: number,
  dbArg?: AnyDb,
) {
  const db = await resolveDb(dbArg);
  const where = jobVisibility(user);
  const rows = await db
    .select()
    .from(importJobs)
    .where(where)
    .orderBy(desc(importJobs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const { sql } = await import("drizzle-orm");
  const [cnt] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(importJobs)
    .where(where);
  return { data: rows, total: cnt?.total ?? 0 };
}

export async function getJobStagingSummary(
  user: SessionUser,
  jobId: number,
  dbArg?: AnyDb,
) {
  const db = await resolveDb(dbArg);
  await getAuthorizedImportJob(user, jobId, db);
  const { sql } = await import("drizzle-orm");
  return db
    .select({
      targetTable: stagingRows.targetTable,
      status: stagingRows.status,
      count: sql<number>`count(*)::int`,
    })
    .from(stagingRows)
    .where(eq(stagingRows.importJobId, jobId))
    .groupBy(stagingRows.targetTable, stagingRows.status);
}

/** 为历史任务显式补生成拒收明细；新任务由 staging finalize 自动生成。 */
export async function generateJobErrorFile(
  user: SessionUser,
  jobId: number,
  dbArg?: AnyDb,
): Promise<string> {
  const db = await resolveDb(dbArg);
  const job = await getAuthorizedImportJob(user, jobId, db);
  const errorFile = await createImportRejectionArtifact(db, jobId);
  if (!errorFile) throw new ApiError(409, "该任务没有可导出的拒收行");
  await db.transaction(async (tx: AnyDb) => {
    await tx.update(importJobs).set({ errorFile }).where(eq(importJobs.id, jobId));
    await writeAudit(tx, {
      userId: user.id,
      entity: "import_job",
      entityId: jobId,
      action: "generate_rejection_artifact",
      before: { errorFile: job.errorFile },
      after: { errorFile, failRows: job.failRows },
    });
  });
  return errorFile;
}
