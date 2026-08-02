import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  resolveImportRejectionArtifact,
} from "@/server/import/rejection-artifact";
import {
  createImportJob,
  finalizeImportJob,
  writeStagingRows,
} from "@/server/import/staging";
import {
  generateJobErrorFile,
  getJobStagingSummary,
  listImportJobs,
} from "@/server/modules/import-review/service";
import { createTestDb } from "../helpers/db";

const admin = (id: number) => ({
  id,
  name: "管理员",
  roles: ["admin"],
  isApprover: false,
});
const finance = (id: number) => ({
  id,
  name: "财务",
  roles: ["finance"],
  isApprover: false,
});
const pmc = (id: number) => ({
  id,
  name: "PMC",
  roles: ["pmc"],
  isApprover: false,
});

describe("导入拒收明细：生成、隔离与下载路径", () => {
  let storage: string;
  const previousStorage = process.env.FILE_STORAGE_DIR;

  beforeEach(() => {
    storage = mkdtempSync(path.join(tmpdir(), "import-rejections-"));
    process.env.FILE_STORAGE_DIR = storage;
  });

  afterEach(() => {
    if (previousStorage === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previousStorage;
    rmSync(storage, { recursive: true, force: true });
  });

  it("finalize 自动生成仅含 error 行的 Excel 安全 UTF-8 CSV", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(schema.users).values({ name: "导入员" }).returning();
    const file = path.join(storage, "=恶意源文件.csv");
    writeFileSync(file, "fixture");
    const job = await createImportJob(db, {
      template: "inventory",
      filePath: file,
      createdBy: user.id,
    });
    await writeStagingRows(db, job.id, [
      {
        rowNo: 3,
        targetTable: "stock_opening_candidate",
        payload: { sku: "A-3", qty: "bad" },
        status: "error",
        errorMsg: "=HYPERLINK(\"https://example.invalid\")",
      },
      {
        rowNo: 2,
        targetTable: "stock_opening_candidate",
        payload: { sku: "A-2", qty: "1" },
        status: "validated",
      },
    ]);

    await finalizeImportJob(db, job.id, { okRows: 1, failRows: 1 });

    const [saved] = await db
      .select()
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, job.id));
    expect(saved.errorFile).toMatch(/^import-errors\/job-\d+-[0-9a-f-]+\.csv$/);
    const artifact = path.join(storage, saved.errorFile!);
    const csv = readFileSync(artifact, "utf8");
    expect(csv.startsWith("\uFEFF任务ID,源文件,模板")).toBe(true);
    expect(csv).toContain("'=恶意源文件.csv");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"A-3"');
    expect(csv).not.toContain('"A-2"');
    expect((csv.match(/\r\n/g) ?? [])).toHaveLength(2);
  });

  it("无拒收行不生成空文件", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(schema.users).values({ name: "导入员" }).returning();
    const file = path.join(storage, "ok.csv");
    writeFileSync(file, "fixture");
    const job = await createImportJob(db, {
      template: "inventory",
      filePath: file,
      createdBy: user.id,
    });
    await writeStagingRows(db, job.id, [
      { rowNo: 1, targetTable: "stock_opening_candidate", payload: { qty: "1" } },
    ]);

    await finalizeImportJob(db, job.id, { okRows: 1, failRows: 0 });

    const [saved] = await db
      .select()
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, job.id));
    expect(saved.errorFile).toBeNull();
  });

  it("历史失败任务可显式补生成，并留下审计证据", async () => {
    const { db } = await createTestDb();
    const [user] = await db
      .insert(schema.users)
      .values({ name: "PMC", roles: ["pmc"] })
      .returning();
    const file = path.join(storage, "legacy.csv");
    writeFileSync(file, "fixture");
    const job = await createImportJob(db, {
      template: "inventory",
      filePath: file,
      createdBy: user.id,
    });
    await writeStagingRows(db, job.id, [
      {
        rowNo: 8,
        targetTable: "batch_stock",
        payload: { sku: "X" },
        status: "error",
        errorMsg: "缺少批号",
      },
    ]);
    await db
      .update(schema.importJobs)
      .set({ status: "done", failRows: 1 })
      .where(eq(schema.importJobs.id, job.id));

    const relative = await generateJobErrorFile(pmc(user.id), job.id, db);

    expect(relative).toMatch(/^import-errors\//);
    const [audit] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, job.id));
    expect(audit).toMatchObject({
      entity: "import_job",
      action: "generate_rejection_artifact",
      userId: user.id,
    });
  });

  it("finance 与 PMC 只看到各自模板，且不能越权展开任务", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(schema.users).values({ name: "管理员" }).returning();
    for (const template of ["sku_cost", "inventory"]) {
      const file = path.join(storage, `${template}.csv`);
      writeFileSync(file, template);
      await createImportJob(db, { template, filePath: file, createdBy: user.id });
    }

    const financeRows = await listImportJobs(finance(user.id), 1, 20, db);
    const pmcRows = await listImportJobs(pmc(user.id), 1, 20, db);
    const adminRows = await listImportJobs(admin(user.id), 1, 20, db);
    expect(financeRows.data.map((row: { template: string }) => row.template)).toEqual(["sku_cost"]);
    expect(pmcRows.data.map((row: { template: string }) => row.template)).toEqual(["inventory"]);
    expect(adminRows.total).toBe(2);

    const cost = financeRows.data[0];
    await expect(getJobStagingSummary(pmc(user.id), cost.id, db)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("拒绝绝对路径、目录穿越和符号链接逃逸", async () => {
    const outside = path.join(storage, "..", `outside-${Date.now()}.csv`);
    writeFileSync(outside, "secret");
    const errorDir = path.join(storage, "import-errors");
    const link = path.join(errorDir, "escape.csv");
    try {
      await expect(resolveImportRejectionArtifact(outside)).rejects.toMatchObject({ status: 404 });
      await expect(resolveImportRejectionArtifact("../outside.csv")).rejects.toMatchObject({ status: 404 });
      mkdirSync(errorDir, { recursive: true });
      symlinkSync(outside, link);
      await expect(resolveImportRejectionArtifact("import-errors/escape.csv")).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("任务列表只返回最小 DTO，不泄露证据路径、hash 或原始 scope", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(schema.users).values({ name: "管理员" }).returning();
    const file = path.join(storage, "bom-minimal-dto.csv");
    writeFileSync(file, "fixture");
    const job = await createImportJob(db, {
      template: "bom",
      filePath: file,
      createdBy: user.id,
      scope: {
        identityMode: "new_master",
        evidencePath: "/protected/never-return.json",
        secretMarker: "NEVER_RETURN_SCOPE_VALUE",
      },
    });
    await db.update(schema.importJobs).set({
      status: "done",
      failRows: 1,
      errorFile: "import-errors/protected-path.csv",
      releaseManifest: { secretMarker: "NEVER_RETURN_MANIFEST_VALUE" },
    }).where(eq(schema.importJobs.id, job.id));

    const result = await listImportJobs(admin(user.id), 1, 20, db);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: job.id,
      template: "bom",
      identityMode: "new_master",
      hasErrorFile: true,
    });
    expect(Object.keys(result.data[0]).sort()).toEqual([
      "createdAt",
      "failRows",
      "filename",
      "hasErrorFile",
      "id",
      "identityMode",
      "okRows",
      "status",
      "template",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("protected-path");
    expect(serialized).not.toContain("NEVER_RETURN");
    expect(serialized).not.toContain("fileHash");
    expect(serialized).not.toContain("releaseManifest");
  });

  it("固定 import-errors 目录本身也不能是指向存储根外的符号链接", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "import-errors-outside-"));
    const outsideFile = path.join(outsideDir, "secret.csv");
    writeFileSync(outsideFile, "secret");
    symlinkSync(outsideDir, path.join(storage, "import-errors"));
    try {
      await expect(resolveImportRejectionArtifact("import-errors/secret.csv")).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
