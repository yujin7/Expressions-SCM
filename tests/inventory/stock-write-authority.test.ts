import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { approvalConfigs, approvals, auditLogs, skus, spus, stockDocLines, stockDocs, stockLedger, users, warehouses } from "@/db/schema";
import * as audit from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { approveStockDoc, createStockDoc, getStockDoc, reverseStockDoc, shortCloseStockDoc,
  stockDocActions, voidStockDoc, withdrawStockDoc } from "@/server/modules/inventory/stock-doc";
import { createTestDb } from "../helpers/db";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let seq = 0, skuId: number, warehouseId: number;
beforeAll(async () => {
  fixture = await createTestDb();
  const [spu] = await fixture.db.insert(spus).values({ code: "AUTH-SPU", nameCn: "权限测试" }).returning();
  const [sku] = await fixture.db.insert(skus).values({ code: "AUTH-TEST", name: "权限测试", spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning(); skuId = sku.id;
  const [wh] = await fixture.db.insert(warehouses).values({ code: "AUTH-WH", name: "测试仓", kind: "raw", accountingMode: "realtime" }).returning(); warehouseId = wh.id;
  await fixture.db.insert(approvalConfigs).values({ docType: "opening", approverRole: "finance" });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => fixture?.client.close());
async function actor(roles = ["warehouse"], isApprover = true): Promise<SessionUser> {
  const [u] = await fixture.db.insert(users).values({ name: `WRITE-AUTH-${++seq}`, roles, isApprover }).returning();
  return { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
}
const actions = ["create", "withdraw", "void", "shortClose", "approve", "reverse"] as const;
async function setup(action: typeof actions[number]) {
  const user = await actor(action === "approve" ? ["finance"] : ["warehouse"]);
  const maker = action === "approve" ? await actor() : user;
  const [doc] = await fixture.db.insert(stockDocs).values({ docNo: `WRITE-DOC-${++seq}`, subtype: "opening", createdBy: maker.id,
    status: action === "approve" || action === "withdraw" ? "pending" : action === "shortClose" ? "approved" : action === "reverse" ? "completed" : "draft" }).returning();
  await fixture.db.insert(stockDocLines).values({ stockDocId: doc.id, skuId, warehouseId, qty: "0.1250", price: "1.20" });
  const run = () => action === "create" ? createStockDoc(user, { subtype: "opening", warehouseId, lines: [{ skuId, qty: "0.1250", price: "1.20" }] }, fixture.db)
    : action === "withdraw" ? withdrawStockDoc(user, doc.id, { version: 1 }, fixture.db)
    : action === "void" ? voidStockDoc(user, doc.id, { version: 1, reason: "录入纠错" }, fixture.db)
    : action === "shortClose" ? shortCloseStockDoc(user, doc.id, { version: 1, reason: "停止剩余执行" }, fixture.db)
    : action === "reverse" ? reverseStockDoc(user, doc.id, { reason: "录入纠错" }, fixture.db)
    : approveStockDoc(user, doc.id, { version: 1, action: "reject" }, fixture.db);
  return { user, doc, run };
}
const snapshot = async () => ({
  docs: await fixture.db.select().from(stockDocs).orderBy(stockDocs.id),
  lines: await fixture.db.select().from(stockDocLines).orderBy(stockDocLines.id),
  audit: await fixture.db.select().from(auditLogs).orderBy(auditLogs.id),
  approvals: await fixture.db.select().from(approvals).orderBy(approvals.id),
  ledger: await fixture.db.select().from(stockLedger),
});

it.each(actions)("%s refuses disabled accounts, revoked sessions and removed roles in the transaction", async action => {
  for (const reason of ["disabled", "session", "role"]) {
    const f = await setup(action), before = await snapshot();
    await fixture.db.update(users).set(reason === "disabled" ? { active: false } : reason === "session"
      ? { sessionVersion: f.user.sessionVersion! + 1 } : { roles: ["ops"] }).where(eq(users.id, f.user.id));
    await expect(f.run()).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
    expect(await snapshot()).toEqual(before);
  }
});

it.each(actions)("%s rolls back all facts on audit failure and supports a checked retry", async action => {
  const f = await setup(action), before = await snapshot();
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("injected write audit failure"));
  await expect(f.run()).rejects.toThrow("injected write audit failure");
  expect(await snapshot()).toEqual(before);
  await f.run();
  const after = await snapshot();
  expect(after.audit.length).toBe(before.audit.length + 1);
  expect(after.ledger).toEqual(before.ledger);
});

it("revoked approver flag cannot be reused even with the finance role", async () => {
  const f = await setup("approve"), before = await snapshot();
  await fixture.db.update(users).set({ isApprover: false }).where(eq(users.id, f.user.id));
  await expect(f.run()).rejects.toMatchObject({ status: 403 }); expect(await snapshot()).toEqual(before);
});
it("a removed admin role cannot withdraw another maker's document", async () => {
  const f = await setup("withdraw"), admin = await actor(["admin"]);
  await fixture.db.update(users).set({ roles: ["warehouse"] }).where(eq(users.id, admin.id));
  await expect(withdrawStockDoc(admin, f.doc.id, { version: 1 }, fixture.db)).rejects.toMatchObject({ status: 403 });
});
it("action hints prevent self approval including admin, and respect live finance config", async () => {
  const admin = await actor(["admin"]), finance = await actor(["finance"]), wh = await actor();
  const doc = { status: "pending", subtype: "opening", createdBy: admin.id, reversalOfId: null } as const;
  expect(stockDocActions(admin, doc, "finance")).toMatchObject({ approve: false, withdraw: true, reason: expect.stringContaining("分离") });
  expect(stockDocActions(finance, doc, "finance").approve).toBe(true);
  expect(stockDocActions(wh, doc, "finance").approve).toBe(false);
  expect(stockDocActions(finance, doc, null).approve).toBe(false);
  expect(stockDocActions(finance, { ...doc, subtype: "count_adjust" }, "finance")).toMatchObject({ approve: false, withdraw: false });
});
it("completed documents with an existing non-void reversal no longer offer another reversal", async () => {
  const f = await setup("reverse");
  expect((await getStockDoc(f.doc.id, fixture.db, f.user)).actions?.reverse).toBe(true);
  await f.run();
  const detail = await getStockDoc(f.doc.id, fixture.db, f.user);
  expect(detail.actions).toMatchObject({ reverse: false, reason: expect.stringContaining("已存在红字") });
  await expect(f.run()).rejects.toMatchObject({ status: 409 });
});
