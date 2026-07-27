import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { importJobs, stagingRows } from "@/db/schema";
import { storageDir, storageRoot } from "@/server/core/storage";
import { ApiError } from "@/server/modules/master/common";
import { toCsv } from "@/server/modules/report/export";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- shared by PGlite, node-postgres and transactions
type AnyDb = any;

const ERROR_DIR = "import-errors";

/**
 * CSV may be opened directly in Excel. Prefix formula-looking user input so a
 * rejected source cell cannot become an executable spreadsheet formula.
 */
function spreadsheetSafe(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function payloadText(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return "[无法序列化的原始载荷]";
  }
}

/**
 * Build the rejection artifact before the job is finalized. The stored path is
 * always relative to FILE_STORAGE_DIR and never contains source-controlled text.
 */
export async function createImportRejectionArtifact(
  db: AnyDb,
  jobId: number,
): Promise<string | null> {
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, jobId));
  if (!job) throw new ApiError(404, "导入任务不存在");

  const rejected = await db
    .select()
    .from(stagingRows)
    .where(
      and(
        eq(stagingRows.importJobId, jobId),
        eq(stagingRows.status, "error"),
      ),
    )
    .orderBy(asc(stagingRows.rowNo), asc(stagingRows.id));
  if (rejected.length === 0) return null;

  const csv = toCsv(
    rejected.map((row: {
      rowNo: number;
      targetTable: string | null;
      status: string;
      errorMsg: string | null;
      payload: unknown;
    }) => ({
      jobId,
      filename: spreadsheetSafe(job.filename),
      template: spreadsheetSafe(job.template),
      rowNo: row.rowNo,
      targetTable: spreadsheetSafe(row.targetTable),
      status: row.status,
      errorMsg: spreadsheetSafe(row.errorMsg),
      payload: spreadsheetSafe(payloadText(row.payload)),
    })),
    [
      { key: "jobId", title: "任务ID" },
      { key: "filename", title: "源文件" },
      { key: "template", title: "模板" },
      { key: "rowNo", title: "原始行号" },
      { key: "targetTable", title: "数据集" },
      { key: "status", title: "状态" },
      { key: "errorMsg", title: "拒收原因" },
      { key: "payload", title: "原始载荷(JSON)" },
    ],
  );

  const dir = storageDir(ERROR_DIR);
  await mkdir(dir, { recursive: true });
  await assertRealImportErrorDir();
  const token = randomUUID();
  const filename = `job-${jobId}-${token}.csv`;
  const finalPath = path.join(dir, filename);
  const temporaryPath = path.join(dir, `.${filename}.tmp`);
  try {
    await writeFile(temporaryPath, csv, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return path.relative(storageRoot(), finalPath).split(path.sep).join("/");
}

function isInside(base: string, candidate: string): boolean {
  return candidate.startsWith(`${base}${path.sep}`);
}

async function assertRealImportErrorDir(): Promise<{ realRoot: string; realBase: string }> {
  const [realRoot, realBase] = await Promise.all([
    realpath(path.resolve(storageRoot())),
    realpath(path.resolve(storageDir(ERROR_DIR))),
  ]);
  if (!isInside(realRoot, realBase)) {
    throw new ApiError(404, "拒收明细文件不存在");
  }
  return { realRoot, realBase };
}

/**
 * Resolve an artifact stored in the database without trusting that database
 * value. The fixed subtree check blocks absolute paths and ../ traversal; the
 * realpath check also blocks symlink escapes from the mounted storage volume.
 */
export async function resolveImportRejectionArtifact(relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new ApiError(404, "拒收明细文件不存在");
  }
  const root = path.resolve(storageRoot());
  const base = path.resolve(storageDir(ERROR_DIR));
  const candidate = path.resolve(root, relativePath);
  if (!isInside(base, candidate)) {
    throw new ApiError(404, "拒收明细文件不存在");
  }
  try {
    const { realBase } = await assertRealImportErrorDir();
    const realCandidate = await realpath(candidate);
    if (!isInside(realBase, realCandidate)) {
      throw new ApiError(404, "拒收明细文件不存在");
    }
    return realCandidate;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(404, "拒收明细文件不存在");
  }
}
