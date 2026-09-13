import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { approvePo, confirmPo, getPo, submitPo, withdrawPO } from "@/server/modules/outsource/po";
import { generateConfirmToken } from "@/server/modules/outsource/po-confirm";
import { poTaskActions } from "@/server/modules/outsource/po-task-actions";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], seq = 0;
beforeAll(async () => { ({ db, client } = await createTestDb()); await db.insert(s.approvalConfigs).values({ docType: "po", approverRole: "purchasing" }); });
afterAll(async () => { await client.close(); });
async function fixture(status: "draft" | "pending" | "approved" = "draft", deviation = false) {
  const code = `PO-AUTH-${++seq}`;
  const [maker, buyer, checker] = await db.insert(s.users).values([
    { name: code + "制单", roles: ["pmc"], isApprover: true },
    { name: code + "采购", roles: ["purchasing"] },
    { name: code + "审批", roles: ["purchasing"], isApprover: true },
  ]).returning();
  const [spu] = await db.insert(s.spus).values({ code, nameCn: "采购操作合成" }).returning();
  const [sku] = await db.insert(s.skus).values({ code, spuId: spu.id, skuType: "raw", baseUom: "个" }).returning();
  const [supplier] = await db.insert(s.suppliers).values({ code, name: "采购合成供应商", status: "qualified" }).returning();
  const [po] = await db.insert(s.poDocs).values({ docNo: code, status, supplierId: supplier.id, createdBy: maker.id }).returning();
  const [line] = await db.insert(s.poLines).values({ poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "个", qty: "10", price: deviation ? "4" : "2" }).returning();
  if (deviation) await db.insert(s.priceLists).values({ supplierId: supplier.id, skuId: sku.id, price: "2", effectiveDate: "2026-01-01" });
  return { maker, buyer, checker, po, line };
}
type Kind = "submit" | "approve" | "withdraw" | "confirm" | "token";
const kinds: Kind[] = ["submit", "approve", "withdraw", "confirm", "token"];
const sourceStatus = (kind: Kind) => kind === "submit" ? "draft" : kind === "approve" || kind === "withdraw" ? "pending" : "approved";
function invoke(kind: Kind, f: Awaited<ReturnType<typeof fixture>>, user?: SessionUser) {
  const actor = user ?? (kind === "withdraw" ? f.maker : kind === "approve" ? f.checker : f.buyer);
  if (kind === "submit") return submitPo(actor, f.po.id, 1, db);
  if (kind === "approve") return approvePo(actor, f.po.id, { action: "approve", version: 1 }, db);
  if (kind === "withdraw") return withdrawPO(actor, f.po.id, { version: 1 }, db);
  if (kind === "confirm") return confirmPo(actor, f.po.id, { version: 1, note: "人工代录" }, db);
  return generateConfirmToken(actor, f.po.id, db);
}
const snapshot = async () => ({ po: await db.select().from(s.poDocs), pc: await db.select().from(s.pcDocs), counters: await db.select().from(s.docCounters), approvals: await db.select().from(s.approvals), audits: await db.select().from(s.auditLogs), ledger: await db.select().from(s.stockLedger) });

it.each(kinds)("%s audit failure rolls back status, token, approval and numbering together", async kind => {
  const f = await fixture(sourceStatus(kind)), before = await snapshot();
  const spy = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("audit fault"));
  try { await expect(invoke(kind, f)).rejects.toThrow("audit fault"); } finally { spy.mockRestore(); }
  expect(await snapshot()).toEqual(before);
});
it.each(kinds)("%s rejects a disabled or expired current identity, even with old caller claims", async kind => {
  const f = await fixture(sourceStatus(kind));
  const actor = kind === "withdraw" ? f.maker : kind === "approve" ? f.checker : f.buyer;
  await db.update(s.users).set({ active: false }).where(eq(s.users.id, actor.id));
  const before = await snapshot();
  await expect(invoke(kind, f, actor)).rejects.toMatchObject({ status: 403 });
  await db.update(s.users).set({ active: true, sessionVersion: actor.sessionVersion + 1 }).where(eq(s.users.id, actor.id));
  await expect(invoke(kind, f, actor)).rejects.toMatchObject({ status: 401 });
  expect(await snapshot()).toEqual(before);
});
it.each(kinds)("%s never accepts caller-forged purchasing/admin rights", async kind => {
  const f = await fixture(sourceStatus(kind));
  await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, f.buyer.id));
  const before = await snapshot();
  await expect(invoke(kind, f, { ...f.buyer, roles: ["admin", "purchasing"], isApprover: true })).rejects.toMatchObject({ status: 403 });
  expect(await snapshot()).toEqual(before);
});
it("stale version cannot create a PC before returning conflict", async () => {
  const f = await fixture("draft", true), before = await snapshot();
  await expect(submitPo(f.buyer, f.po.id, 2, db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
});
it("two R1 submissions reuse one PC and audit while deliberately leaving PO draft", async () => {
  const f = await fixture("draft", true);
  const results = await Promise.allSettled([submitPo(f.buyer, f.po.id, 1, db), submitPo(f.buyer, f.po.id, 1, db)]);
  expect(results.every(r => r.status === "rejected" && r.reason.code === "PO_PRICE_REVIEW_REQUIRED")).toBe(true);
  const pcs = await db.select().from(s.pcDocs).where(eq(s.pcDocs.poLineId, f.line.id)); expect(pcs).toHaveLength(1);
  const audits = await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "pc"), eq(s.auditLogs.entityId, pcs[0].id))); expect(audits).toHaveLength(1);
  expect((await getPo(f.po.id, db)).status).toBe("draft");
});
it("R1 PC audit failure rolls back PC and counter, then a safe explicit retry creates once", async () => {
  const f = await fixture("draft", true), before = await snapshot();
  const spy = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("pc audit fault"));
  try { await expect(submitPo(f.buyer, f.po.id, 1, db)).rejects.toThrow("pc audit fault"); } finally { spy.mockRestore(); }
  expect(await snapshot()).toEqual(before);
  await expect(submitPo(f.buyer, f.po.id, 1, db)).rejects.toMatchObject({ code: "PO_PRICE_REVIEW_REQUIRED" });
  expect(await db.select().from(s.pcDocs).where(eq(s.pcDocs.poLineId, f.line.id))).toHaveLength(1);
});
it("submit and confirmation each only advance once under concurrent replay", async () => {
  for (const kind of ["submit", "confirm"] as const) {
    const f = await fixture(sourceStatus(kind));
    const results = await Promise.allSettled([invoke(kind, f), invoke(kind, f)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await getPo(f.po.id, db)).version).toBe(2);
    expect(await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "po"), eq(s.auditLogs.entityId, f.po.id)))).toHaveLength(1);
  }
});
it("configured checker without price visibility may reject but not approve; no blind approval is committed", async () => {
  const f = await fixture("pending");
  await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, f.checker.id));
  await db.update(s.approvalConfigs).set({ approverRole: "warehouse" }).where(eq(s.approvalConfigs.docType, "po"));
  try {
    expect((await getPo(f.po.id, db, f.checker)).taskActions).toMatchObject({ approve: false, reject: true });
    const before = await snapshot();
    await expect(approvePo(f.checker, f.po.id, { action: "approve", version: 1 }, db)).rejects.toMatchObject({ status: 403 });
    expect(await snapshot()).toEqual(before);
    expect(await approvePo(f.checker, f.po.id, { action: "reject", version: 1 }, db)).toMatchObject({ status: "draft" });
  } finally { await db.update(s.approvalConfigs).set({ approverRole: "purchasing" }).where(eq(s.approvalConfigs.docType, "po")); }
});
it("read guidance follows actual maker, roles/config and current identity; no hints without actor", async () => {
  const f = await fixture("pending");
  expect((await getPo(f.po.id, db)).taskActions).toBeNull();
  expect((await getPo(f.po.id, db, f.maker)).taskActions).toMatchObject({ submit: false, approve: false, reject: false, withdraw: true, confirm: false, confirmToken: false });
  expect((await getPo(f.po.id, db, f.checker)).taskActions).toMatchObject({ approve: true, reject: true, withdraw: false });
  await db.update(s.users).set({ active: false }).where(eq(s.users.id, f.checker.id));
  expect((await getPo(f.po.id, db, f.checker)).taskActions).toBeNull();
  expect(poTaskActions(f.buyer, { ...f.po, status: "draft" }, null).submit).toBe(true);
  expect(poTaskActions({ ...f.buyer, roles: ["ops"] }, { ...f.po, status: "approved" }, null).confirmToken).toBe(false);
});
