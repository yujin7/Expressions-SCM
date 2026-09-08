import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditLogs, exportJobs, users } from "@/db/schema";
import { createExportJob, runExportWorkerOnce } from "@/jobs/export-worker";
import { EXPORT_KINDS } from "@/server/modules/report/export";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, close: () => Promise<void>, user: { id: number };
beforeEach(async () => {
  const fixture = await createTestDb(); db = fixture.db; close = () => fixture.client.close();
  [user] = await db.insert(users).values({ username: "export-finance", name: "导出财务", roles: ["finance"] }).returning();
});
afterEach(async () => { vi.restoreAllMocks(); await close(); });

it("audit failure leaves neither a queued export nor an audit; explicit retry creates one pair", async () => {
  await db.execute(sql`CREATE FUNCTION qa_export_audit_fail() RETURNS trigger AS $$ BEGIN IF NEW.entity = 'export_job' THEN RAISE EXCEPTION 'QA audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await db.execute(sql`CREATE TRIGGER qa_export_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION qa_export_audit_fail()`);
  await expect(createExportJob(user, "balance", {}, db)).rejects.toThrow();
  expect(await db.select().from(exportJobs)).toHaveLength(0);
  expect(await db.select().from(auditLogs)).toHaveLength(0);
  await db.execute(sql`DROP TRIGGER qa_export_audit_fail ON audit_logs`);
  const job = await createExportJob(user, "balance", {}, db);
  expect(await db.select().from(exportJobs)).toHaveLength(1);
  expect(await db.select().from(auditLogs)).toMatchObject([{ entity: "export_job", entityId: job.id, action: "create" }]);
});

it("direct service callers cannot queue exports for inactive or missing accounts", async () => {
  await db.update(users).set({ active: false }).where(eq(users.id, user.id));
  await expect(createExportJob(user, "balance", {}, db)).rejects.toMatchObject({ status: 403 });
  await expect(createExportJob({ id: user.id + 1000 }, "balance", {}, db)).rejects.toMatchObject({ status: 403 });
  expect(await db.select().from(exportJobs)).toHaveLength(0);
});

it("creation checks the current stored role rather than trusting the HTTP caller", async () => {
  await db.update(users).set({ roles: ["warehouse"] }).where(eq(users.id, user.id));
  await expect(createExportJob(user, "settlement-summary", {}, db)).rejects.toMatchObject({ status: 403 });
  expect(await db.select().from(exportJobs)).toHaveLength(0);
  expect(await db.select().from(auditLogs)).toHaveLength(0);
});

it("worker rechecks registered roles after revocation before invoking any producer", async () => {
  const job = await createExportJob(user, "settlement-summary", {}, db);
  await db.update(users).set({ roles: ["warehouse"] }).where(eq(users.id, user.id));
  const producer = vi.spyOn(EXPORT_KINDS["settlement-summary"], "produce").mockRejectedValue(new Error("producer must not be reached"));
  expect(await runExportWorkerOnce(db)).toMatchObject({ id: job.id, status: "failed", error: "当前角色无权导出此类数据" });
  expect(producer).not.toHaveBeenCalled();
});
