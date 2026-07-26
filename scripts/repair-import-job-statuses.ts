/**
 * 修复历史上传留下的不真实 import_jobs 状态。
 *
 * 默认 dry-run；--apply 仅把以下任务收口为 failed：
 * - status=done 但 okRows=0（没有任何业务行，不应宣称完成）；
 * - status=validating 且超过 15 分钟（旧解析异常留下的僵尸任务）。
 *
 * 不删除 job/staging，不改任何 canonical 表；failImportJob 会保留一条解释性 error staging 行。
 */
import { and, eq, lt, or } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { failImportJob } from "../src/server/import/staging";

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const apply = process.argv.includes("--apply");
  const db = await getDbAsync();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000);
  const jobs = await db
    .select({
      id: schema.importJobs.id,
      template: schema.importJobs.template,
      filename: schema.importJobs.filename,
      status: schema.importJobs.status,
      okRows: schema.importJobs.okRows,
      createdAt: schema.importJobs.createdAt,
    })
    .from(schema.importJobs)
    .where(or(
      and(eq(schema.importJobs.status, "done"), eq(schema.importJobs.okRows, 0)),
      and(eq(schema.importJobs.status, "validating"), lt(schema.importJobs.createdAt, staleBefore)),
    ))
    .orderBy(schema.importJobs.id);

  if (apply) {
    for (const job of jobs) {
      await failImportJob(
        db,
        job.id,
        "import_job",
        job.status === "validating"
          ? new Error("历史解析任务未正常收口（超过 15 分钟）；新版导入会自动标记失败")
          : new Error("模板未产生任何业务行；新版上传契约会在创建任务前拒绝错误模板"),
      );
    }
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    target: "legacy zero-row done jobs and stale validating jobs",
    count: jobs.length,
    jobs,
    recovery:
      "No jobs or facts were deleted. Job history and error evidence remain; statuses can be inspected from the import workbench.",
  }, null, 2));
}

void main();
