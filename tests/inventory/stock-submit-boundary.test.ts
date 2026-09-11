import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { auditLogs, stockDocs, stockLedger, users } from "@/db/schema";
import * as audit from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { submitStockDoc } from "@/server/modules/inventory/stock-doc";
import { createTestDb } from "../helpers/db";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let seq = 0;
beforeAll(async () => { fixture = await createTestDb(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => fixture?.client.close());

async function actor(roles = ["warehouse"]): Promise<SessionUser> {
  const [u] = await fixture.db.insert(users).values({ name: `库存提交测试${++seq}`, roles }).returning();
  return { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
}
async function draft(maker: SessionUser, subtype: typeof stockDocs.$inferInsert.subtype = "opening") {
  const [doc] = await fixture.db.insert(stockDocs).values({ docNo: `SUBMIT-TEST-${++seq}`, subtype, createdBy: maker.id }).returning();
  return doc;
}
const read = async (id: number) => (await fixture.db.select().from(stockDocs).where(eq(stockDocs.id, id)))[0];
const audits = (id: number) => fixture.db.select().from(auditLogs).where(and(eq(auditLogs.entity, "stock_doc"), eq(auditLogs.entityId, id)));

it("audit failure rolls back status, version and timestamp; retry commits exactly once", async () => {
  const maker = await actor(), doc = await draft(maker);
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("injected stock submit audit failure"));
  await expect(submitStockDoc(maker, doc.id, doc.version, fixture.db)).rejects.toThrow("injected stock submit audit failure");
  expect(await read(doc.id)).toEqual(doc);
  expect(await audits(doc.id)).toHaveLength(0);
  const pending = await submitStockDoc(maker, doc.id, doc.version, fixture.db);
  expect(pending).toMatchObject({ status: "pending", version: doc.version + 1 });
  await expect(submitStockDoc(maker, doc.id, doc.version, fixture.db)).rejects.toMatchObject({ status: 409 });
  expect((await audits(doc.id)).map(r => r.action)).toEqual(["submit"]);
  expect(await fixture.db.select().from(stockLedger)).toHaveLength(0);
});

it.each(["disabled", "revoked-session", "removed-warehouse"])("rejects %s using previously valid identity without changes", async (reason) => {
  const maker = await actor(), doc = await draft(maker);
  await fixture.db.update(users).set(reason === "disabled" ? { active: false }
    : reason === "revoked-session" ? { sessionVersion: maker.sessionVersion! + 1 } : { roles: ["ops"] }).where(eq(users.id, maker.id));
  await expect(submitStockDoc(maker, doc.id, doc.version, fixture.db)).rejects.toMatchObject({ status: reason === "revoked-session" ? 401 : 403 });
  expect(await read(doc.id)).toEqual(doc);
  expect(await audits(doc.id)).toHaveLength(0);
});

it("a removed admin role cannot be reused to submit a colleague's document", async () => {
  const maker = await actor(), admin = await actor(["admin"]), doc = await draft(maker);
  await fixture.db.update(users).set({ roles: ["warehouse"] }).where(eq(users.id, admin.id));
  await expect(submitStockDoc(admin, doc.id, 1, fixture.db)).rejects.toMatchObject({ status: 403 });
  expect(await read(doc.id)).toEqual(doc);
});

it("current admin authority is honored while another warehouse user cannot submit", async () => {
  const maker = await actor(), colleague = await actor(), doc = await draft(maker);
  await expect(submitStockDoc(colleague, doc.id, 1, fixture.db)).rejects.toMatchObject({ status: 403 });
  await fixture.db.update(users).set({ roles: ["admin"] }).where(eq(users.id, colleague.id));
  expect(await submitStockDoc(colleague, doc.id, 1, fixture.db)).toMatchObject({ status: "pending", version: 2 });
});

it("historical draft CA cannot start an independent approval flow", async () => {
  const maker = await actor(), doc = await draft(maker, "count_adjust");
  await expect(submitStockDoc(maker, doc.id, 1, fixture.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("来源盘点") });
  expect(await read(doc.id)).toEqual(doc);
  expect(await audits(doc.id)).toHaveLength(0);
});

it.each(["opening", "issue_out", "sales_out", "transfer", "reversal"] as const)("retains normal %s submit with no inventory posting", async subtype => {
  const maker = await actor(), doc = await draft(maker, subtype);
  await expect(submitStockDoc(maker, doc.id, 99, fixture.db)).rejects.toMatchObject({ status: 409 });
  expect(await read(doc.id)).toEqual(doc);
  expect(await submitStockDoc(maker, doc.id, 1, fixture.db)).toMatchObject({ status: "pending", version: 2 });
  expect(await audits(doc.id)).toHaveLength(1);
  expect(await fixture.db.select().from(stockLedger)).toHaveLength(0);
});
