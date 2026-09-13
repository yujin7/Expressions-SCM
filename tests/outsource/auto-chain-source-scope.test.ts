import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import * as s from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { previewAutoChain, hookAfterBhApprove } from "@/server/modules/outsource/auto-chain";
import { GET } from "@/app/api/outsource/auto-chain/preview/route";
import { POST } from "@/app/api/outsource/auto-chain/wo/route";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"];
let viewer: SessionUser, actor: SessionUser, ownId: number, sharedId: number, hiddenId: number, skuId: number, channelId: number;
const writes = vi.hoisted(() => ({ create: vi.fn<(...args: unknown[]) => Promise<{ id: number; docNo: string }>>(async () => ({ id: 909, docNo: "WO-SYNTHETIC" })) }));
vi.mock("@/db", () => ({ getDbAsync: async () => db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: async () => actor }));
vi.mock("@/server/modules/outsource/wo", async original => {
  const actual = await original<typeof import("@/server/modules/outsource/wo")>();
  writes.create.mockImplementation(actual.createWo as never);
  return { ...actual, createWo: writes.create };
});
beforeEach(async () => {
  ({ db, client } = await createTestDb());
  const [own, shared, hidden] = await db.insert(s.users).values([
    { name: "范围PMC", roles: ["pmc"] }, { name: "同渠道运营", roles: ["ops"] }, { name: "范围外运营", roles: ["ops"] },
  ]).returning();
  const [channel] = await db.insert(s.channels).values({ code: "AUTO-SCOPE", name: "合成渠道", kind: "platform" }).returning(); channelId = channel.id;
  await db.insert(s.userDataScopes).values([own, shared].map(u => ({ userId: u.id, scopeKind: "channel", targetId: channel.id, createdBy: own.id })));
  const [spu] = await db.insert(s.spus).values({ code: "AUTO-SCOPE", nameCn: "合成范围产品" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "AUTO-SCOPE-FG", name: "合成范围成品", spuId: spu.id, skuType: "finished", baseUom: "盒" }).returning(); skuId = sku.id;
  const [sup] = await db.insert(s.suppliers).values({ code: "AUTO-SCOPE", name: "合成加工厂" }).returning();
  await db.insert(s.boms).values({ productSkuId: sku.id, versionNo: "1", status: "active" });
  await db.insert(s.transitRefs).values({ kind: "oem_map", skuCode: sku.code, supplierId: sup.id, sourceJobId: 1 });
  await db.insert(s.processingFeeRefs).values({ skuId: sku.id, supplierId: sup.id, feeRate: "1.23", effectiveDate: "2026-01-01", source: "manual" });
  const bhs = await db.insert(s.bhDocs).values([own, shared, hidden].map((u, i) => ({ docNo: `BH-AUTO-SCOPE-${i}`, createdBy: u.id, status: "approved" as const }))).returning();
  [ownId, sharedId, hiddenId] = bhs.map(b => b.id);
  await db.insert(s.bhLines).values(bhs.map(b => ({ bhId: b.id, skuId, qty: "9999999999.9999" })));
  viewer = { id: own.id, name: own.name, roles: ["pmc"], isApprover: false, channelScope: [channel.id] };
  actor = viewer; writes.create.mockClear();
});
afterEach(async () => { await client.close(); });

it("preview uses the same own/shared-channel scope before reading BH lines", async () => {
  const before = await db.select().from(s.auditLogs);
  const result = await previewAutoChain(db, viewer);
  expect(result.wos.map(w => w.bhId)).toEqual([ownId, sharedId]);
  expect(result.wos.every(w => w.blockedReason === null)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("BH-AUTO-SCOPE-2");
  expect(await db.select().from(s.auditLogs)).toEqual(before);
});
it("explicit empty scope is own-only; admin and unscoped retain existing access", async () => {
  expect((await previewAutoChain(db, { ...viewer, channelScope: [] })).wos.map(w => w.bhId)).toEqual([ownId]);
  for (const user of [{ ...viewer, channelScope: null }, { ...viewer, roles: ["admin"], channelScope: [] }]) {
    expect((await previewAutoChain(db, user)).wos).toHaveLength(3);
  }
});
it("HTTP preview forwards scope and cannot be cached as shared data", async () => {
  const response = await GET(); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.json()).wos.map((w: { bhId: number }) => w.bhId)).toEqual([ownId, sharedId]);
});
it("unsupported role gets a business refusal instead of an internal-server error", async () => {
  actor = { ...viewer, roles: ["ops"] };
  expect((await GET()).status).toBe(403);
});
it("guessing an out-of-scope BH in generation neither reveals it nor calls the writer", async () => {
  const response = await POST(new NextRequest("http://localhost/api/outsource/auto-chain/wo", { method: "POST", body: JSON.stringify({ bhId: hiddenId, skuId }) }));
  expect(response.status).toBe(404); expect(JSON.stringify(await response.json())).not.toContain("BH-AUTO-SCOPE-2");
  expect(writes.create).not.toHaveBeenCalled();
});
it("allowed generation preserves source decimal strings and private response", async () => {
  const response = await POST(new NextRequest("http://localhost/api/outsource/auto-chain/wo", { method: "POST", body: JSON.stringify({ bhId: sharedId, skuId }) }));
  expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(writes.create).toHaveBeenCalledWith(expect.objectContaining({ id: viewer.id }), expect.objectContaining({ bhId: sharedId, qty: "9999999999.9999", feeRatePlan: "1.23" }), expect.anything());
});
it("approval hook loads persisted scope even without HTTP scope payload", async () => {
  await db.insert(s.sysParams).values({ scope: "global", key: "auto_wo_on_bh", value: "1" }).onConflictDoUpdate({ target: [s.sysParams.scope, s.sysParams.key], set: { value: "1" } });
  await hookAfterBhApprove({ ...viewer, channelScope: undefined }, hiddenId, db);
  expect(writes.create).not.toHaveBeenCalled();
  await hookAfterBhApprove({ ...viewer, channelScope: undefined }, sharedId, db);
  expect(writes.create).toHaveBeenCalledTimes(1);
  expect(writes.create.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({ qty: "9999999999.9999", feeRatePlan: "1.23" }), expect.anything()]);
});
it("changed shared-channel membership removes visibility on the next read", async () => {
  await db.delete(s.userDataScopes).where(eq(s.userDataScopes.targetId, channelId));
  expect((await previewAutoChain(db, viewer)).wos.map(w => w.bhId)).toEqual([ownId]);
});
