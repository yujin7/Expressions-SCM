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
import { createExportJob, runExportWorkerOnce } from "@/jobs/export-worker";
import { listSupplierLifecycleCases } from "@/server/modules/master/supplier-lifecycle";
import { GET } from "@/app/api/export/supplier-lifecycle/route";

let db: TestDb, close: () => Promise<void>, buyer: SessionUser, supplierId: number, termId: number;
const def = EXPORT_KINDS["supplier-lifecycle"];
const request = (query = "") => GET(new NextRequest(`http://localhost/api/export/supplier-lifecycle?${query}`));
beforeAll(async () => {
  const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close(); mocks.db = db;
  const [u] = await db.insert(schema.users).values({ name: "合成采购", roles: ["purchasing"] }).returning();
  buyer = { id: u.id, name: u.name, roles: u.roles, isApprover: false };
  const [supplier] = await db.insert(schema.suppliers).values({ code: "EXPORT-TEST", name: "=UNTRUSTED()", kinds: ["raw"], status: "qualified", bankAccount: "PRIVATE_BANK", phone: "PRIVATE_PHONE", creditDays: 0 }).returning();
  supplierId = supplier.id;
  // Closed fixtures intentionally exceed both public page limits and the synchronous export gate.
  for (let start = 0; start < 5001; start += 500) {
    await db.insert(schema.supplierLifecycleCases).values(Array.from({ length: Math.min(500, 5001 - start) }, (_, offset) => ({
      supplierId, kind: "corrective", status: "closed", priority: "normal", reason: `完整依据-${String(start + offset).padStart(5, "0")}`,
      dueDate: "2099-12-31", ownerId: buyer.id, createdBy: buyer.id, supplierStatusBefore: "qualified", supplierStatusAfter: "qualified",
      outcome: "resolved", closureNote: "合成整改证据已核对", closedBy: buyer.id, closedAt: new Date("2026-09-01T01:00:00Z"),
      idempotencyKey: `export-fixture-${start + offset}`,
    })));
  }
  const [term] = await db.insert(schema.supplierLifecycleCases).values({ supplierId, kind: "payment_term", status: "closed", reason: "完整账期谈判依据", dueDate: "2099-12-31", ownerId: buyer.id, createdBy: buyer.id,
    supplierStatusBefore: "qualified", supplierStatusAfter: "qualified", outcome: "resolved", closureNote: "完整协议结果已核对", closedBy: buyer.id, closedAt: new Date("2026-09-01T01:00:00Z"), idempotencyKey: "export-term",
    targetCreditDays: 60, termBaseline: { paymentTermType: "monthly_credit", creditDays: null }, termAgreement: { creditDays: 60, effectiveFrom: "2099-12-01", paymentTerm: '完整协议,"不可截断"\n下一行', evidenceRef: "协议-QA-001" }, progressNote: "最新跟进，不冒充全部历史",
  }).returning(); termId = term.id;
});
beforeEach(() => { mocks.guard.mockResolvedValue(buyer); mocks.start.mockClear(); });
afterAll(async () => close());

it("list retains 200 limit; export filters and sorts all 5001 work items before its own cap", async () => {
  expect((await listSupplierLifecycleCases({ kind: "corrective", pageSize: 200 }, db)).rows).toHaveLength(200);
  await expect(listSupplierLifecycleCases({ pageSize: 5000 }, db)).rejects.toThrow();
  const params = def.paramsFromSearch(new URLSearchParams({ kind: "corrective", supplierId: String(supplierId), status: "closed", sort: "createdAt", order: "descend", page: "3", pageSize: "20" }));
  expect(params).not.toHaveProperty("page"); expect(params.supplierId).toBe(supplierId);
  const result = await def.produce(buyer, params, 50000, db);
  expect(result.total).toBe(5001); expect(result.rows).toHaveLength(5001);
  expect(result.rows[0].reason).toBe("完整依据-05000"); expect(result.rows.at(-1)?.reason).toBe("完整依据-00000");
  const limited = await def.produce(buyer, params, 2, db); expect(limited.rows).toEqual(result.rows.slice(0, 2)); expect(limited.total).toBe(5001);
  const exact = await def.produce(buyer, { caseId: termId }, 50000, db); expect(exact.total).toBe(1);
  expect((await def.produce(buyer, { q: "完整依据-0000", ownerId: buyer.id }, 50000, db)).total).toBe(10);
});
it("HTTP >5000 creates one audited task; real worker writes the full ordered CSV", async () => {
  const response = await request("kind=corrective&status=closed&sort=createdAt&order=descend&page=8&pageSize=20");
  expect(response.status).toBe(202); const body = await response.json(); expect(mocks.start).toHaveBeenCalledOnce();
  const dir = mkdtempSync(path.join(tmpdir(), "supplier-work-export-"));
  expect(await runExportWorkerOnce(db, dir)).toMatchObject({ id: body.jobId, status: "done", rowCount: 5001 });
  const [job] = await db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, body.jobId));
  const csv = readFileSync(job.filePath!, "utf8"); const lines = csv.trimEnd().split("\r\n");
  expect(lines).toHaveLength(5002); expect(lines[1]).toContain("完整依据-05000"); expect(lines.at(-1)).toContain("完整依据-00000");
  expect(csv).not.toMatch(/PRIVATE_BANK|PRIVATE_PHONE/);
  const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "export_job"));
  expect(audit.filter(a => a.entityId === body.jobId)).toHaveLength(1);
});
it("sync keeps full multiline terms, evidence, unknown vs zero, future date and CSV injection protection", async () => {
  const response = await request(`caseId=${termId}`); expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const csv = await response.text(); expect(csv).toContain("'=UNTRUSTED()"); expect(csv).toContain('完整协议,""不可截断""\n下一行');
  expect(csv).toContain("协议-QA-001"); expect(csv).not.toMatch(/PRIVATE_BANK|PRIVATE_PHONE/);
  const result = await def.produce(buyer, { caseId: termId }, 5000, db);
  expect(result.rows[0]).toMatchObject({ outcome: "达成协议", baselineType: "月结", baselineDays: null, currentType: "未知", currentDays: 0, agreementFrom: "2099-12-01", agreementDays: 60 });
  expect(result.columns.map(c => c.title).join(" ")).toContain("不代表已生效"); expect(mocks.start).not.toHaveBeenCalled();
});
it.each(["kind=invalid", "status=invalid", "sort=bankAccount", "order=desc", "ownerId=", "caseId=1.1", "supplierId=0", "caseId=1&caseId=2", "kind=corrective&kind=payment_term", "unexpected=1"])("rejects malformed filter without broadening: %s", async query => {
  expect((await request(query)).status).toBe(400); expect(mocks.start).not.toHaveBeenCalled();
});
it.each(["admin", "purchasing", "pmc", "finance"])("allows the same lifecycle read role %s", async role => {
  mocks.guard.mockResolvedValue({ ...buyer, roles: [role] }); expect((await request(`caseId=${termId}`)).status).toBe(200);
});
it("denies warehouse in both sync and producer, and rechecks queued user's role", async () => {
  const warehouse = { ...buyer, roles: ["warehouse"] }; mocks.guard.mockResolvedValue(warehouse);
  expect((await request()).status).toBe(403);
  await expect(def.produce(warehouse, {}, 5000, db)).rejects.toMatchObject({ status: 403 });
  const job = await createExportJob(buyer, "supplier-lifecycle", { caseId: termId }, db);
  await db.update(schema.users).set({ roles: ["warehouse"] }).where(eq(schema.users.id, buyer.id));
  try {
    expect(await runExportWorkerOnce(db, mkdtempSync(path.join(tmpdir(), "supplier-work-denied-")))).toMatchObject({ id: job.id, status: "failed" });
  } finally { await db.update(schema.users).set({ roles: ["purchasing"] }).where(eq(schema.users.id, buyer.id)); }
});
it("malformed direct task filters cannot silently turn into an unfiltered export", async () => {
  await expect(def.produce(buyer, { q: ["bad"] }, 5000, db)).rejects.toThrow();
  await expect(def.produce(buyer, { supplierId: "1" }, 5000, db)).rejects.toThrow();
});
