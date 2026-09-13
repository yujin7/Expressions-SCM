import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { listTlReturnLots, resolveTlPhysicalLines } from "@/server/modules/matflow/return-lots";
import { createTlSchema } from "@/server/modules/matflow/schemas";

let f: Awaited<ReturnType<typeof createTestDb>>, skuId: number, otherSku: number, warehouseId: number, jgId: number, user: typeof s.users.$inferSelect;
let old: number, fresh: number;
beforeAll(async () => {
  f = await createTestDb(); const db = f.db;
  [user] = await db.insert(s.users).values({ name: "RETURN-LOTS", roles: ["warehouse"] }).returning();
  const [spu] = await db.insert(s.spus).values({ code: "RETURN-LOTS", nameCn: "合成" }).returning();
  const skus = await db.insert(s.skus).values(["A", "B"].map(code => ({ code: `RETURN-${code}`, spuId: spu.id, baseUom: "kg", skuType: "raw" as const }))).returning();
  [skuId, otherSku] = skus.map(x => x.id);
  const [supplier] = await db.insert(s.suppliers).values({ code: "RETURN-LOTS", name: "合成" }).returning();
  const [warehouse] = await db.insert(s.warehouses).values({ code: "RETURN-LOTS", name: "合成", kind: "outsource", supplierId: supplier.id }).returning(); warehouseId = warehouse.id;
  const [bom] = await db.insert(s.boms).values({ productSkuId: skuId, versionNo: "1" }).returning();
  const [wo] = await db.insert(s.woDocs).values({ docNo: "RETURN-LOTS", productSkuId: skuId, qty: "10", bomId: bom.id, supplierId: supplier.id, feeRatePlan: "1", createdBy: user.id }).returning();
  const [jg] = await db.insert(s.jgDocs).values({ docNo: "RETURN-LOTS", woId: wo.id, productSkuId: skuId, qty: "10", supplierId: supplier.id, feeRateCurrent: "1", createdBy: user.id, status: "in_progress" }).returning(); jgId = jg.id;
  const lots = await db.insert(s.batches).values([{ skuId, batchNo: "EXPIRED", expiryDate: "2000-01-01" }, { skuId, batchNo: "FRESH", expiryDate: "2999-01-01" }, { skuId: otherSku, batchNo: "WRONG" }]).returning();
  [old, fresh] = lots.map(x => x.id);
  await db.insert(s.stockBalances).values([{ skuId, warehouseId, batchId: old, qty: "4.1234" }, { skuId, warehouseId, batchId: fresh, qty: "20" }, { skuId, warehouseId, batchId: null, qty: "2" }, { skuId, warehouseId, batchId: lots[2].id, qty: "99" }]);
  await db.insert(s.sysParams).values({ scope: "global", key: "batch_posting_enabled", value: "1" });
});
afterAll(async () => f?.client.close());
it("omission never chooses fresh stock instead of the actual defective lot", async () => {
  await expect(resolveTlPhysicalLines(f.db, warehouseId, [{ skuId, qty: "1" }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("实物") });
});
it("preserves expired, fresh and explicitly unbatched physical lines together", async () => {
  const lines = [{ skuId, batchId: old, qty: "4.1234", reason: "defect_exchange" }, { skuId, batchId: fresh, qty: "1", reason: "surplus_return" }, { skuId, batchId: null, qty: "2", reason: "surplus_return" }];
  expect(await resolveTlPhysicalLines(f.db, warehouseId, lines)).toEqual(lines.map(l => ({ ...l, qty: l.qty.includes(".") ? l.qty : `${l.qty}.0000` })));
});
it("aggregates same-lot requests; shortage cannot borrow from another lot", async () => {
  await expect(resolveTlPhysicalLines(f.db, warehouseId, [{ skuId, batchId: old, qty: "3" }, { skuId, batchId: old, qty: "2" }])).rejects.toMatchObject({ status: 409 });
  await expect(resolveTlPhysicalLines(f.db, warehouseId, [{ skuId, batchId: null, qty: "3" }])).rejects.toMatchObject({ status: 409 });
});
it("wrong SKU and missing lot rejected even with migration gate off", async () => {
  await f.db.update(s.sysParams).set({ value: "0" }).where(eq(s.sysParams.key, "batch_posting_enabled"));
  try {
    await expect(resolveTlPhysicalLines(f.db, warehouseId, [{ skuId: otherSku, batchId: old, qty: "1" }])).rejects.toMatchObject({ status: 400 });
    await expect(resolveTlPhysicalLines(f.db, warehouseId, [{ skuId, batchId: 99999, qty: "1" }])).rejects.toMatchObject({ status: 400 });
    expect(await resolveTlPhysicalLines(f.db, warehouseId, [{ skuId, qty: "1" }])).toEqual([{ skuId, qty: "1.0000", batchId: null }]);
  } finally { await f.db.update(s.sysParams).set({ value: "1" }).where(eq(s.sysParams.key, "batch_posting_enabled")); }
});
const query = () => ({ jgId, warehouseId, skuId, q: "", page: 1, pageSize: 2 });
it("options include actual expired and legacy stock, exclude wrong identity, paginate and hydrate exactly", async () => {
  const first = await listTlReturnLots(user, query(), f.db);
  expect(first.total).toBe(3); expect(first.rows).toHaveLength(2); expect(first.rows[0]).toMatchObject({ batchId: old, availableQty: "4.1234" });
  const next = await listTlReturnLots(user, { ...query(), page: 2 }, f.db); expect(next.rows[0].batchId).toBeNull();
  expect((await listTlReturnLots(user, { ...query(), ids: [String(fresh)] }, f.db)).rows).toMatchObject([{ batchId: fresh }]);
  expect((await listTlReturnLots(user, { ...query(), ids: ["unbatched"] }, f.db)).rows).toMatchObject([{ batchId: null }]);
  expect((await listTlReturnLots(user, { ...query(), ids: [] }, f.db)).total).toBe(0);
  expect((await listTlReturnLots(user, { ...query(), q: "EXPIRED" }, f.db)).total).toBe(1);
});
it("options enforce role, source state and actual factory warehouse", async () => {
  await expect(listTlReturnLots({ ...user, roles: ["ops"] }, query(), f.db)).rejects.toMatchObject({ status: 403 });
  await expect(listTlReturnLots(user, { ...query(), warehouseId: warehouseId + 999 }, f.db)).rejects.toMatchObject({ status: 409 });
  await f.db.update(s.jgDocs).set({ status: "draft" }).where(eq(s.jgDocs.id, jgId));
  try { await expect(listTlReturnLots(user, query(), f.db)).rejects.toMatchObject({ status: 409 }); }
  finally { await f.db.update(s.jgDocs).set({ status: "in_progress" }).where(eq(s.jgDocs.id, jgId)); }
});
it.each(["0.00001", "1.00001", "10000000000", "-1"])("create does not silently round or drop %s", qty => {
  expect(createTlSchema.safeParse({ jgId, toWarehouseId: warehouseId, lines: [{ skuId, qty, reason: "surplus_return" }] }).success).toBe(false);
});
