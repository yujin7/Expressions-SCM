import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  createImportJob,
  failImportJob,
  writeStagingRows,
} from "@/server/import/staging";
import { createTestDb } from "../helpers/db";

describe("导入失败收口", () => {
  it("SQL values stay out of failed staging and downloadable rejection artifact", async () => {
    const { db, client } = await createTestDb();
    const dir = mkdtempSync(path.join(tmpdir(), "staging-privacy-"));
    const previousStorage = process.env.FILE_STORAGE_DIR;
    process.env.FILE_STORAGE_DIR = dir;
    try {
      const [user] = await db.insert(schema.users).values({ name: "QA" }).returning();
      const file = path.join(dir, "qa.xlsx");
      writeFileSync(file, "synthetic");
      const job = await createImportJob(db, { template: "inventory", filePath: file, createdBy: user.id });
      const error = new Error("Failed query: insert into private values ('SYNTH_PRIVATE_BIND')", {
        cause: Object.assign(new Error('invalid input: "SYNTH_PRIVATE_BIND"'), { code: "22P02" }),
      });
      await failImportJob(db, job.id, "stock_opening_candidate", error);
      const [saved] = await db.select().from(schema.importJobs).where(eq(schema.importJobs.id, job.id));
      const rows = await db.select().from(schema.stagingRows).where(eq(schema.stagingRows.importJobId, job.id));
      expect(saved).toMatchObject({ status: "failed", okRows: 0, failRows: 1 });
      expect(rows).toMatchObject([{ status: "error", errorMsg: expect.stringContaining("SQLSTATE 22P02") }]);
      expect(JSON.stringify(rows)).not.toContain("SYNTH_PRIVATE_BIND");
      expect(readFileSync(path.join(dir, saved.errorFile!), "utf8")).not.toContain("SYNTH_PRIVATE_BIND");
    } finally {
      if (previousStorage === undefined) delete process.env.FILE_STORAGE_DIR;
      else process.env.FILE_STORAGE_DIR = previousStorage;
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("部分 staging 已写入后失败时全部封成 error，不能被 release 误选", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(schema.users).values({ name: "导入员" }).returning();
    const dir = mkdtempSync(path.join(tmpdir(), "staging-failure-"));
    const previousStorage = process.env.FILE_STORAGE_DIR;
    process.env.FILE_STORAGE_DIR = dir;
    const file = path.join(dir, "partial.xlsx");
    writeFileSync(file, "fixture");
    const job = await createImportJob(db, { template: "inventory", filePath: file, createdBy: user.id });
    await writeStagingRows(db, job.id, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { qty: 1 }, status: "pending" },
      { rowNo: 2, targetTable: "stock_opening_candidate", payload: { qty: 2 }, status: "validated" },
      { rowNo: 3, targetTable: "stock_opening_candidate", payload: { qty: "bad" }, status: "error", errorMsg: "原拒收" },
    ]);

    await failImportJob(db, job.id, "stock_opening_candidate", new Error("第二个写入分块失败"));

    const rows = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, job.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === "error")).toBe(true);
    expect(rows.filter((row) => row.errorMsg?.includes("第二个写入分块失败"))).toHaveLength(2);
    expect(rows.find((row) => row.rowNo === 3)?.errorMsg).toBe("原拒收");

    const [savedJob] = await db
      .select()
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, job.id));
    expect(savedJob).toMatchObject({
      status: "failed",
      okRows: 0,
      failRows: 3,
      controlRows: 3,
    });
    expect(savedJob.errorFile).toMatch(/^import-errors\//);
    if (previousStorage === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previousStorage;
    rmSync(dir, { recursive: true, force: true });
  });
});
