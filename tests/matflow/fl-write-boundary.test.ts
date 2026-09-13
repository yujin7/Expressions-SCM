import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { createFl, submitFl, updateFl } from "@/server/modules/matflow/fl";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, product: number, material: number, supplier: number, warehouse: number, wo: number, maker: number, seq = 0;
beforeAll(async () => {
  f = await createTestDb();
  const [u] = await f.db.insert(s.users).values({ name: "另一制单人", roles: ["warehouse"] }).returning(); maker = u.id;
  const [spu] = await f.db.insert(s.spus).values({ code: "FL-WRITE", nameCn: "发料写入测试" }).returning();
  const rows = await f.db.insert(s.skus).values([
    { code: "FL-WRITE-CP", spuId: spu.id, skuType: "finished", baseUom: "支" },
    { code: "FL-WRITE-YL", spuId: spu.id, skuType: "raw", baseUom: "kg" },
  ]).returning(); product = rows[0].id; material = rows[1].id;
  const [sup] = await f.db.insert(s.suppliers).values({ code: "FL-WRITE", name: "加工厂" }).returning(); supplier = sup.id;
  const whs = await f.db.insert(s.warehouses).values([
    { code: "FL-WRITE-OWN", name: "自有仓", kind: "raw" },
    { code: "FL-WRITE-OUT", name: "委外仓", kind: "outsource", supplierId: supplier },
  ]).returning(); warehouse = whs[0].id;
  const [bom] = await f.db.insert(s.boms).values({ productSkuId: product, versionNo: "1" }).returning();
  const [order] = await f.db.insert(s.woDocs).values({ docNo: "FL-WRITE-WO", productSkuId: product, supplierId: supplier, bomId: bom.id, qty: "10", feeRatePlan: "1", createdBy: maker }).returning(); wo = order.id;
});
afterAll(async () => f?.client.close());
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const [u] = await f.db.insert(s.users).values({ name: `发料测试${++seq}`, roles: ["warehouse"] }).returning();
  const user = { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
  const [jg] = await f.db.insert(s.jgDocs).values({ docNo: `FL-WRITE-JG-${seq}`, woId: wo, batchSeq: seq, productSkuId: product,
    supplierId: supplier, qty: "10", feeRateCurrent: "1", status: "in_progress", createdBy: maker }).returning();
  const input = { jgId: jg.id, fromWarehouseId: warehouse, lines: [{ skuId: material, qty: "1.2345" }] };
  return { user, jg, input };
}
async function snapshot() {
  return { docs: await f.db.select().from(s.flDocs), lines: await f.db.select().from(s.flLines),
    counters: await f.db.select().from(s.docCounters), audit: await f.db.select().from(s.auditLogs),
    ledger: await f.db.select().from(s.stockLedger), balances: await f.db.select().from(s.stockBalances) };
}
for (const kind of ["create", "submit", "update"] as const) {
  it(`${kind}: audit failure rolls back header, lines, number, status and version; deliberate retry commits once`, async () => {
    const a = await setup(), doc = kind !== "create" ? await createFl(a.user, a.input, f.db) : null;
    const run = () => doc ? kind === "update" ? updateFl(a.user, doc.id, { version: doc.version, fromWarehouseId: doc.fromWarehouseId, toWarehouseId: doc.toWarehouseId, lines: [{ skuId: material, qty: "1.2345", batchId: null }] }, f.db) : submitFl(a.user, doc.id, doc.version, f.db) : createFl(a.user, a.input, f.db);
    const before = await snapshot();
    vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("FL audit unavailable"));
    await expect(run()).rejects.toThrow("FL audit unavailable");
    expect(await snapshot()).toEqual(before);
    const saved = await run(); expect(saved.status).toBe(kind === "submit" ? "pending" : "draft");
    expect((await f.db.select().from(s.flLines).where(eq(s.flLines.flId, saved.id)))[0].qty).toBe("1.2345");
    expect(await f.db.select().from(s.stockLedger)).toHaveLength(0);
    if (doc) {
      await expect(run()).rejects.toMatchObject({ status: 409 });
      expect(await f.db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "fl"), eq(s.auditLogs.entityId, doc.id), eq(s.auditLogs.action, kind === "update" ? "update_draft" : "submit")))).toHaveLength(1);
    }
  });
  it.each(["disabled", "session", "role"])(`${kind}: current %s restriction overrides stale caller identity`, async reason => {
    const a = await setup(), doc = kind !== "create" ? await createFl(a.user, a.input, f.db) : null;
    if (doc && reason === "role") await f.db.update(s.flDocs).set({ createdBy: maker }).where(eq(s.flDocs.id, doc.id));
    await f.db.update(s.users).set(reason === "disabled" ? { active: false } : reason === "session"
      ? { sessionVersion: a.user.sessionVersion + 1 } : { roles: ["ops"] }).where(eq(s.users.id, a.user.id));
    const before = await snapshot();
    await expect(doc ? kind === "update" ? updateFl(a.user, doc.id, { version: doc.version, fromWarehouseId: doc.fromWarehouseId, toWarehouseId: doc.toWarehouseId, lines: [{ skuId: material, qty: "1", batchId: null }] }, f.db) : submitFl(a.user, doc.id, doc.version, f.db) : createFl(a.user, a.input, f.db)).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(["draft", "pending", "completed", "closed", "void"] as const)(`${kind}: JG %s cannot introduce another issue request`, async status => {
    const a = await setup(), doc = kind !== "create" ? await createFl(a.user, a.input, f.db) : null;
    await f.db.update(s.jgDocs).set({ status }).where(eq(s.jgDocs.id, a.jg.id));
    const before = await snapshot();
    await expect(doc ? kind === "update" ? updateFl(a.user, doc.id, { version: doc.version, fromWarehouseId: doc.fromWarehouseId, toWarehouseId: doc.toWarehouseId, lines: [{ skuId: material, qty: "1", batchId: null }] }, f.db) : submitFl(a.user, doc.id, doc.version, f.db) : createFl(a.user, a.input, f.db)).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  });
}
it("submission preserves active creator authority, denies unrelated ops, and cannot resurrect a terminal FL", async () => {
  const a = await setup(), doc = await createFl(a.user, a.input, f.db);
  await f.db.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, a.user.id));
  expect(await submitFl(a.user, doc.id, 1, f.db)).toMatchObject({ status: "pending", version: 2 });
  const b = await setup(), other = await createFl(b.user, b.input, f.db);
  await expect(submitFl(a.user, other.id, 1, f.db)).rejects.toMatchObject({ status: 403 });
  await f.db.update(s.flDocs).set({ status: "void" }).where(eq(s.flDocs.id, other.id));
  const before = await snapshot();
  await expect(submitFl(b.user, other.id, 1, f.db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
});
