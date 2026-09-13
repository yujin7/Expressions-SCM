import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/inventory/fefo-suggest/route";
import { createTestDb, type TestDb } from "../helpers/db";
import { batches, reviewItems, skus, spus, stockBalances, sysParams, warehouses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ApiError } from "@/server/modules/master/common";
const auth = vi.hoisted(() => vi.fn());
let db: TestDb, skuId: number, warehouseId: number, otherWarehouseId: number, batchId: number;
vi.mock("@/db", () => ({ getDbAsync: () => Promise.resolve(db) }));
vi.mock("@/server/modules/master/common", async original => ({ ...await original<typeof import("@/server/modules/master/common")>(), guardRead: auth }));
beforeAll(async () => {
  ({ db } = await createTestDb());
  const [spu] = await db.insert(spus).values({ code: "FEFO-PREVIEW", nameCn: "核对" }).returning();
  const [sku] = await db.insert(skus).values({ code: "FEFO-PREVIEW", spuId: spu.id, skuType: "raw", baseUom: "kg", name: "精确小数原料" }).returning(); skuId = sku.id;
  const wh = await db.insert(warehouses).values([{ code: "FEFO-PREVIEW", name: "核对仓", kind: "raw" }, { code: "FEFO-OTHER", name: "另一仓", kind: "raw" }]).returning(); warehouseId = wh[0].id; otherWarehouseId = wh[1].id;
  const [batch] = await db.insert(batches).values({ batchNo: "EXACT-LOT", skuId, expiryDate: "2099-12-31" }).returning(); batchId = batch.id;
  await db.insert(stockBalances).values({ skuId, warehouseId, batchId, qty: "5" });
  await db.insert(sysParams).values({ key: "batch_posting_enabled", value: "1", note: "合成验证" }).onConflictDoUpdate({ target: [sysParams.scope, sysParams.key], set: { value: "1" } });
});
beforeEach(() => { auth.mockReset().mockResolvedValue({ id: 1, roles: ["warehouse"] }); });
const request = (query: string) => new NextRequest(`http://localhost/api/inventory/fefo-suggest?skuId=${skuId}&warehouseId=${warehouseId}&${query}`);
it("uses the existing exact decimal authority for duplicate SKU lines, without writes", async () => {
  const before = await db.select().from(stockBalances); const response = await GET(request("qty=0.1&qty=0.2"));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ skuId, warehouseId, sourceQuantities: ["0.1", "0.2"], sourceBatchIds: [null, null], requestedQty: "0.3000", mode: "automatic", allocations: [{ qty: "0.3000", batchId }] });
  expect(await db.select().from(stockBalances)).toEqual(before);
});
it.each(["", "qty=0", "qty=-1", "qty=1e3", "qty=NaN", "qty=0.00001", "qty=10000000000", "qty=0.1&qty=bad"])("invalid quantity request stays 400 (%s)", async query => {
  expect((await GET(request(query))).status).toBe(400);
});
it("too many rows is bounded", async () => { expect((await GET(request(Array.from({ length: 1001 }, () => "qty=1").join("&")))).status).toBe(400); });
it("auth runs before input parsing", async () => { auth.mockRejectedValue(new ApiError(401, "未登录")); expect((await GET(request("qty=bad"))).status).toBe(401); });
it("single-value compatibility normalizes quantity but keeps original decimal input identity", async () => {
  expect(await (await GET(request("qty=1.2500"))).json()).toMatchObject({ requestedQty: "1.2500", sourceQuantities: ["1.2500"], shortBy: "0.0000" });
});
it("another warehouse cannot borrow this warehouse's lots", async () => {
  const r = await GET(new NextRequest(`http://localhost/api/inventory/fefo-suggest?skuId=${skuId}&warehouseId=${otherWarehouseId}&qty=1`));
  expect(await r.json()).toMatchObject({ warehouseId: otherWarehouseId, allocations: [], batchCoverage: false });
});
it("explicit physical lots use the existing allocation validator and remain explicit", async () => {
  const response = await GET(request(`qty=0.1&qty=0.2&batchId=${batchId}&batchId=${batchId}`)); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ mode: "explicit", sourceBatchIds: [batchId, batchId], requestedQty: "0.3000", allocations: [{ batchId, qty: "0.3000" }] });
});
it("explicit overdraw is not shown as a successful empty preview", async () => { expect((await GET(request(`qty=6&batchId=${batchId}`))).status).toBe(409); });
it("wrong lot identity and mixed automatic/explicit lines are rejected", async () => {
  expect((await GET(request("qty=1&batchId=2147483647"))).status).toBe(400);
  expect((await GET(request(`qty=1&qty=2&batchId=${batchId}&batchId=auto`))).status).toBe(400);
  expect((await GET(request(`qty=1&qty=2&batchId=${batchId}`))).status).toBe(400);
});
it("explicit preview cannot bypass expiry by overriding today", async () => {
  expect((await GET(request(`qty=1&batchId=${batchId}&today=2000-01-01`))).status).toBe(400);
});
it("flag turned off withdraws explicit qualification rather than pretending original lots were checked", async () => {
  await db.update(sysParams).set({ value: "0" }).where(eq(sysParams.key, "batch_posting_enabled"));
  try { expect((await GET(request(`qty=1&batchId=${batchId}`))).status).toBe(409); }
  finally { await db.update(sysParams).set({ value: "1" }).where(eq(sysParams.key, "batch_posting_enabled")); }
});
it("expired explicit lots require the same live reviewed-scrap source as creation", async () => {
  const [lot] = await db.insert(batches).values({ batchNo: "EXPIRED-SCRAP", skuId, expiryDate: "2000-01-01" }).returning();
  await db.insert(stockBalances).values({ skuId, warehouseId, batchId: lot.id, qty: "2" });
  const [source] = await db.insert(reviewItems).values({ category: "risk_disposal", status: "open", refKey: "FEFO-PREVIEW", title: "处置决定：报废评审 合成验证" }).returning();
  const query = `qty=1&batchId=${lot.id}`;
  expect((await GET(request(query))).status).toBe(409);
  const approved = await GET(request(`${query}&riskDisposalId=${source.id}`));
  expect(approved.status).toBe(200); expect(await approved.json()).toMatchObject({ riskDisposalId: source.id, mode: "explicit", allocations: [{ batchId: lot.id, qty: "1.0000" }] });
  await db.update(reviewItems).set({ status: "closed" }).where(eq(reviewItems.id, source.id));
  expect((await GET(request(`${query}&riskDisposalId=${source.id}`))).status).toBe(409);
});
it.each([{ refKey: "OTHER", title: "处置决定：报废评审 合成" }, { refKey: "FEFO-PREVIEW", title: "处置决定：调拨 合成" }])("wrong reviewed-scrap identity/decision cannot qualify (%j)", async values => {
  const [source] = await db.insert(reviewItems).values({ category: "risk_disposal", status: "open", ...values }).returning();
  expect((await GET(request(`qty=1&batchId=${batchId}&riskDisposalId=${source.id}`))).status).toBe(409);
});
