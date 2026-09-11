import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import type { SessionUser } from "@/server/core/dto";

const mocks = vi.hoisted(() => ({ db: null as unknown, guard: vi.fn(), start: vi.fn() }));
vi.mock("@/db", async original => ({ ...await original<typeof import("@/db")>(), getDbAsync: async () => mocks.db }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: () => mocks.guard() }));
vi.mock("@/jobs/export-worker", async original => ({ ...await original<typeof import("@/jobs/export-worker")>(), ensureExportWorkerStarted: () => mocks.start() }));
import { EXPORT_KINDS } from "@/server/modules/report/export";
import { runExportWorkerOnce } from "@/jobs/export-worker";
import { loadPromiseReliability } from "@/server/modules/report/supply-commitment";
import { ApiError } from "@/server/modules/master/common";
import { GET } from "@/app/api/export/supply-commitment/route";

let db: TestDb, close: () => Promise<void>, user: SessionUser, poId: number;
const def = EXPORT_KINDS["supply-commitment"];
const params = { asOf: "2026-08-10", windowDays: 30 };
const request = (query = "asOf=2026-08-10&windowDays=30") => GET(new NextRequest(`http://localhost/api/export/supply-commitment?${query}`));
beforeAll(async () => {
  const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close(); mocks.db = db;
  const [actor] = await db.insert(schema.users).values({ username: "qa-promise-export", name: "仓管", roles: ["warehouse"], passwordHash: "synthetic" }).returning();
  user = { id: actor.id, roles: actor.roles, name: actor.name, isApprover: actor.isApprover };
  const [supplier] = await db.insert(schema.suppliers).values({ code: "QA-EXPORT", name: "=UNTRUSTED()", bankAccount: "PRIVATE_BANK" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "QA-EXPORT", nameCn: "导出" }).returning();
  const [sku] = await db.insert(schema.skus).values({ spuId: spu.id, code: "QA-EXPORT", skuType: "raw", baseUom: "kg" }).returning();
  const [po] = await db.insert(schema.poDocs).values({ docNo: "PO-EXPORT", supplierId: supplier.id, status: "approved", expectedDate: "2026-08-05", createdBy: actor.id }).returning(); poId = po.id;
  for (let start = 0; start < 5001; start += 250) {
    await db.insert(schema.poLines).values(Array.from({ length: Math.min(250, 5001 - start) }, () => ({
      poId, skuId: sku.id, lineType: "raw" as const, purchaseUom: "kg", uomFactor: "1", qty: "1", price: "99", receivedQty: "0",
    })));
  }
});
beforeEach(() => { mocks.guard.mockResolvedValue(user); mocks.start.mockClear(); });
afterAll(async () => close());

it("30行预览与5001行完整导出使用同一源总数，不受旧200上限影响", async () => {
  const preview = await loadPromiseReliability(params, db);
  expect(preview.exceptions).toHaveLength(30); expect(preview.exceptionTotal).toBe(5001);
  const result = await def.produce(user, params, 50000, db);
  expect(result.total).toBe(5001); expect(result.rows).toHaveLength(5001);
  const key = result.columns.find(c => c.title === "采购行ID")!.key;
  expect(new Set(result.rows.map(r => r[key])).size).toBe(5001);
  const capped = await def.produce(user, params, 17, db);
  expect(capped.total).toBe(5001); expect(capped.rows).toEqual(result.rows.slice(0, 17).map(r => ({ ...r,
    [result.columns.find(c => c.title === "本文件例外数")!.key]: 17,
  })));
});
it("HTTP转异步产生一次审计，真实worker导出全部5001行与来源链接", async () => {
  const response = await request(); expect(response.status).toBe(202);
  const { jobId } = await response.json(); expect(mocks.start).toHaveBeenCalledOnce();
  const dir = mkdtempSync(path.join(tmpdir(), "promise-full-export-"));
  expect(await runExportWorkerOnce(db, dir)).toMatchObject({ id: jobId, status: "done", rowCount: 5001 });
  const [job] = await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, jobId));
  const csv = readFileSync(job.filePath!, "utf8");
  expect(csv.trimEnd().split("\r\n")).toHaveLength(5002);
  expect(csv).toContain(`/outsource/po?docId=${poId}&poLineId=`);
  expect(csv).toContain("'=UNTRUSTED()"); expect(csv).not.toContain("PRIVATE_BANK");
  expect((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "export_job"))).filter(a => a.entityId === jobId)).toHaveLength(1);
});
it("空窗口同步导出是明确说明行，不是零值异常", async () => {
  const response = await request("asOf=2026-06-10&windowDays=30"); expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.text()).toContain("说明行，非采购例外"); expect(mocks.start).not.toHaveBeenCalled();
});
it.each(["", "asOf=2026-02-30&windowDays=30", "asOf=0000-01-01&windowDays=30", "asOf=2026-08-10&windowDays=29", "asOf=2026-08-10&windowDays=30.5", "asOf=2026-08-10&windowDays=30&windowDays=90", "asOf=2026-08-10&windowDays=30&limit=1"])("坏参数拒绝，不扩大范围: %s", async query => {
  expect((await request(query)).status).toBe(400); expect(mocks.start).not.toHaveBeenCalled();
});
it("匿名请求拒绝；直接任务参数也不能绕过验证", async () => {
  mocks.guard.mockRejectedValue(new ApiError(401, "未登录")); expect((await request()).status).toBe(401);
  await expect(def.produce(user, { ...params, extra: "x" }, 50000, db)).rejects.toThrow();
});
