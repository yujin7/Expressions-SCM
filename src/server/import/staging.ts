/**
 * staging 层写入器（《04》§4：适配器→staging→校验→复核→审批入库；staging 先行，绝不直写正式表）。
 * 幂等：同 (template, idempotencyKey) 重导 = 作废旧 job 的 staging 行后整批重写。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { importJobs, stagingRows } from "@/db/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = any;

export interface StagingRowInput {
  rowNo: number;
  targetTable: string; // 语义目标（如 stock_opening_candidate/batch_stock/bom_block/sales_monthly）
  payload: unknown;
  status?: "pending" | "validated" | "error";
  errorMsg?: string | null;
}

export async function createImportJob(
  db: AnyDb,
  i: {
    template: string;
    filePath: string;
    createdBy: number;
    idempotencyKey?: string;
    sourceAsOf?: string | null;
    schemaVersion?: string;
    scope?: Record<string, unknown> | null;
  },
): Promise<{ id: number }> {
  const fileHash = createHash("md5").update(readFileSync(i.filePath)).digest("hex");
  const filename = i.filePath.split("/").pop() ?? i.filePath;
  const idempotencyKey = i.idempotencyKey ?? `${i.template}:${fileHash}`;
  // 红队第四轮 F1：重导幂等落地——同 idempotencyKey 的旧 job 未放行行一律作废，
  // 防止 populate/上传重跑把同一文件的行重复排队（期初翻倍事故的根因）。
  // committed 行不动（已放行历史留痕）；error 行本就不入选。
  return db.transaction(async (tx: AnyDb) => {
    const olds: { id: number }[] = await tx
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(eq(importJobs.idempotencyKey, idempotencyKey));
    const [job] = await tx
      .insert(importJobs)
      .values({
        template: i.template,
        filename,
        fileHash,
        sourceAsOf: i.sourceAsOf ?? null,
        schemaVersion: i.schemaVersion ?? `${i.template}-v1`,
        scope: i.scope ?? null,
        status: "validating",
        createdBy: i.createdBy,
        idempotencyKey,
      })
      .returning({ id: importJobs.id });
    for (const old of olds) {
      await tx
        .update(stagingRows)
        .set({ status: "error", errorMsg: `重导作废（superseded by job #${job.id}）` })
        .where(
          and(
            eq(stagingRows.importJobId, old.id),
            inArray(stagingRows.status, ["pending", "validated"]),
          ),
        );
      await tx.update(importJobs).set({ status: "superseded" }).where(eq(importJobs.id, old.id));
    }
    return job;
  });
}

export async function writeStagingRows(db: AnyDb, jobId: number, rows: StagingRowInput[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(stagingRows).values(
      rows.slice(i, i + CHUNK).map((r) => ({
        importJobId: jobId,
        rowNo: r.rowNo,
        targetTable: r.targetTable,
        payload: r.payload,
        status: r.status ?? "pending",
        errorMsg: r.errorMsg ?? null,
      })),
    );
  }
}

export async function finalizeImportJob(
  db: AnyDb,
  jobId: number,
  stats: {
    okRows: number;
    failRows: number;
    status?: "done" | "failed";
    controlRows?: number;
  },
): Promise<void> {
  await db
    .update(importJobs)
    .set({
      status: stats.status ?? "done",
      okRows: stats.okRows,
      failRows: stats.failRows,
      controlRows: stats.controlRows ?? stats.okRows + stats.failRows,
    })
    .where(eq(importJobs.id, jobId));
}

/** 解析阶段失败也必须留下可解释状态，不能永远卡在 validating。 */
export async function failImportJob(
  db: AnyDb,
  jobId: number,
  targetTable: string,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  await db.transaction(async (tx: AnyDb) => {
    const existing: { id: number; status: string }[] = await tx
      .select({ id: stagingRows.id, status: stagingRows.status })
      .from(stagingRows)
      .where(eq(stagingRows.importJobId, jobId));
    if (existing.length === 0) {
      await tx.insert(stagingRows).values({
        importJobId: jobId,
        rowNo: 0,
        targetTable,
        payload: { phase: "parse" },
        status: "error",
        errorMsg: message,
      });
    } else {
      // 部分分块已写入后失败时，必须封死这些行；release 查询按 staging status，
      // 若只把 job 标 failed 而保留 pending/validated，失败批次仍可能被误放行。
      await tx
        .update(stagingRows)
        .set({ status: "error", errorMsg: `导入失败：${message}` })
        .where(
          and(
            eq(stagingRows.importJobId, jobId),
            inArray(stagingRows.status, ["pending", "validated"]),
          ),
        );
    }
    await tx
      .update(importJobs)
      .set({
        status: "failed",
        okRows: 0,
        failRows: existing.length > 0 ? existing.length : 1,
        controlRows: existing.length,
      })
      .where(eq(importJobs.id, jobId));
  });
}

export async function getStagingRows(db: AnyDb, jobId: number, status?: string) {
  const cond = status
    ? and(eq(stagingRows.importJobId, jobId), eq(stagingRows.status, status as never))
    : eq(stagingRows.importJobId, jobId);
  return db.select().from(stagingRows).where(cond);
}
