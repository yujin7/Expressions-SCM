import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { approvalConfigs, approvals, auditLogs, pdDocs, pdLines, skus, spus, users, warehouses } from "@/db/schema";
import * as audit from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { approveCountTask, createCountTask, getCountTask, submitCountTask, updateCounts } from "@/server/modules/inventory/count";
import { createTestDb } from "../helpers/db";

let fixture: Awaited<ReturnType<typeof createTestDb>>, seq = 0, warehouseId: number, skuId: number;
beforeAll(async () => {
  fixture = await createTestDb(); const { db } = fixture;
  await db.insert(approvalConfigs).values({ docType: "count", approverRole: "finance" });
  const [wh] = await db.insert(warehouses).values({ code: "PD-WRITE", name: "合成盘点仓", kind: "raw" }).returning(); warehouseId = wh.id;
  const [spu] = await db.insert(spus).values({ code: "PD-WRITE", nameCn: "合成盘点品" }).returning();
  const [sku] = await db.insert(skus).values({ code: "PD-WRITE", name: "合成物料", skuType: "raw", baseUom: "kg", spuId: spu.id }).returning(); skuId = sku.id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => fixture?.client.close());
async function actor(roles = ["warehouse"], isApprover = false): Promise<SessionUser> {
  const [u] = await fixture.db.insert(users).values({ name: `PD写边界${++seq}`, roles, isApprover }).returning();
  return { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
}
async function draft(maker: SessionUser) {
  const [doc] = await fixture.db.insert(pdDocs).values({ docNo: `PD-WRITE-${++seq}`, warehouseId, mode: "partial", createdBy: maker.id }).returning();
  const [line] = await fixture.db.insert(pdLines).values({ pdId: doc.id, skuId, bookQty: "0.1", countedQty: "0.1" }).returning();
  return { doc, line };
}
const read = async (id: number) => (await fixture.db.select().from(pdDocs).where(eq(pdDocs.id, id)))[0];

it("detail action hints use the actual count approval configuration and exact maker", async () => {
  const maker = await actor(), checker = await actor(["finance"], true), { doc } = await draft(maker);
  expect((await getCountTask(doc.id, fixture.db, maker)).actions).toMatchObject({ edit: true, submit: true, approve: false });
  expect((await getCountTask(doc.id, fixture.db, checker)).actions).toMatchObject({ edit: false, submit: false, approve: false });
  await submitCountTask(maker, doc.id, 1, fixture.db);
  expect((await getCountTask(doc.id, fixture.db, checker)).actions?.approve).toBe(true);
  expect((await getCountTask(doc.id, fixture.db, maker)).actions).toMatchObject({ approve: false, reason: expect.stringContaining("分离") });
  await fixture.db.update(approvalConfigs).set({ approverRole: "pmc" }).where(eq(approvalConfigs.docType, "count"));
  try { expect((await getCountTask(doc.id, fixture.db, checker)).actions).toMatchObject({ approve: false, reason: expect.stringContaining("审批角色") }); }
  finally { await fixture.db.update(approvalConfigs).set({ approverRole: "finance" }).where(eq(approvalConfigs.docType, "count")); }
});

it("submit audit failure rolls back status/version; original version can then succeed once", async () => {
  const user = await actor(), { doc } = await draft(user);
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("injected audit failure"));
  await expect(submitCountTask(user, doc.id, doc.version, fixture.db)).rejects.toThrow("injected audit failure");
  expect(await read(doc.id)).toMatchObject({ status: "draft", version: doc.version });
  const pending = await submitCountTask(user, doc.id, doc.version, fixture.db); expect(pending.status).toBe("pending");
  await expect(submitCountTask(user, doc.id, doc.version, fixture.db)).rejects.toMatchObject({ status: 409 });
  const rows = await fixture.db.select().from(auditLogs).where(and(eq(auditLogs.entity, "pd_doc"), eq(auditLogs.entityId, doc.id)));
  expect(rows.map(r => r.action)).toEqual(["submit"]);
});
it("a disabled maker cannot submit using a formerly valid session", async () => {
  const user = await actor(), { doc } = await draft(user);
  await fixture.db.update(users).set({ active: false }).where(eq(users.id, user.id));
  await expect(submitCountTask(user, doc.id, 1, fixture.db)).rejects.toMatchObject({ status: 403 });
  expect(await read(doc.id)).toMatchObject({ status: "draft", version: 1 });
});
it("revoked session cannot save counts", async () => {
  const user = await actor(), { doc, line } = await draft(user);
  await fixture.db.update(users).set({ sessionVersion: user.sessionVersion! + 1 }).where(eq(users.id, user.id));
  await expect(updateCounts(user, doc.id, { version: 1, lines: [{ lineId: line.id, countedQty: "0.4" }] }, fixture.db)).rejects.toMatchObject({ status: 401 });
  expect((await fixture.db.select().from(pdLines).where(eq(pdLines.id, line.id)))[0].countedQty).toBe("0.1000");
});
it("a colleague's removed warehouse role cannot be reused to edit another maker's task", async () => {
  const maker = await actor(), colleague = await actor(), { doc, line } = await draft(maker);
  await fixture.db.update(users).set({ roles: ["ops"] }).where(eq(users.id, colleague.id));
  await expect(updateCounts(colleague, doc.id, { version: 1, lines: [{ lineId: line.id, countedQty: "0.4" }] }, fixture.db)).rejects.toMatchObject({ status: 403 });
});
it("create refuses disabled and non-warehouse actors before inventory selection", async () => {
  const disabled = await actor(); await fixture.db.update(users).set({ active: false }).where(eq(users.id, disabled.id));
  for (const user of [disabled, await actor(["ops"])]) {
    await expect(createCountTask(user, { warehouseId, mode: "partial" }, fixture.db)).rejects.toMatchObject({ status: 403 });
  }
});
it("revoked finance approver flag prevents approval and leaves no approval event", async () => {
  const maker = await actor(), finance = await actor(["finance"], true), { doc } = await draft(maker);
  const pending = await submitCountTask(maker, doc.id, 1, fixture.db);
  await fixture.db.update(users).set({ isApprover: false }).where(eq(users.id, finance.id));
  await expect(approveCountTask(finance, doc.id, { action: "approve", version: pending.version }, fixture.db)).rejects.toMatchObject({ status: 403 });
  expect(await read(doc.id)).toMatchObject({ status: "pending", version: pending.version });
  expect(await fixture.db.select().from(approvals).where(and(eq(approvals.docType, "count"), eq(approvals.docId, doc.id)))).toHaveLength(0);
});
it("save audit failure rolls back line quantities and version", async () => {
  const user = await actor(), { doc, line } = await draft(user);
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("injected audit failure"));
  await expect(updateCounts(user, doc.id, { version: 1, lines: [{ lineId: line.id, countedQty: "0.4" }] }, fixture.db)).rejects.toThrow("injected audit failure");
  expect((await fixture.db.select().from(pdLines).where(eq(pdLines.id, line.id)))[0].countedQty).toBe("0.1000"); expect((await read(doc.id)).version).toBe(1);
});
it("active maker retains existing edit/submit authority, but stale versions never overwrite", async () => {
  const user = await actor(), { doc, line } = await draft(user);
  await fixture.db.update(users).set({ roles: ["ops"] }).where(eq(users.id, user.id));
  const saved = await updateCounts(user, doc.id, { version: 1, lines: [{ lineId: line.id, countedQty: "0.4" }] }, fixture.db);
  await expect(updateCounts(user, doc.id, { version: 1, lines: [{ lineId: line.id, countedQty: "5" }] }, fixture.db)).rejects.toMatchObject({ status: 409 });
  await submitCountTask(user, doc.id, saved.version, fixture.db);
  await expect(updateCounts(user, doc.id, { version: saved.version, lines: [{ lineId: line.id, countedQty: "6" }] }, fixture.db)).rejects.toMatchObject({ status: 409 });
});
