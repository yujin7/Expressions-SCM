import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { updateJgPlan, reviseJgDueDate } from "@/server/modules/outsource/jg";
import { createTestDb } from "../helpers/db";
let f: Awaited<ReturnType<typeof createTestDb>>, skuId: number, supplierId: number, woId: number, seq = 0;
beforeAll(async () => {
  f = await createTestDb();
  const [spu] = await f.db.insert(s.spus).values({ code: "JGQA", nameCn: "JG测试" }).returning();
  const [sku] = await f.db.insert(s.skus).values({ code: "JGQA", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning(); skuId = sku.id;
  const [supplier] = await f.db.insert(s.suppliers).values({ code: "JGQA", name: "加工厂" }).returning(); supplierId = supplier.id;
  const [bom] = await f.db.insert(s.boms).values({ productSkuId: skuId, versionNo: "1" }).returning();
  const [maker] = await f.db.insert(s.users).values({ name: "JGQA maker", roles: ["pmc"] }).returning();
  const [wo] = await f.db.insert(s.woDocs).values({ docNo: "JGQA-WO", createdBy: maker.id, productSkuId: skuId, supplierId, bomId: bom.id, qty: "10", feeRatePlan: "1" }).returning(); woId = wo.id;
});
afterAll(async () => f?.client.close());
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const [u] = await f.db.insert(s.users).values({ name: `PMC-${++seq}`, roles: ["pmc"] }).returning();
  const user = { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
  const [doc] = await f.db.insert(s.jgDocs).values({ docNo: `JGQA-${seq}`, woId, batchSeq: seq, productSkuId: skuId, supplierId,
    qty: "10", feeRateCurrent: "1", status: "approved", dueDate: "2026-09-20", pkgReadyDate: "2026-09-19", createdBy: u.id }).returning();
  return { user, doc };
}
const snap = async (id: number) => ({ doc: (await f.db.select().from(s.jgDocs).where(eq(s.jgDocs.id, id)))[0], audit: await f.db.select().from(s.auditLogs) });
for (const kind of ["plan", "due"] as const) {
  const run = (a: Awaited<ReturnType<typeof setup>>) => kind === "plan" ? updateJgPlan(a.user, a.doc.id, { urgentFlag: true }, f.db)
    : reviseJgDueDate(a.user, a.doc.id, { newDate: "2026-09-22", reason: "加工调整" }, f.db);
  it(`${kind} rolls back on audit failure and retries exactly once`, async () => {
    const a = await setup(), before = await snap(a.doc.id);
    vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("audit unavailable"));
    await expect(run(a)).rejects.toThrow("audit unavailable"); expect(await snap(a.doc.id)).toEqual(before);
    await run(a); expect((await snap(a.doc.id)).audit.length).toBe(before.audit.length + 1);
  });
  it.each(["disabled", "role", "session"])(`${kind} denies stale %s authority before mutation`, async reason => {
    const a = await setup(), before = await snap(a.doc.id);
    await f.db.update(s.users).set(reason === "disabled" ? { active: false } : reason === "role"
      ? { roles: ["ops"] } : { sessionVersion: a.user.sessionVersion + 1 }).where(eq(s.users.id, a.user.id));
    await expect(run(a)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
    expect(await snap(a.doc.id)).toEqual(before);
  });
}
it("explicit null/empty clear packaging dates; absent fields preserve the other facts", async () => {
  const a = await setup();
  await updateJgPlan(a.user, a.doc.id, { pkgReadyDate: null }, f.db);
  expect((await snap(a.doc.id)).doc.pkgReadyDate).toBeNull();
  await updateJgPlan(a.user, a.doc.id, { pkgRequiredDate: "2024-02-29", pkgSupplierReplyDate: "2026-09-18" }, f.db);
  await updateJgPlan(a.user, a.doc.id, { pkgRequiredDate: "" }, f.db);
  expect((await snap(a.doc.id)).doc).toMatchObject({ pkgRequiredDate: null, pkgSupplierReplyDate: "2026-09-18", dueDate: "2026-09-20" });
});
it("revisions retain an ordered history with the previous authoritative due date", async () => {
  const a = await setup();
  await reviseJgDueDate(a.user, a.doc.id, { newDate: "2026-09-22", reason: "首次" }, f.db);
  await reviseJgDueDate(a.user, a.doc.id, { newDate: "2026-09-24", reason: "再次" }, f.db);
  expect((await snap(a.doc.id)).doc.revisedDates).toMatchObject([
    { from: "2026-09-20", to: "2026-09-22" }, { from: "2026-09-22", to: "2026-09-24" },
  ]);
});
