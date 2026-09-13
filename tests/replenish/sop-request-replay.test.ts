import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { executeFrozenPlan, getFrozenPlanExecution, getSopExecutionResult } from "@/server/modules/replenish/sop-cycle";
import { createTestDb } from "../helpers/db";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let actor: SessionUser;
let other: SessionUser;
let cycleId: number;
let planId: number;
let skuIds: number[];
const key = "ec264aa1-38a0-4803-9643-f9371545d3b8";
const request = (extra = {}) => ({ cycleId, idempotencyKey: key, ...extra });

beforeEach(async () => {
  fixture = await createTestDb();
  const { db } = fixture;
  const users = await db.insert(schema.users).values([{ name: "QA计划甲", roles: ["pmc"] }, { name: "QA计划乙", roles: ["pmc"] }]).returning();
  [actor, other] = users.map(u => ({ id: u.id, name: u.name, roles: u.roles, isApprover: false, sessionVersion: u.sessionVersion }));
  const [spu] = await db.insert(schema.spus).values({ code: "SOP-REPLAY", nameCn: "QA回执" }).returning();
  const skus = await db.insert(schema.skus).values(["A", "B"].map(code => ({ code: `SOP-${code}`, name: `QA${code}`, spuId: spu.id, skuType: "finished" as const, baseUom: "支" }))).returning();
  skuIds = skus.map(s => s.id);
  const [plan] = await db.insert(schema.planningVersions).values({ name: "QA冻结计划", weekStart: "2026-09-01", engineVersion: "qa", parameters: {}, sourceMeta: {}, lineCount: 2, suggestedCount: 2, suppressedCount: 0, digest: "a".repeat(64), idempotencyKey: crypto.randomUUID(), createdBy: actor.id }).returning();
  planId = plan.id;
  await db.insert(schema.planningVersionLines).values(skus.map((sku, i) => ({ versionId: plan.id, skuId: sku.id, skuCode: sku.code, skuName: sku.name!, baseUom: "支", suggestedQty: i ? "0.0001" : "12.3456", suppressed: false, orderWindowMissed: false, onHand: "0", inTransit: "0", daily: "1", safetyQty: "0", leadDays: 1, explanation: [] })));
  // Synthetic frozen source; consensus signing is independently tested in sop-consensus-integrity.
  const [cycle] = await db.insert(schema.sopCycles).values({ month: "2026-09", name: "QA周期", planningVersionId: plan.id, planDigest: plan.digest, status: "frozen", frozenBy: actor.id, frozenAt: new Date(), idempotencyKey: crypto.randomUUID(), createdBy: actor.id }).returning();
  cycleId = cycle.id;
});
afterEach(async () => { await fixture.client.close(); });

async function legacyReceipt(idempotencyKey: string) {
  const [bh] = await fixture.db.insert(schema.bhDocs).values({ docNo: `QA-LEGACY-${crypto.randomUUID()}`, createdBy: actor.id }).returning();
  await fixture.db.insert(schema.sopExecutionDrafts).values({ cycleId, cycleVersion: 1, bhId: bh.id, docNo: bh.docNo, planningVersionId: planId, planDigest: "a".repeat(64), skuIds, idempotencyKey, createdBy: actor.id });
  return bh;
}

describe("冻结计划回执：当前身份、准确原意、历史不猜测", () => {
  it("canonical key, defaults and empty selection replay exactly one receipt", async () => {
    const original = await executeFrozenPlan(actor, request(), fixture.db);
    expect(await executeFrozenPlan(actor, request({ idempotencyKey: key.toUpperCase(), skuIds: [], includeSuppressed: false, remark: "  " }), fixture.db)).toEqual(original);
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(1);
    const [receipt] = await fixture.db.select().from(schema.sopExecutionDrafts);
    expect(receipt.requestIntent).toEqual({ v: 1, cycleId, skuIds: null, includeSuppressed: false, remark: null });
    const lines = await fixture.db.select().from(schema.bhLines);
    expect(lines.map(l => l.qty)).toEqual(["12.3456", "0.0001"]);
  });
  it("selection order and duplicates normalize; explicit all remains distinct from implicit all", async () => {
    const original = await executeFrozenPlan(actor, request({ skuIds, remark: " 核对后开单 " }), fixture.db);
    expect(await executeFrozenPlan(actor, request({ skuIds: [...skuIds].reverse().concat(skuIds[0]), remark: "核对后开单" }), fixture.db)).toEqual(original);
    await expect(executeFrozenPlan(actor, request({ remark: "核对后开单" }), fixture.db)).rejects.toMatchObject({ status: 409 });
  });
  it.each(["cycle", "selection", "suppressed", "remark"])("a reused key rejects changed %s without another document", async mode => {
    await executeFrozenPlan(actor, request(), fixture.db);
    const change = mode === "cycle" ? { cycleId: cycleId + 1 } : mode === "selection" ? { skuIds: [skuIds[0]] }
      : mode === "suppressed" ? { includeSuppressed: true } : { remark: "不同请求" };
    await expect(executeFrozenPlan(actor, request(change), fixture.db)).rejects.toMatchObject({ status: 409 });
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(1);
  });
  it("another current PMC cannot claim or learn the original document via its request key", async () => {
    const original = await executeFrozenPlan(actor, request(), fixture.db);
    try { await executeFrozenPlan(other, request(), fixture.db); expect.fail("must refuse"); }
    catch (error) { expect(error).toMatchObject({ status: 403 }); expect((error as Error).message).not.toContain(original.docNo); }
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(1);
  });
  it.each(["role", "inactive", "session"])("database %s revocation rejects old and new requests despite stale caller", async mode => {
    await executeFrozenPlan(actor, request(), fixture.db);
    await fixture.db.update(schema.users).set(mode === "role" ? { roles: ["warehouse"] }
      : mode === "inactive" ? { active: false } : { sessionVersion: actor.sessionVersion! + 1 }).where(eq(schema.users.id, actor.id));
    for (const idempotencyKey of [key, crypto.randomUUID()]) {
      await expect(executeFrozenPlan(actor, request({ idempotencyKey }), fixture.db)).rejects.toMatchObject({ status: mode === "session" ? 401 : 403 });
    }
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(1);
  });
  it("closed source can recover its original request, but cannot create another", async () => {
    const original = await executeFrozenPlan(actor, request(), fixture.db);
    await fixture.db.update(schema.sopCycles).set({ status: "closed", version: 2, executingBy: actor.id, executingAt: new Date(), closedBy: actor.id, closedAt: new Date() }).where(eq(schema.sopCycles.id, cycleId));
    await fixture.db.update(schema.bhDocs).set({ status: "approved" }).where(eq(schema.bhDocs.id, original.id));
    expect(await executeFrozenPlan(actor, request(), fixture.db)).toEqual(original);
    await expect(executeFrozenPlan(actor, request({ idempotencyKey: crypto.randomUUID() }), fixture.db)).rejects.toMatchObject({ status: 409 });
    expect((await fixture.db.select().from(schema.bhDocs))[0].status).toBe("approved");
    const beforeAudits = await fixture.db.select().from(schema.auditLogs);
    const recovered = await getSopExecutionResult(actor, key.toUpperCase(), fixture.db);
    expect(recovered).toMatchObject({ requestKey: key, document: { id: original.id, docNo: original.docNo, status: "approved" } });
    const history = await getFrozenPlanExecution(actor, cycleId, fixture.db);
    expect(history.cycle.status).toBe("closed"); expect(history.drafts[0].bhId).toBe(original.id);
    expect(history.lines.every(l => l.drafted)).toBe(true);
    expect(await fixture.db.select().from(schema.auditLogs)).toEqual(beforeAudits);
  });
  it("read-only lookup returns an explicit missing result without any document/audit effects", async () => {
    expect(await getSopExecutionResult(actor, key, fixture.db)).toEqual({ requestKey: key, document: null, requestIntent: null, lineCount: 0 });
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(0);
    expect(await fixture.db.select().from(schema.auditLogs)).toHaveLength(0);
  });
  it("lookup rejects other owners and stale roles, disabled accounts, or revoked sessions", async () => {
    await executeFrozenPlan(actor, request(), fixture.db);
    await expect(getSopExecutionResult(other, key, fixture.db)).rejects.toMatchObject({ status: 403 });
    for (const changed of [{ roles: ["warehouse"] }, { active: false }, { sessionVersion: actor.sessionVersion! + 1 }]) {
      await fixture.db.update(schema.users).set({ roles: ["pmc"], active: true, sessionVersion: actor.sessionVersion, ...changed }).where(eq(schema.users.id, actor.id));
      await expect(getSopExecutionResult(actor, key, fixture.db)).rejects.toMatchObject({ status: "sessionVersion" in changed ? 401 : 403 });
    }
  });
  it("history hides out-of-scope BH identity but keeps shared plan coverage accurate", async () => {
    const original = await executeFrozenPlan(actor, request(), fixture.db);
    await fixture.db.insert(schema.userDataScopes).values({ userId: other.id, scopeKind: "channel", targetId: 987, createdBy: actor.id });
    const history = await getFrozenPlanExecution(other, cycleId, fixture.db);
    expect(history.drafts).toEqual([]); expect(history.lines.every(l => l.drafted)).toBe(true);
    expect(JSON.stringify(history)).not.toContain(original.docNo);
  });
  it.each([false, true])("legacy unknown intent refuses even with uppercase key=%s, preserves original", async uppercase => {
    const bh = await legacyReceipt(uppercase ? key.toUpperCase() : key);
    await expect(executeFrozenPlan(actor, request(), fixture.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(bh.docNo) });
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(1);
    expect((await fixture.db.select().from(schema.sopExecutionDrafts))[0].requestIntent).toBeNull();
  });
  it("ambiguous legacy case collisions refuse rather than choosing a receipt", async () => {
    await legacyReceipt(key); await legacyReceipt(key.toUpperCase());
    await expect(executeFrozenPlan(actor, request(), fixture.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("大小写冲突") });
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(2);
  });
  it.each(["UPDATE sop_execution_drafts SET request_intent = null", "DELETE FROM sop_execution_drafts", "TRUNCATE sop_execution_drafts"])("migration enforces append-only receipt: %s", async statement => {
    await executeFrozenPlan(actor, request(), fixture.db);
    await expect(fixture.client.exec(statement)).rejects.toThrow();
    expect(await fixture.db.select().from(schema.sopExecutionDrafts)).toHaveLength(1);
  });
});
