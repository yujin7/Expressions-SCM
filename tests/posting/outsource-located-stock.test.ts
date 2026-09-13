import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { getBalance, post } from "@/server/posting";
import { postBinMovement } from "@/server/modules/inventory/bin-operations";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, skuId: number, actor: typeof s.users.$inferSelect, seq = 0;
beforeAll(async () => {
  f = await createTestDb();
  [actor] = await f.db.insert(s.users).values({ name: "定位仓管", roles: ["warehouse"] }).returning();
  const [spu] = await f.db.insert(s.spus).values({ code: "LOCATED-OUT", nameCn: "委外定位保护" }).returning();
  const [sku] = await f.db.insert(s.skus).values({ code: "LOCATED-OUT-MAT", spuId: spu.id, skuType: "raw", baseUom: "kg" }).returning();
  skuId = sku.id;
});
afterAll(async () => f?.client.close());

async function fixture(kind: "normal" | "quarantine", batched: boolean, active = true) {
  const key = ++seq;
  const [destination, source] = await f.db.insert(s.warehouses).values([
    { code: `LOCATED-OWN-${key}`, name: "退回仓", kind: "raw" },
    { code: `LOCATED-OUT-${key}`, name: "加工厂仓", kind: "outsource" },
  ]).returning();
  const batchId = batched ? (await f.db.insert(s.batches).values({ skuId, batchNo: `LOCATED-${key}` }).returning())[0].id : null;
  const [bin] = await f.db.insert(s.bins).values({ warehouseId: source.id, code: "L1", kind }).returning();
  await post(f.db, { sourceDocType: "opening", sourceDocId: key, action: "post",
    lines: [{ sourceLineId: 1, skuId, warehouseId: source.id, batchId, qtyDelta: "100" }] });
  await postBinMovement(actor, { warehouseId: source.id, skuId, batchId, toBinId: bin.id, qty: "90",
    operation: kind === "quarantine" ? "quarantine" : "locate", reason: "核对定位保护", idempotencyKey: `located-out-${key}` }, f.db);
  if (!active) await f.db.update(s.bins).set({ active: false }).where(eq(s.bins.id, bin.id));
  const event = (qty: string) => ({ sourceDocType: "tl_return", sourceDocId: key, action: "post", lines: [
    // Destination sorts first, proving rollback also removes an already-applied positive leg.
    { sourceLineId: -1, skuId, warehouseId: destination.id, batchId, qtyDelta: qty },
    { sourceLineId: 1, skuId, warehouseId: source.id, batchId, qtyDelta: `-${qty}` },
  ] });
  return { source, destination, batchId, event, bin };
}
async function snapshot() {
  return { balances: await f.db.select().from(s.stockBalances), ledger: await f.db.select().from(s.stockLedger),
    bins: await f.db.select().from(s.binBalances), movements: await f.db.select().from(s.binMovements), audit: await f.db.select().from(s.auditLogs) };
}

it.each([
  ["normal", false, true], ["quarantine", false, true],
  ["normal", true, true], ["quarantine", true, true], ["quarantine", true, false],
] as const)("%s bin, batch=%s, active=%s: larger outbound cannot bypass the same located-stock refusal", async (kind, batched, active) => {
  const x = await fixture(kind, batched, active), before = await snapshot();
  for (const qty of ["20", "100", "100.0001", "101"]) {
    await expect(post(f.db, x.event(qty))).rejects.toMatchObject({ code: "LOCATED_STOCK" });
    expect(await snapshot()).toEqual(before);
  }
  expect(await post(f.db, x.event("10"))).toEqual({ posted: true });
  expect(await getBalance(f.db, skuId, x.source.id, x.batchId)).toBe("90.0000");
  const done = await snapshot();
  expect(await post(f.db, x.event("10"))).toEqual({ posted: false });
  expect(await snapshot()).toEqual(done);
});

it("without located stock, factory advances still allow negative balances and replenishment can repair them", async () => {
  const [wh] = await f.db.insert(s.warehouses).values({ code: "LOCATED-ADVANCE", name: "垫料仓", kind: "outsource" }).returning();
  for (const [id, qty] of [[9001, "-6.5"], [9002, "-0.1"], [9003, "2"]] as const) {
    expect(await post(f.db, { sourceDocType: "sh_outsource_in", sourceDocId: id, action: "post",
      lines: [{ sourceLineId: 1, skuId, warehouseId: wh.id, qtyDelta: qty }] })).toEqual({ posted: true });
  }
  expect(await getBalance(f.db, skuId, wh.id)).toBe("-4.6000");
});

it("after explicit normal-bin unlocation, the original blocked request can be retried without duplicate legs", async () => {
  const x = await fixture("normal", false);
  await expect(post(f.db, x.event("101"))).rejects.toMatchObject({ code: "LOCATED_STOCK" });
  await postBinMovement(actor, { warehouseId: x.source.id, skuId, fromBinId: x.bin.id, qty: "90", operation: "unlocate",
    reason: "核对后取消普通库位定位", idempotencyKey: "located-unlocate-retry" }, f.db);
  expect(await post(f.db, x.event("101"))).toEqual({ posted: true });
  expect(await getBalance(f.db, skuId, x.source.id)).toBe("-1.0000");
  expect(await getBalance(f.db, skuId, x.destination.id)).toBe("101.0000");
});
