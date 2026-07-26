/**
 * 为 legacy NPD 复合导入补齐三份源文件的 hash 血缘。
 * 默认 dry-run；--apply 只更新 import_jobs 元数据，不改节点/角色事实。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, gt } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";

const FILES = [
  "各节点核心说明.xlsx",
  "各节点核心说明_数据表.xlsx",
  "各节点核心说明_数据表_常规新品开发时间节点模拟.xlsx",
];

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const apply = process.argv.includes("--apply");
  const sourceRoot = path.resolve(arg("--source-root") ?? "/Users/yj/Desktop/SCM");
  const sources = FILES.map((filename) => {
    const file = path.join(sourceRoot, filename);
    if (!existsSync(file)) throw new Error(`NPD 源文件不存在：${file}`);
    return {
      filename,
      md5: createHash("md5").update(readFileSync(file)).digest("hex"),
    };
  });

  const db = await getDbAsync();
  const jobs = await db
    .select()
    .from(schema.importJobs)
    .where(and(
      eq(schema.importJobs.template, "npd"),
      eq(schema.importJobs.status, "done"),
      gt(schema.importJobs.okRows, 0),
    ));
  if (jobs.length !== 1) throw new Error(`无法唯一确定 NPD 导入任务：命中 ${jobs.length} 个`);
  const job = jobs[0];
  const staging = await db
    .select({ status: schema.stagingRows.status, payload: schema.stagingRows.payload })
    .from(schema.stagingRows)
    .where(eq(schema.stagingRows.importJobId, job.id));
  const kinds = Object.fromEntries(
    ["npd_node", "npd_role"].map((kind) => [
      kind,
      staging.filter((row) =>
        (row.payload as { kind?: unknown }).kind === kind && row.status === "committed",
      ).length,
    ]),
  );
  if (staging.length !== job.okRows || kinds.npd_node !== 69 || kinds.npd_role !== 19) {
    throw new Error(
      `NPD staging 证据不完整：rows=${staging.length}/${job.okRows}, node=${kinds.npd_node}, role=${kinds.npd_role}`,
    );
  }

  if (apply) {
    await db
      .update(schema.importJobs)
      .set({
        schemaVersion: "npd-v2",
        scope: {
          mode: "full",
          targetKinds: ["npd_node", "npd_role"],
          sources,
          legacyReleaseEvidence: kinds,
        },
        controlRows: staging.length,
      })
      .where(eq(schema.importJobs.id, job.id));
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    target: { jobId: job.id, filename: job.filename },
    sources,
    controls: { stagingRows: staging.length, ...kinds },
    recovery: `Restore schema_version/scope/control_rows on import job #${job.id} if reversal is required; NPD facts are untouched.`,
  }, null, 2));
}

void main();
