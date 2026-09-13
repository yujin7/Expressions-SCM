import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { auditLogs, docCounters, reviewItems, skus, spus, stockDocLines, stockDocs, stockLedger, users, warehouses } from "@/db/schema";
import * as audit from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { createStockDoc } from "@/server/modules/inventory/stock-doc";
import { createTestDb } from "../helpers/db";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let seq = 0;
beforeAll(async () => { fixture = await createTestDb(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => fixture?.client.close());

async function setup() {
  const key = `CREATE-REF-${++seq}`;
  const [user] = await fixture.db.insert(users).values({ name: key, roles: ["warehouse"] }).returning();
  const [spu] = await fixture.db.insert(spus).values({ code: key, nameCn: key }).returning();
  const [sku] = await fixture.db.insert(skus).values({ code: key, name: key, spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
  const wh = await fixture.db.insert(warehouses).values(["A", "B"].map(suffix => ({ code: `${key}-${suffix}`, name: key, kind: "raw" as const, accountingMode: "realtime" as const }))).returning();
  const actor: SessionUser = { id: user.id, name: user.name, roles: user.roles, isApprover: user.isApprover, sessionVersion: user.sessionVersion };
  return { actor, sku, wh, input: { subtype: "opening", warehouseId: wh[0].id, lines: [{ skuId: sku.id, qty: "0.0001", price: "1.23" }] } };
}
const snapshot = async () => ({
  docs: await fixture.db.select().from(stockDocs).orderBy(stockDocs.id),
  lines: await fixture.db.select().from(stockDocLines).orderBy(stockDocLines.id),
  audit: await fixture.db.select().from(auditLogs).orderBy(auditLogs.id),
  counters: await fixture.db.select().from(docCounters),
  ledger: await fixture.db.select().from(stockLedger),
});

// Deterministic interleaving: a master edit commits just before the owning transaction begins.
// Real PostgreSQL blocking in both directions is covered by the opt-in contract script.
it.each(["source-disabled", "source-snapshot", "target-disabled", "target-snapshot", "sku-disabled"])("rechecks %s inside creation, leaving no partial document or number", async reason => {
  const f = await setup();
  const input = reason.startsWith("target") ? { ...f.input, subtype: "transfer", toWarehouseId: f.wh[1].id, transferType: "inter_warehouse", lines: [{ skuId: f.sku.id, qty: "0.0001" }] } : f.input;
  const before = await snapshot();
  const transaction = fixture.db.transaction.bind(fixture.db);
  vi.spyOn(fixture.db, "transaction").mockImplementationOnce(async callback => {
    if (reason === "sku-disabled") await fixture.db.update(skus).set({ active: false }).where(eq(skus.id, f.sku.id));
    else await fixture.db.update(warehouses).set(reason.endsWith("disabled") ? { active: false } : { accountingMode: "snapshot", kind: "snapshot" })
      .where(eq(warehouses.id, f.wh[reason.startsWith("target") ? 1 : 0].id));
    return transaction(callback);
  });
  await expect(createStockDoc(f.actor, input, fixture.db)).rejects.toMatchObject({ status: 400 });
  expect(await snapshot()).toEqual(before);
});

it("does not query reference master data outside the owning transaction", async () => {
  const f = await setup();
  const outsideRead = vi.spyOn(fixture.db, "select").mockImplementation(() => { throw Error("reference read outside transaction"); });
  const doc = await createStockDoc(f.actor, f.input, fixture.db);
  expect(outsideRead).not.toHaveBeenCalled();
  outsideRead.mockRestore();
  expect(doc.status).toBe("draft");
  const [line] = await fixture.db.select().from(stockDocLines).where(eq(stockDocLines.stockDocId, doc.id));
  expect(line).toMatchObject({ qty: "0.0001", price: "1.23", warehouseId: f.wh[0].id });
});

it("audit failure rolls back number, document and lines; retry creates exactly once", async () => {
  const f = await setup(), before = await snapshot();
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("reference audit fault"));
  await expect(createStockDoc(f.actor, f.input, fixture.db)).rejects.toThrow("reference audit fault");
  expect(await snapshot()).toEqual(before);
  await createStockDoc(f.actor, f.input, fixture.db);
  const after = await snapshot();
  expect(after.docs.length).toBe(before.docs.length + 1);
  expect(after.lines.length).toBe(before.lines.length + 1);
  expect(after.audit.length).toBe(before.audit.length + 1);
  expect(after.ledger).toEqual(before.ledger);
});

it.each(["done", "overruled"])("rejects a %s disposal source without a document", async status => {
  const f = await setup();
  const [review] = await fixture.db.insert(reviewItems).values({ category: "risk_disposal", refKey: f.sku.code, title: "处置决定：报废评审 测试", status }).returning();
  const before = await snapshot();
  await expect(createStockDoc(f.actor, { subtype: "issue_out", warehouseId: f.wh[0].id, riskDisposalId: review.id,
    lines: [{ skuId: f.sku.id, qty: "0.0001" }] }, fixture.db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
});
