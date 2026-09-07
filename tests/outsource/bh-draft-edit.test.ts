import { beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import * as bh from "@/server/modules/outsource/bh";
import type { SessionUser } from "@/server/core/dto";
import { getApprovalBrief } from "@/server/modules/inbox/approval-brief";
import { createTestDb, type TestDb } from "../helpers/db";

let failAction = "";
vi.mock("@/server/core/audit", async original => {
  const actual = await original<typeof import("@/server/core/audit")>();
  return { ...actual, writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
    if (args[1].action === failAction) throw new Error("injected audit failure");
    return actual.writeAudit(...args);
  } };
});
let db: TestDb, maker: SessionUser, checker: SessionUser, admin: SessionUser;
let sku: number, otherSku: number;
beforeAll(async () => {
  ({ db } = await createTestDb());
  const people = await db.insert(s.users).values([
    { name: "制单人", roles: ["ops"] }, { name: "审批人", roles: ["pmc"], isApprover: true }, { name: "管理员", roles: ["admin"] },
  ]).returning();
  [maker, checker, admin] = people.map(u => ({ id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover }));
  await db.insert(s.approvalConfigs).values({ docType: "bh", approverRole: "pmc" });
  const [spu] = await db.insert(s.spus).values({ code: "EDIT", nameCn: "草稿纠错" }).returning();
  const skus = await db.insert(s.skus).values([1, 2].map(n => ({ code: `EDIT-${n}`, name: `测试品${n}`, spuId: spu.id, skuType: "finished" as const, baseUom: "盒" }))).returning();
  [sku, otherSku] = skus.map(row => row.id);
});
const draft = () => bh.createBh(maker, { remark: "原备注", lines: [{ skuId: sku, qty: "1.2500", expectDate: "2026-09-10" }] }, db);
const payload = (version = 1) => ({ version, reason: "修正需求数量及日期", remark: "", lines: [{ skuId: sku, qty: "2.1250", expectDate: "2026-09-12" }] });
const stored = async (id: number) => ({ doc: (await db.select().from(s.bhDocs).where(eq(s.bhDocs.id, id)))[0], lines: await db.select().from(s.bhLines).where(eq(s.bhLines.bhId, id)) });

it("submission audit failure rolls back the status/version before a user can continue", async () => {
  const doc = await draft(); failAction = "submit";
  try { await expect(bh.submitBh(maker, doc.id, 1, db)).rejects.toThrow("injected"); }
  finally { failAction = ""; }
  expect((await stored(doc.id)).doc).toMatchObject({ status: "draft", version: 1 });
});

it("edits complete draft contents atomically while preserving identity and full before/after audit", async () => {
  const doc = await draft();
  const updated = await bh.updateBh(maker, doc.id, payload(), db);
  expect(updated).toMatchObject({ id: doc.id, docNo: doc.docNo, createdBy: maker.id, version: 2, status: "draft" });
  const after = await stored(doc.id); expect(after.doc.remark).toBe(""); expect(after.lines[0]).toMatchObject({ qty: "2.1250", expectDate: "2026-09-12" });
  const [audit] = await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entityId, doc.id), eq(s.auditLogs.entity, "bh"), eq(s.auditLogs.action, "update_draft")));
  expect(audit.before).toMatchObject({ version: 1, lines: [{ qty: "1.2500" }] });
  expect(audit.after).toMatchObject({ reason: payload().reason, version: 2, lines: [{ qty: "2.1250" }] });
});
it("draft edit audit failure leaves header and original line ids intact", async () => {
  const doc = await draft(); const before = await stored(doc.id); failAction = "update_draft";
  try { await expect(bh.updateBh(maker, doc.id, payload(), db)).rejects.toThrow("injected"); }
  finally { failAction = ""; }
  expect(await stored(doc.id)).toEqual(before);
});
it("prevents non-owner changes even when another maker can read the document", async () => {
  const doc = await draft(); await expect(bh.updateBh(checker, doc.id, payload(), db)).rejects.toThrow(/制单人/);
  expect((await stored(doc.id)).doc.version).toBe(1);
});
it("allows admin draft repair but never self-approval", async () => {
  const doc = await draft(); await bh.updateBh(admin, doc.id, payload(), db);
  const own = await bh.createBh(admin, { lines: [{ skuId: sku, qty: "1" }] }, db); await bh.submitBh(admin, own.id, 1, db);
  const detail = await bh.getBh(own.id, db, admin); expect(detail.actions?.approve).toBe(false);
  await expect(bh.approveBh(admin, own.id, { version: 2, action: "approve" }, db)).rejects.toThrow(/SELF_APPROVAL/);
});
it("stale replay cannot overwrite a successful newer edit", async () => {
  const doc = await draft(); await bh.updateBh(maker, doc.id, payload(), db);
  await expect(bh.updateBh(maker, doc.id, payload(), db)).rejects.toThrow(/版本/);
  expect((await stored(doc.id)).doc.version).toBe(2);
});
it("pending docs cannot be edited; withdraw-edit-resubmit then another person approves", async () => {
  const doc = await draft(); await bh.submitBh(maker, doc.id, 1, db);
  await expect(bh.updateBh(maker, doc.id, payload(2), db)).rejects.toThrow(/草稿/);
  await bh.withdrawBH(maker, doc.id, { version: 2 }, db);
  await bh.updateBh(maker, doc.id, payload(3), db); await bh.submitBh(maker, doc.id, 4, db);
  await bh.approveBh(checker, doc.id, { version: 5, action: "approve" }, db);
  expect((await stored(doc.id)).doc).toMatchObject({ status: "approved", version: 6 });
});
it("rejection preserves history and permits a corrected new approval cycle", async () => {
  const doc = await draft(); await bh.submitBh(maker, doc.id, 1, db);
  await bh.approveBh(checker, doc.id, { version: 2, action: "reject", comment: "修正数量" }, db);
  await bh.updateBh(maker, doc.id, payload(3), db); await bh.submitBh(maker, doc.id, 4, db);
  await bh.approveBh(checker, doc.id, { version: 5, action: "approve" }, db);
  expect((await bh.getBh(doc.id, db)).approvals.map(a => a.action)).toEqual(["reject", "approve"]);
});
it.each(["0.00001", "10000000000", "-1"])("rejects unstorable quantity %s without changing the draft", async qty => {
  const doc = await draft(); await expect(bh.updateBh(maker, doc.id, { ...payload(), lines: [{ skuId: sku, qty }] }, db)).rejects.toThrow();
  expect((await stored(doc.id)).doc.version).toBe(1);
});
it("rejects invalid calendar dates, empty lines and missing reasons", async () => {
  const doc = await draft();
  for (const value of [{ ...payload(), lines: [] }, { ...payload(), reason: "" }, { ...payload(), lines: [{ skuId: sku, qty: "1", expectDate: "2026-02-30" }] }]) {
    await expect(bh.updateBh(maker, doc.id, value, db)).rejects.toThrow();
  }
});
it("uses live approval configuration, isApprover and maker-checker in action hints", async () => {
  const doc = await draft(); await bh.submitBh(maker, doc.id, 1, db);
  expect((await bh.getBh(doc.id, db, maker)).actions).toMatchObject({ approve: false, withdraw: true, edit: false });
  expect((await bh.getBh(doc.id, db, checker)).actions).toMatchObject({ approve: true, withdraw: false });
  expect((await bh.getBh(doc.id, db, { ...checker, isApprover: false })).actions?.approve).toBe(false);
  await db.update(s.approvalConfigs).set({ approverRole: "purchasing" }).where(eq(s.approvalConfigs.docType, "bh"));
  expect((await bh.getBh(doc.id, db, checker)).actions?.approve).toBe(false);
  await db.update(s.approvalConfigs).set({ approverRole: "pmc" }).where(eq(s.approvalConfigs.docType, "bh"));
});
it("manual drafts can replace SKUs; generated drafts preserve source SKU identity", async () => {
  const manual = await draft(); await bh.updateBh(maker, manual.id, { ...payload(), lines: [{ skuId: otherSku, qty: "3" }] }, db);
  const generated = await draft(); await db.insert(s.auditLogs).values({ userId: maker.id, entity: "npd_project", entityId: 42, action: "first_order_draft", after: { docNo: generated.docNo } });
  expect((await bh.getBh(generated.id, db, maker)).sourceSkuLocked).toBe(true);
  await expect(bh.updateBh(maker, generated.id, { ...payload(), lines: [{ skuId: otherSku, qty: "3" }] }, db)).rejects.toThrow(/来源SKU/);
  await bh.updateBh(maker, generated.id, payload(), db);
  expect((await stored(generated.id)).lines[0].skuId).toBe(sku);
  const origin = (await getApprovalBrief("bh", generated.id, db, maker)).origin;
  expect(origin.fromSuggestion).toBe(true);
  expect(origin.note).toContain("新品首单"); expect(origin.note).toContain("人工修正");
  expect(origin.note).not.toContain("建议量已含安全库存");
});
it("refuses inactive SKU and downstream work-order conflicts, preserving the full draft", async () => {
  const doc = await draft(); const before = await stored(doc.id);
  await db.update(s.skus).set({ active: false }).where(eq(s.skus.id, otherSku));
  try { await expect(bh.updateBh(maker, doc.id, { ...payload(), lines: [{ skuId: otherSku, qty: "1" }] }, db)).rejects.toThrow(/停用/); }
  finally { await db.update(s.skus).set({ active: true }).where(eq(s.skus.id, otherSku)); }
  expect(await stored(doc.id)).toEqual(before);
  const [supplier] = await db.insert(s.suppliers).values({ code: "EDIT-FACTORY", name: "草稿测试厂", kinds: ["processor"] }).returning();
  const [bom] = await db.insert(s.boms).values({ productSkuId: sku, versionNo: "1" }).returning();
  await db.insert(s.woDocs).values({ docNo: "WO-EDIT-SOURCE", bhId: doc.id, createdBy: maker.id, productSkuId: sku, qty: "1", supplierId: supplier.id, feeRatePlan: "1", bomId: bom.id });
  await expect(bh.updateBh(maker, doc.id, payload(), db)).rejects.toThrow(/关联工单/);
  expect((await bh.getBh(doc.id, db, maker)).actions).toMatchObject({ edit: false, editReason: expect.stringContaining("关联工单") });
  expect(await stored(doc.id)).toEqual(before);
});
it("void is owner-only even on replay; audit failure cannot leave a void document", async () => {
  const doc = await draft(); failAction = "void";
  try { await expect(bh.transitionBH(maker, doc.id, { action: "void", version: 1 }, db)).rejects.toThrow("injected"); }
  finally { failAction = ""; }
  expect((await stored(doc.id)).doc.status).toBe("draft");
  await bh.transitionBH(maker, doc.id, { action: "void", version: 1 }, db);
  expect(await bh.transitionBH(maker, doc.id, { action: "void", version: 1 }, db)).toMatchObject({ status: "void", idempotent: true });
  await expect(bh.transitionBH(checker, doc.id, { action: "void", version: 1 }, db)).rejects.toThrow(/制单人/);
  expect((await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "bh"), eq(s.auditLogs.entityId, doc.id), eq(s.auditLogs.action, "void"))))).toHaveLength(1);
});
it("S&OP-derived edits retain the frozen execution identity and identify their origin in the brief", async () => {
  const doc = await draft();
  const [plan] = await db.insert(s.planningVersions).values({ name: "冻结需求", weekStart: "2026-09-07", engineVersion: "qa", parameters: {}, sourceMeta: {}, lineCount: 1, suggestedCount: 1, suppressedCount: 0, digest: "qa-plan", idempotencyKey: "qa-bh-edit-plan", createdBy: maker.id }).returning();
  const [cycle] = await db.insert(s.sopCycles).values({ name: "冻结需求周期", month: "2026-09", planningVersionId: plan.id, planDigest: plan.digest, idempotencyKey: "qa-bh-edit-cycle", createdBy: maker.id }).returning();
  const [link] = await db.insert(s.sopExecutionDrafts).values({ cycleId: cycle.id, cycleVersion: 1, bhId: doc.id, docNo: doc.docNo, planningVersionId: plan.id, planDigest: plan.digest, skuIds: [sku], idempotencyKey: "qa-bh-edit-link", createdBy: maker.id }).returning();
  expect((await bh.getBh(doc.id, db, maker)).sourceSkuLocked).toBe(true);
  await expect(bh.updateBh(maker, doc.id, { ...payload(), lines: [{ skuId: otherSku, qty: "1" }] }, db)).rejects.toThrow(/来源SKU/);
  await bh.updateBh(maker, doc.id, payload(), db);
  expect((await db.select().from(s.sopExecutionDrafts).where(eq(s.sopExecutionDrafts.id, link.id)))[0]).toEqual(link);
  const brief = await getApprovalBrief("bh", doc.id, db, maker);
  expect(brief.origin.note).toContain("冻结计划"); expect(brief.origin.note).toContain("人工修正");
});
