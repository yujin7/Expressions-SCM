/**
 * staging 层写入器（《04》§4：适配器→staging→校验→复核→审批入库；staging 先行，绝不直写正式表）。
 * 幂等：同 (template, idempotencyKey) 重导 = 作废旧 job 的 staging 行后整批重写。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
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
  i: { template: string; filePath: string; createdBy: number; idempotencyKey?: string },
): Promise<{ id: number }> {
  const fileHash = createHash("md5").update(readFileSync(i.filePath)).digest("hex");
  const filename = i.filePath.split("/").pop() ?? i.filePath;
  const [job] = await db
    .insert(importJobs)
    .values({
      template: i.template,
      filename,
      fileHash,
      status: "validating",
      createdBy: i.createdBy,
      idempotencyKey: i.idempotencyKey ?? `${i.template}:${fileHash}`,
    })
    .returning({ id: importJobs.id });
  return job;
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
  stats: { okRows: number; failRows: number },
): Promise<void> {
  await db
    .update(importJobs)
    .set({ status: "done", okRows: stats.okRows, failRows: stats.failRows })
    .where(eq(importJobs.id, jobId));
}

export async function getStagingRows(db: AnyDb, jobId: number, status?: string) {
  const cond = status
    ? and(eq(stagingRows.importJobId, jobId), eq(stagingRows.status, status as never))
    : eq(stagingRows.importJobId, jobId);
  return db.select().from(stagingRows).where(cond);
}
