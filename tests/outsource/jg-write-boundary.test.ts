import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { submitJg, confirmJg, approveJg, withdrawJG, getJg, jgTaskActions } from "@/server/modules/outsource/jg";
import { createTestDb } from "../helpers/db";
let f: Awaited<ReturnType<typeof createTestDb>>, skuId: number, supplierId: number, woId: number, otherMakerId: number, seq = 0;
beforeAll(async () => {
  f = await createTestDb();
  const [spu] = await f.db.insert(s.spus).values({ code: "JGW", nameCn: "JG写入测试" }).returning();
  const [sku] = await f.db.insert(s.skus).values({ code: "JGW", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning(); skuId = sku.id;
  const [supplier] = await f.db.insert(s.suppliers).values({ code: "JGW", name: "加工厂" }).returning(); supplierId = supplier.id;
  const [bom] = await f.db.insert(s.boms).values({ productSkuId: skuId, versionNo: "1" }).returning();
  const [maker] = await f.db.insert(s.users).values({ name: "JGW maker", roles: ["pmc"] }).returning();
  otherMakerId = maker.id;
  const [wo] = await f.db.insert(s.woDocs).values({ docNo: "JGW-WO", createdBy: maker.id, productSkuId: skuId, supplierId, bomId: bom.id, qty: "10", feeRatePlan: "1" }).returning(); woId = wo.id;
});
afterAll(async () => f?.client.close());
afterEach(() => vi.restoreAllMocks());
async function setup(kind: "submit" | "confirm") {
  const [u] = await f.db.insert(s.users).values({ name: `JGW-${++seq}`, roles: ["pmc"] }).returning();
  const user = { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
  const [doc] = await f.db.insert(s.jgDocs).values({ docNo: `JGW-${seq}`, woId, batchSeq: seq, productSkuId: skuId, supplierId,
    qty: "10.125", feeRateCurrent: "1", status: kind === "submit" ? "draft" : "approved", createdBy: u.id }).returning();
  return { user, doc };
}
const snap = async (id: number) => ({ doc: (await f.db.select().from(s.jgDocs).where(eq(s.jgDocs.id, id)))[0],
  audit: await f.db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "jg"), eq(s.auditLogs.entityId, id))) });
for (const kind of ["submit", "confirm"] as const) {
  const run = (a: Awaited<ReturnType<typeof setup>>) => kind === "submit" ? submitJg(a.user, a.doc.id, a.doc.version, f.db)
    : confirmJg(a.user, a.doc.id, { version: a.doc.version, note: "工厂回复代录" }, f.db);
  it(`${kind}: audit failure rolls back all document fields; retry commits once`, async () => {
    const a = await setup(kind), before = await snap(a.doc.id);
    vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("JG audit failed"));
    await expect(run(a)).rejects.toThrow("JG audit failed"); expect(await snap(a.doc.id)).toEqual(before);
    const after = await run(a);
    expect(after).toMatchObject({ status: kind === "submit" ? "pending" : "in_progress", version: a.doc.version + 1, qty: "10.1250" });
    if (kind === "confirm") expect(after).toMatchObject({ confirmedBy: a.user.id, inProduction: true, confirmNote: "工厂回复代录" });
    await expect(run(a)).rejects.toMatchObject({ status: 409 });
    expect((await snap(a.doc.id)).audit.map(r => r.action)).toEqual([kind]);
    expect(await f.db.select().from(s.stockLedger)).toHaveLength(0);
  });
  it.each(["disabled", "session", "role"])(`${kind}: stale %s cannot authorize a write`, async reason => {
    const a = await setup(kind);
    // Non-maker exercises PMC authority; being a creator remains a valid submit privilege.
    if (reason === "role") await f.db.update(s.jgDocs).set({ createdBy: otherMakerId }).where(eq(s.jgDocs.id, a.doc.id));
    const before = await snap(a.doc.id);
    await f.db.update(s.users).set(reason === "disabled" ? { active: false } : reason === "session"
      ? { sessionVersion: a.user.sessionVersion + 1 } : { roles: ["ops"] }).where(eq(s.users.id, a.user.id));
    await expect(run(a)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
    expect(await snap(a.doc.id)).toEqual(before);
  });
  it.each(["closed", "completed", "void"] as const)(`${kind}: refuses %s without audit or mutation`, async status => {
    const a = await setup(kind); await f.db.update(s.jgDocs).set({ status }).where(eq(s.jgDocs.id, a.doc.id));
    const before = await snap(a.doc.id); await expect(run(a)).rejects.toMatchObject({ status: 409 });
    expect(await snap(a.doc.id)).toEqual(before);
  });
}
it("submit preserves active maker privilege but does not let an unrelated ops account submit", async () => {
  const a = await setup("submit"); await f.db.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, a.user.id));
  expect(await submitJg(a.user, a.doc.id, 1, f.db)).toMatchObject({ status: "pending" });
  const b = await setup("submit"); await expect(submitJg(a.user, b.doc.id, 1, f.db)).rejects.toMatchObject({ status: 403 });
});
for (const kind of ["approve", "withdraw"] as const) {
  it.each(["disabled", "session", "role"])(`${kind}: rejects stale %s identity inside transaction`, async reason => {
    const a = await setup("submit");
    await f.db.insert(s.approvalConfigs).values({ docType: "jg", approverRole: "pmc" }).onConflictDoNothing();
    await f.db.update(s.jgDocs).set({ status: "pending", createdBy: otherMakerId }).where(eq(s.jgDocs.id, a.doc.id));
    const before = await snap(a.doc.id);
    a.user.roles = ["admin"]; a.user.isApprover = true;
    await f.db.update(s.users).set(reason === "disabled" ? { active: false, roles: ["admin"] }
      : reason === "session" ? { sessionVersion: a.user.sessionVersion + 1, roles: ["admin"] } : { roles: ["ops"] }).where(eq(s.users.id, a.user.id));
    const run = kind === "approve" ? approveJg(a.user, a.doc.id, { version: 1, action: "approve" }, f.db)
      : withdrawJG(a.user, a.doc.id, { version: 1 }, f.db);
    await expect(run).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
    expect(await snap(a.doc.id)).toEqual(before);
  });
}
it("action hints follow maker-checker, current config and terminal read-only rules", async () => {
  const a = await setup("submit");
  expect((await getJg(a.doc.id, f.db, a.user)).actions).toMatchObject({ submit: true, confirm: false, approve: false, plan: true });
  const pending = { status: "pending", createdBy: a.user.id };
  expect(jgTaskActions({ ...a.user, roles: ["admin"] }, pending, "pmc")).toMatchObject({ approve: false, withdraw: true });
  expect(jgTaskActions({ ...a.user, id: otherMakerId, isApprover: true }, pending, "pmc")).toMatchObject({ approve: true, withdraw: false });
  expect(jgTaskActions({ ...a.user, id: otherMakerId, isApprover: true }, pending, "finance")).toMatchObject({ approve: false });
  expect(jgTaskActions({ ...a.user, id: otherMakerId, roles: ["admin"] }, pending, null)).toMatchObject({ approve: false });
  for (const status of ["closed", "completed", "void", "unknown"]) {
    expect(jgTaskActions({ ...a.user, roles: ["admin"] }, { ...pending, status }, "pmc"))
      .toMatchObject({ submit: false, approve: false, withdraw: false, confirm: false, plan: false, revise: false });
  }
});
