/**
 * 复核工作台后端（《04》§4 ③）：别名异常认领 + 导入任务总览。
 * 认领一次，永久生效（写 aliases + 关闭异常）；忽略=显式拒绝解析（歧义码等）。
 */
import { and, desc, eq, ne } from "drizzle-orm";
import { getDbAsync } from "@/db";
import {
  aliasExceptions,
  GLOBAL_ALIAS_SCOPE,
  importJobs,
  stagingRows,
  transitRefs,
} from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { createImportRejectionArtifact } from "@/server/import/rejection-artifact";
import {
  skuImportIdentityModeOf,
  type SkuImportIdentityMode,
} from "@/server/import/sku-identity-mode";
import { claimAlias } from "@/server/modules/dimension/resolver";
import { ApiError } from "@/server/modules/master/common";
import { ensureExternalSkuIdentifierInTransaction } from "@/server/modules/master/sku-identifier";
import { requireAnyRole } from "@/server/modules/outsource/common";
import type { SessionUser } from "@/server/core/dto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const resolveDb = async (db?: AnyDb): Promise<AnyDb> => db ?? (await getDbAsync());

export async function listExceptions(
  opts: { status?: string; aliasType?: string; scope?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
) {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.status) conds.push(eq(aliasExceptions.status, opts.status as never));
  if (opts.aliasType) conds.push(eq(aliasExceptions.aliasType, opts.aliasType as never));
  if (opts.scope) conds.push(eq(aliasExceptions.scope, opts.scope));
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
    const externalSkuIdentity = exc.aliasType === "sku_code" && exc.scope !== GLOBAL_ALIAS_SCOPE
      ? await ensureExternalSkuIdentifierInTransaction(tx, {
          skuId: targetId,
          value: exc.rawValue,
          scope: exc.scope,
          note: `由 ${exc.scope} 导入异常 #${exc.id} 人工认领`,
        }, user)
      : null;
    await claimAlias(tx, {
      aliasType: exc.aliasType,
      rawValue: exc.rawValue,
      targetId,
      userId: user.id,
      scope: exc.scope,
    });

    let propagatedProductRows = 0;
    let propagatedMaterialRows = 0;
    let propagatedSupplierRows = 0;
    // transit_refs 来自企业内部文件导入，没有外部系统 scope；仅 GLOBAL 裁决可传播，
    // 防止 Jiandaoyun/Yonyou 恰好同码时污染既有参考层。
    if (exc.aliasType === "sku_code" && exc.scope === GLOBAL_ALIAS_SCOPE) {
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
    } else if (exc.aliasType === "supplier_oem" && exc.scope === GLOBAL_ALIAS_SCOPE) {
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
        scope: exc.scope,
        rawValue: exc.rawValue,
        targetId,
        externalSkuIdentifierId: externalSkuIdentity?.identifier.id ?? null,
        externalSkuIdentifierCreated: externalSkuIdentity?.created ?? false,
        externalSkuIdentifierReactivated: externalSkuIdentity?.reactivated ?? false,
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
  await db.transaction(async (tx: AnyDb) => {
    // 条件 UPDATE 是状态转移的唯一竞争点：并发忽略只有一个请求能从 open 迁移。
    // 返回的旧身份字段与审计同处一个事务，任一失败都不留半步状态。
    const [exc] = await tx
      .update(aliasExceptions)
      .set({ status: "ignored", resolvedBy: user.id, resolvedAt: new Date() })
      .where(and(eq(aliasExceptions.id, id), eq(aliasExceptions.status, "open")))
      .returning({
        aliasType: aliasExceptions.aliasType,
        scope: aliasExceptions.scope,
        rawValue: aliasExceptions.rawValue,
      });
    if (!exc) {
      const [current] = await tx
        .select({ status: aliasExceptions.status })
        .from(aliasExceptions)
        .where(eq(aliasExceptions.id, id));
      if (!current) throw new ApiError(404, "异常不存在");
      throw new ApiError(409, `该异常已处理: ${current.status}`);
    }
    await writeAudit(tx, {
      userId: user.id, entity: "alias_exception", entityId: id, action: "ignore",
      after: {
        aliasType: exc.aliasType,
        scope: exc.scope,
        rawValue: exc.rawValue,
        note: note ?? null,
      },
    });
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
  const rows: Array<{
    id: number;
    template: string;
    filename: string;
    status: "pending" | "validating" | "failed" | "done" | "superseded";
    okRows: number;
    failRows: number;
    errorFile: string | null;
    createdAt: Date;
    scope: unknown;
  }> = await db
    .select({
      id: importJobs.id,
      template: importJobs.template,
      filename: importJobs.filename,
      status: importJobs.status,
      okRows: importJobs.okRows,
      failRows: importJobs.failRows,
      errorFile: importJobs.errorFile,
      createdAt: importJobs.createdAt,
      scope: importJobs.scope,
    })
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
  return {
    data: rows.map((row): {
      id: number;
      template: string;
      filename: string;
      status: typeof row.status;
      okRows: number;
      failRows: number;
      hasErrorFile: boolean;
      createdAt: Date;
      identityMode: SkuImportIdentityMode | null;
    } => ({
      id: row.id,
      template: row.template,
      filename: row.filename,
      status: row.status,
      okRows: row.okRows,
      failRows: row.failRows,
      hasErrorFile: row.errorFile !== null,
      createdAt: row.createdAt,
      identityMode: skuImportIdentityModeOf(row.scope),
    })),
    total: cnt?.total ?? 0,
  };
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
