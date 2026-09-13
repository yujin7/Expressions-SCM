import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { getKitFactoryEvidence } from "@/server/modules/outsource/kit-factory-evidence";
import { outboundBatchBlock } from "@/server/posting/batch-eligibility";
import { allocateFefo } from "@/server/rules/fefo";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], seq = 0;
beforeAll(async () => { ({ db, client } = await createTestDb()); });
afterAll(async () => { await client.close(); });
afterEach(() => vi.useRealTimers());
async function fixture() {
  const code = `FACTORY-EVID-${++seq}`;
  const [actor] = await db.insert(s.users).values({ name: code, roles: ["pmc"] }).returning();
  const [spu] = await db.insert(s.spus).values({ code, nameCn: code }).returning();
  const [product, material] = await db.insert(s.skus).values([
    { code: `${code}-FG`, spuId: spu.id, skuType: "finished", baseUom: "支" },
    { code: `${code}-PK`, spuId: spu.id, skuType: "packaging", baseUom: "个" },
  ]).returning();
  const [supplier] = await db.insert(s.suppliers).values({ code, name: "合成加工厂" }).returning();
  const [bom] = await db.insert(s.boms).values({ productSkuId: product.id, versionNo: "1" }).returning();
  const woValues = { status: "approved" as const, productSkuId: product.id, qty: "100", supplierId: supplier.id, feeRatePlan: "1", bomId: bom.id, createdBy: actor.id };
  const [wo] = await db.insert(s.woDocs).values({ ...woValues, docNo: `WO-${code}` }).returning();
  const lineValues = { materialSkuId: material.id, qtyPer: "1", grossReq: "100", suggestedQty: "100" };
  await db.insert(s.woLines).values({ ...lineValues, woId: wo.id });
  return { code, actor, product, material, supplier, wo, woValues, lineValues,
    read: () => getKitFactoryEvidence(actor, wo.id, db),
    warehouse: async (active = true) => (await db.insert(s.warehouses).values({ code: `${code}-WH-${++seq}`, name: "合成委外仓", kind: "outsource", supplierId: supplier.id, active }).returning())[0] };
}

it("no factory mapping is unknown; a mapped empty factory is zero, never allocated", async () => {
  const f = await fixture();
  expect(await f.read()).toMatchObject({ woId: f.wo.id, allocationStatus: "unverified", warehouses: [], materials: [{ factoryOnHand: null, warehouses: [] }] });
  const warehouse = await f.warehouse();
  expect(await f.read()).toMatchObject({ warehouses: [{ id: warehouse.id }], materials: [{ factoryOnHand: "0", warehouses: [{ onHand: "0" }] }] });
});
it("other factories, ordinary warehouses and snapshots cannot become this factory's on-hand", async () => {
  const f = await fixture();
  const [otherSupplier] = await db.insert(s.suppliers).values({ code: `${f.code}-OTHER`, name: "其他厂" }).returning();
  const [ordinary, other, snapshot] = await db.insert(s.warehouses).values([
    { code: `${f.code}-ORD`, name: "总部仓", kind: "packaging", supplierId: f.supplier.id },
    { code: `${f.code}-OTHER`, name: "他厂仓", kind: "outsource", supplierId: otherSupplier.id },
    { code: `${f.code}-SNAP`, name: "快照仓", kind: "snapshot", accountingMode: "snapshot", supplierId: f.supplier.id },
  ]).returning();
  await db.insert(s.stockBalances).values([ordinary, other].map(w => ({ skuId: f.material.id, warehouseId: w.id, qty: "999" })));
  await db.insert(s.stockSnapshots).values({ skuId: f.material.id, warehouseId: snapshot.id, qty: "888", bizDate: "2026-09-13" });
  expect((await f.read()).materials[0].factoryOnHand).toBeNull();
});
it("negative and inactive-factory balances remain visible without offsetting risk observations", async () => {
  const f = await fixture(), w1 = await f.warehouse(), w2 = await f.warehouse(false);
  await db.insert(s.stockBalances).values([
    { skuId: f.material.id, warehouseId: w1.id, qty: "8.6001" },
    { skuId: f.material.id, warehouseId: w2.id, qty: "-0.1001" },
  ]);
  const evidence = await f.read();
  expect(evidence.warehouses[1].active).toBe(false);
  expect(evidence.materials[0]).toMatchObject({ factoryOnHand: "8.5000", warehouses: [
    { onHand: "8.6001", unidentifiedBatch: "8.6001" }, { onHand: "-0.1001", unidentifiedBatch: "0" },
  ] });
});
it("risk categories may overlap; multiple bins and duplicate WO lines never multiply stock", async () => {
  const f = await fixture(), warehouse = await f.warehouse();
  const [expired, undated, wrongSku] = await db.insert(s.batches).values([
    { skuId: f.material.id, batchNo: "expired", expiryDate: "2000-01-01" },
    { skuId: f.material.id, batchNo: "undated" },
    { skuId: f.product.id, batchNo: "wrong-sku", expiryDate: "2000-01-01" },
  ]).returning();
  await db.insert(s.stockBalances).values([
    { skuId: f.material.id, warehouseId: warehouse.id, batchId: expired.id, qty: "10" },
    { skuId: f.material.id, warehouseId: warehouse.id, batchId: undated.id, qty: "3" },
    { skuId: f.material.id, warehouseId: warehouse.id, batchId: wrongSku.id, qty: "2" },
    { skuId: f.material.id, warehouseId: warehouse.id, qty: "1" },
  ]);
  const bins = await db.insert(s.bins).values([
    { warehouseId: warehouse.id, code: "Q1", kind: "quarantine" },
    { warehouseId: warehouse.id, code: "Q2", kind: "quarantine", active: false },
    { warehouseId: warehouse.id, code: "N1", kind: "normal" },
  ]).returning();
  await db.insert(s.binBalances).values(bins.map((b, i) => ({ binId: b.id, skuId: f.material.id, batchId: expired.id, qty: String(i + 1) })));
  await db.insert(s.woLines).values({ ...f.lineValues, woId: f.wo.id });
  const evidence = await f.read();
  expect(evidence.materials).toHaveLength(1);
  expect(evidence.materials[0]).toMatchObject({ required: "200.0000", factoryOnHand: "16.0000", warehouses: [
    { expired: "10.0000", undatedBatch: "3.0000", unidentifiedBatch: "3.0000", quarantine: "3.0000" },
  ] });
  expect(JSON.stringify(evidence)).not.toMatch(/availableQty|allocatedQty/);
});
it.each([
  { instant: "2026-09-13T15:59:59.999Z", day: "2026-09-13", expired: "2.0000", blocked: false },
  { instant: "2026-09-13T16:00:00.000Z", day: "2026-09-14", expired: "5.1250", blocked: true },
])("Shanghai midnight $instant: observation, FEFO and execution agree without netting risk away", async ({ instant, day, expired, blocked }) => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(instant));
  const f = await fixture(), warehouse = await f.warehouse();
  const [old, due, later, unknown, negative, wrong] = await db.insert(s.batches).values([
    { skuId: f.material.id, batchNo: `${f.code}-OLD`, expiryDate: "2026-09-12" },
    { skuId: f.material.id, batchNo: `${f.code}-DUE`, expiryDate: "2026-09-14" },
    { skuId: f.material.id, batchNo: `${f.code}-LATER`, expiryDate: "2026-09-15" },
    { skuId: f.material.id, batchNo: `${f.code}-UNKNOWN` },
    { skuId: f.material.id, batchNo: `${f.code}-NEGATIVE`, expiryDate: "2026-09-12" },
    { skuId: f.product.id, batchNo: `${f.code}-WRONG`, expiryDate: "2026-09-12" },
  ]).returning();
  await db.insert(s.stockBalances).values([
    { batchId: old.id, qty: "2" }, { batchId: due.id, qty: "3.125" }, { batchId: later.id, qty: "4" },
    { batchId: unknown.id, qty: "5" }, { batchId: negative.id, qty: "-1" }, { batchId: wrong.id, qty: "6" },
  ].map(row => ({ ...row, skuId: f.material.id, warehouseId: warehouse.id })));
  const before = { audits: await db.select().from(s.auditLogs), ledger: await db.select().from(s.stockLedger), balances: await db.select().from(s.stockBalances) };
  const evidence = await f.read();
  expect(evidence.businessDate).toBe(day);
  expect(evidence.materials[0]).toMatchObject({ factoryOnHand: "19.1250", warehouses: [{ expired, undatedBatch: "5.0000", unidentifiedBatch: "6.0000" }] });
  const lot = { batchId: due.id, batchNo: due.batchNo, expiryDate: due.expiryDate, qty: "3.125" };
  expect(allocateFefo([lot], "1", evidence.businessDate).expiredLots).toBe(blocked ? 1 : 0);
  const execution = await db.transaction(tx => outboundBatchBlock(tx, { sourceDocType: "fl_issue", sourceDocId: 999,
    action: "post", lines: [{ sourceLineId: 1, skuId: f.material.id, warehouseId: warehouse.id, batchId: due.id, qtyDelta: "-1" }] }));
  expect(execution?.code ?? null).toBe(blocked ? "EXPIRED_BATCH" : null);
  expect({ audits: await db.select().from(s.auditLogs), ledger: await db.select().from(s.stockLedger), balances: await db.select().from(s.stockBalances) }).toEqual(before);
});
it("peer WOs are same-factory and same-material only; paused remains explicit, not reserved", async () => {
  const f = await fixture();
  const [peer, paused, draft, completed] = await db.insert(s.woDocs).values([
    { ...f.woValues, docNo: `${f.code}-PEER` },
    { ...f.woValues, docNo: `${f.code}-PAUSE`, isPaused: true },
    { ...f.woValues, docNo: `${f.code}-DRAFT`, status: "draft" },
    { ...f.woValues, docNo: `${f.code}-DONE`, status: "completed" },
  ]).returning();
  await db.insert(s.woLines).values([peer, peer, paused, draft, completed].map(w => ({ ...f.lineValues, woId: w.id })));
  expect((await f.read()).materials[0].peers).toEqual([
    { id: peer.id, docNo: peer.docNo, paused: false, required: "200.0000" },
    { id: paused.id, docNo: paused.docNo, paused: true, required: "100.0000" },
  ]);
});
it("every read gets current data without audit, ledger, stock or reservation mutations", async () => {
  const f = await fixture();
  const audit = await db.select().from(s.auditLogs), ledger = await db.select().from(s.stockLedger);
  const stock = await db.select().from(s.stockBalances);
  expect((await f.read()).woVersion).toBe(f.wo.version);
  await db.update(s.woDocs).set({ version: f.wo.version + 1 }).where(eq(s.woDocs.id, f.wo.id));
  expect((await f.read()).woVersion).toBe(f.wo.version + 1);
  expect(await db.select().from(s.auditLogs)).toEqual(audit);
  expect(await db.select().from(s.stockLedger)).toEqual(ledger);
  expect(await db.select().from(s.stockBalances)).toEqual(stock);
});
it("rejects unsupported role, invalid IDs and missing WOs", async () => {
  const f = await fixture();
  await expect(getKitFactoryEvidence({ ...f.actor, roles: ["warehouse"] }, f.wo.id, db)).rejects.toMatchObject({ status: 403 });
  for (const id of [0, -1, 1.5, NaN, 2_147_483_648]) await expect(getKitFactoryEvidence(f.actor, id, db)).rejects.toMatchObject({ status: 400 });
  await expect(getKitFactoryEvidence(f.actor, 2_147_483_647, db)).rejects.toMatchObject({ status: 404 });
});
