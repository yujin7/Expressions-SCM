import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import * as bh from "@/server/modules/outsource/bh";
import { createReplenishDraft } from "@/server/modules/replenish/service";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

let failAction = "";
vi.mock("@/server/core/audit", async original => {
  const actual = await original<typeof import("@/server/core/audit")>();
  return { ...actual, writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
    if (args[1].action === failAction) throw new Error("injected BH audit failure");
    return actual.writeAudit(...args);
  } };
});
let db: TestDb, maker: SessionUser, checker: SessionUser, stranger: SessionUser;
let skuId: number;
beforeAll(async () => {
  ({ db } = await createTestDb());
  const people = await db.insert(s.users).values([
    { name: "需求制单", roles: ["ops"] },
    { name: "需求审批", roles: ["pmc"], isApprover: true },
    { name: "普通运营", roles: ["ops"] },
  ]).returning();
  [maker, checker, stranger] = people.map(p => ({ id: p.id, name: p.name, roles: p.roles, isApprover: p.isApprover, sessionVersion: p.sessionVersion }));
  const [spu] = await db.insert(s.spus).values({ code: "BH-AUTH", nameCn: "备货资格" }).returning();
  const [sku] = await db.insert(s.skus).values({ spuId: spu.id, code: "BH-AUTH-FG", name: "精华", skuType: "finished", baseUom: "瓶" }).returning();
  skuId = sku.id;
  await db.insert(s.approvalConfigs).values({ docType: "bh", approverRole: "pmc" });
});
afterEach(async () => {
  failAction = "";
  for (const person of [maker, checker, stranger]) await db.update(s.users).set({
    active: true, roles: person.roles, isApprover: person.isApprover, sessionVersion: person.sessionVersion,
  }).where(eq(s.users.id, person.id));
  await db.delete(s.userDataScopes);
});
const input = () => ({ lines: [{ skuId, qty: "12.3456", expectDate: "2026-10-12" }] });
const edit = (version = 1) => ({ ...input(), version, reason: "核对需求" });
const create = () => bh.createBh(maker, input(), db);
async function stored(id: number) {
  return { doc: (await db.select().from(s.bhDocs).where(eq(s.bhDocs.id, id)))[0],
    lines: await db.select().from(s.bhLines).where(eq(s.bhLines.bhId, id)),
    audit: await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "bh"), eq(s.auditLogs.entityId, id))),
    approvals: await db.select().from(s.approvals).where(and(eq(s.approvals.docType, "bh"), eq(s.approvals.docId, id))) };
}
const actions = ["create", "edit", "submit", "approve", "withdraw", "close"] as const;
async function actionFixture(action: typeof actions[number]) {
  const doc = await create();
  if (["approve", "withdraw"].includes(action)) await bh.submitBh(maker, doc.id, 1, db);
  if (action === "close") await db.update(s.bhDocs).set({ status: "approved" }).where(eq(s.bhDocs.id, doc.id));
  const actor = action === "approve" ? checker : maker;
  const call = () => {
    switch (action) {
      case "create": return bh.createBh(actor, input(), db);
      case "edit": return bh.updateBh(actor, doc.id, edit(), db);
      case "submit": return bh.submitBh(actor, doc.id, 1, db);
      case "approve": return bh.approveBh(actor, doc.id, { version: 2, action: "approve" }, db);
      case "withdraw": return bh.withdrawBH(actor, doc.id, { version: 2 }, db);
      case "close": return bh.transitionBH(actor, doc.id, { version: 1, action: "short_close", reason: "需求取消" }, db);
    }
  };
  return { doc, actor, call };
}
it.each(actions)("%s rejects a disabled current actor without document/audit changes", async action => {
  const f = await actionFixture(action), before = await stored(f.doc.id);
  const count = (await db.select().from(s.bhDocs)).length;
  await db.update(s.users).set({ active: false }).where(eq(s.users.id, f.actor.id));
  await expect(f.call()).rejects.toMatchObject({ status: 403 });
  expect(await stored(f.doc.id)).toEqual(before);
  expect((await db.select().from(s.bhDocs)).length).toBe(count);
});
it.each(actions)("%s rejects an expired session before any effect", async action => {
  const f = await actionFixture(action), before = await stored(f.doc.id);
  await db.update(s.users).set({ sessionVersion: f.actor.sessionVersion! + 1 }).where(eq(s.users.id, f.actor.id));
  await expect(f.call()).rejects.toMatchObject({ status: 401 });
  expect(await stored(f.doc.id)).toEqual(before);
});
it("does not trust a fabricated ops/admin role; manual PMC and derived ops replenishment remain forbidden", async () => {
  const doc = await create();
  await expect(bh.createBh({ ...checker, roles: ["ops", "admin"] }, input(), db)).rejects.toMatchObject({ status: 403 });
  await expect(bh.updateBh({ ...stranger, roles: ["admin"] }, doc.id, edit(), db)).rejects.toMatchObject({ status: 403 });
  await expect(bh.createDerivedBh(maker, "replenish", input(), db, { inTx: async () => {} })).rejects.toMatchObject({ status: 403 });
  await db.update(s.users).set({ roles: ["quality"] }).where(eq(s.users.id, checker.id));
  await expect(bh.createDerivedBh(checker, "sop", input(), db, { inTx: async () => {} })).rejects.toMatchObject({ status: 403 });
});
it("source audit failure rolls back realtime replenishment BH, lines, numbering and both audit events", async () => {
  const before = { docs: await db.select().from(s.bhDocs), lines: await db.select().from(s.bhLines), counters: await db.select().from(s.docCounters), audit: await db.select().from(s.auditLogs) };
  failAction = "draft_bh";
  await expect(createReplenishDraft(checker, { items: [{ skuId, qty: "12.3456" }] }, db)).rejects.toThrow("injected");
  expect({ docs: await db.select().from(s.bhDocs), lines: await db.select().from(s.bhLines), counters: await db.select().from(s.docCounters), audit: await db.select().from(s.auditLogs) }).toEqual(before);
  failAction = "";
  const doc = await createReplenishDraft(checker, { items: [{ skuId, qty: "12.3456" }] }, db);
  expect((await stored(doc.id)).doc).toMatchObject({ createdBy: checker.id, status: "draft" });
  expect((await stored(doc.id)).lines[0].qty).toBe("12.3456");
  expect((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "replenish"), eq(s.auditLogs.entityId, doc.id))))).toHaveLength(1);
  expect(await db.select().from(s.stockLedger)).toHaveLength(0);
});
it("approval audit failure rolls back approval history, version and state; replay still requires current checker", async () => {
  const doc = await create(); await bh.submitBh(maker, doc.id, 1, db);
  const before = await stored(doc.id); failAction = "approve";
  await expect(bh.approveBh(checker, doc.id, { version: 2, action: "approve" }, db)).rejects.toThrow("injected");
  expect(await stored(doc.id)).toEqual(before); failAction = "";
  await bh.approveBh(checker, doc.id, { version: 2, action: "approve" }, db);
  expect(await bh.approveBh(checker, doc.id, { version: 2, action: "approve" }, db)).toMatchObject({ idempotent: true });
  await db.update(s.users).set({ isApprover: false }).where(eq(s.users.id, checker.id));
  await expect(bh.approveBh(checker, doc.id, { version: 2, action: "approve" }, db)).rejects.toMatchObject({ status: 403 });
  expect((await stored(doc.id)).approvals).toHaveLength(1);
});
it("approval and closure use current DB channel scopes before writing or replaying", async () => {
  const doc = await create(); await bh.submitBh(maker, doc.id, 1, db);
  await db.insert(s.userDataScopes).values([
    { userId: maker.id, scopeKind: "channel", targetId: 10, createdBy: maker.id },
    { userId: checker.id, scopeKind: "channel", targetId: 20, createdBy: maker.id },
  ]);
  const staleScope = { ...checker, channelScope: [10] };
  await expect(bh.approveBh(staleScope, doc.id, { version: 2, action: "approve" }, db)).rejects.toMatchObject({ status: 404 });
  await db.update(s.userDataScopes).set({ targetId: 10 }).where(eq(s.userDataScopes.userId, checker.id));
  await bh.approveBh(checker, doc.id, { version: 2, action: "approve" }, db);
  await db.update(s.userDataScopes).set({ targetId: 20 }).where(eq(s.userDataScopes.userId, checker.id));
  await expect(bh.approveBh(staleScope, doc.id, { version: 2, action: "approve" }, db)).rejects.toMatchObject({ status: 404 });
  await expect(bh.transitionBH(staleScope, doc.id, { version: 3, action: "short_close", reason: "核对" }, db)).rejects.toMatchObject({ status: 404 });
  expect((await stored(doc.id)).doc.status).toBe("approved");
});
it("withdraw and closure audit failures preserve prior state and reason", async () => {
  const doc = await create(); await bh.submitBh(maker, doc.id, 1, db);
  const before = await stored(doc.id); failAction = "withdraw";
  await expect(bh.withdrawBH(maker, doc.id, { version: 2 }, db)).rejects.toThrow("injected");
  expect(await stored(doc.id)).toEqual(before); failAction = "";
  await bh.approveBh(checker, doc.id, { version: 2, action: "approve" }, db);
  const approved = await stored(doc.id); failAction = "short_close";
  await expect(bh.transitionBH(maker, doc.id, { version: 3, action: "short_close", reason: "取消余量" }, db)).rejects.toThrow("injected");
  expect(await stored(doc.id)).toEqual(approved);
});
