import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { generateDocs } from "@/server/modules/outsource/wo";
import { generateDocsSchema } from "@/server/modules/outsource/schemas";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"], actor: SessionUser, seq = 0;
beforeAll(async () => {
  ({ db, client } = await createTestDb());
  [actor] = await db.insert(s.users).values({ name: "合成生成PMC", roles: ["pmc"] }).returning();
});
afterAll(async () => { await client.close(); });
async function fixture() {
  const no = `GEN-SAFE-${++seq}`;
  const [spu] = await db.insert(s.spus).values({ code: no, nameCn: no }).returning();
  const [product, material] = await db.insert(s.skus).values([
    { code: `${no}-FG`, name: "合成成品", spuId: spu.id, skuType: "finished" as const, baseUom: "支" },
    { code: `${no}-MAT`, name: "合成物料", spuId: spu.id, skuType: "packaging" as const, baseUom: "个" },
  ]).returning();
  const [factory, supplier] = await db.insert(s.suppliers).values([{ code: no, name: "合成加工厂" }, { code: `${no}-MAT`, name: "合成材料供应商" }]).returning();
  const [bom] = await db.insert(s.boms).values({ productSkuId: product.id, versionNo: "1", status: "active" }).returning();
  const [wo] = await db.insert(s.woDocs).values({ docNo: `WO-${no}`, status: "approved", productSkuId: product.id, qty: "100", supplierId: factory.id, feeRatePlan: "1", bomId: bom.id, createdBy: actor.id }).returning();
  await db.insert(s.woLines).values({ woId: wo.id, materialSkuId: material.id, qtyPer: "2", grossReq: "200", suggestedQty: "0" });
  const input = { poGroups: [{ supplierId: supplier.id, lines: [{ materialSkuId: material.id, qty: "250.0001", price: "1.25" }] }] };
  return { wo, product, material, factory, supplier, input };
}
const drafts = (woId: number) => db.select().from(s.jgDocs).where(eq(s.jgDocs.woId, woId));

it("initial generation allows explicitly reviewed PO quantities and creates only audited drafts, without requiring receipts", async () => {
  const f = await fixture(), stock = await db.select().from(s.stockLedger);
  const result = await generateDocs(actor, f.wo.id, f.input, db);
  expect(result.pos).toHaveLength(1);
  expect(result.jg).toMatchObject({ woId: f.wo.id, status: "draft", qty: "100.0000", createdBy: actor.id });
  expect(result.pos[0]).toMatchObject({ woId: f.wo.id, supplierId: f.supplier.id, status: "draft" });
  expect((await db.select().from(s.poLines).where(eq(s.poLines.poId, result.pos[0].id)))[0]).toMatchObject({ qty: "250.0001", price: "1.25" });
  expect(await db.select().from(s.jgFeeSegments).where(eq(s.jgFeeSegments.jgId, result.jg.id))).toHaveLength(1);
  expect(await db.select().from(s.stockLedger)).toEqual(stock);
  await expect(generateDocs(actor, f.wo.id, f.input, db)).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(s.poDocs).where(eq(s.poDocs.woId, f.wo.id))).toHaveLength(1);
});
it("zero PO groups intentionally creates one JG draft without a purchase order", async () => {
  const f = await fixture();
  expect((await generateDocs(actor, f.wo.id, { poGroups: [], jg: { qty: "0.0001" } }, db)).pos).toEqual([]);
  expect(await drafts(f.wo.id)).toMatchObject([{ qty: "0.0001" }]);
});
it.each(["paused", "blacklisted"] as const)("rechecks the WO factory %s even without a PO for that factory", async status => {
  const f = await fixture();
  await db.update(s.suppliers).set({ status }).where(eq(s.suppliers.id, f.factory.id));
  for (const input of [{ poGroups: [] }, f.input]) await expect(generateDocs(actor, f.wo.id, input, db)).rejects.toMatchObject({ status: 400 });
  expect(await drafts(f.wo.id)).toEqual([]);
});
it("fresh identity rejects revoked roles, disabled accounts and expired sessions", async () => {
  const f = await fixture();
  const [revoked, disabled] = await db.insert(s.users).values([{ name: "撤权", roles: ["warehouse"] }, { name: "停用", roles: ["pmc"], active: false }]).returning();
  await expect(generateDocs({ ...revoked, roles: ["pmc"] }, f.wo.id, {}, db)).rejects.toMatchObject({ status: 403 });
  await expect(generateDocs(disabled, f.wo.id, {}, db)).rejects.toMatchObject({ status: 403 });
  await expect(generateDocs({ ...actor, sessionVersion: 999 }, f.wo.id, {}, db)).rejects.toMatchObject({ status: 401 });
  expect(await drafts(f.wo.id)).toEqual([]);
});
it("rejects invalid IDs, inactive or retyped products, and closed WO", async () => {
  const f = await fixture();
  for (const id of [0, -1, 0.5, 2147483648]) await expect(generateDocs(actor, id, {}, db)).rejects.toMatchObject({ status: 400 });
  await expect(generateDocs(actor, 2147483647, {}, db)).rejects.toMatchObject({ status: 404 });
  await db.update(s.skus).set({ active: false }).where(eq(s.skus.id, f.product.id));
  await expect(generateDocs(actor, f.wo.id, {}, db)).rejects.toMatchObject({ status: 400 });
  await db.update(s.skus).set({ active: true, skuType: "raw" }).where(eq(s.skus.id, f.product.id));
  await expect(generateDocs(actor, f.wo.id, {}, db)).rejects.toMatchObject({ status: 400 });
  await db.update(s.woDocs).set({ status: "closed" }).where(eq(s.woDocs.id, f.wo.id));
  await expect(generateDocs(actor, f.wo.id, {}, db)).rejects.toMatchObject({ status: 409 });
});
it("rejects excess JG quantity without creating even the preceding PO", async () => {
  const f = await fixture();
  await expect(generateDocs(actor, f.wo.id, { ...f.input, jg: { qty: "100.0001" } }, db)).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(s.poDocs).where(eq(s.poDocs.woId, f.wo.id))).toEqual([]);
});
it("JG audit failure rolls back PO, JG, fee segment, both number counters and PO audit", async () => {
  const f = await fixture();
  const counters = await db.select().from(s.docCounters), segments = await db.select().from(s.jgFeeSegments), events = await db.select().from(s.auditLogs);
  const original = audit.writeAudit;
  const fail = vi.spyOn(audit, "writeAudit").mockImplementation(async (tx, event) => {
    if (event.entity === "jg") throw Error("synthetic JG audit failure");
    return original(tx, event);
  });
  try { await expect(generateDocs(actor, f.wo.id, f.input, db)).rejects.toThrow("audit failure"); }
  finally { fail.mockRestore(); }
  expect(await drafts(f.wo.id)).toEqual([]);
  expect(await db.select().from(s.poDocs).where(eq(s.poDocs.woId, f.wo.id))).toEqual([]);
  expect(await db.select().from(s.docCounters)).toEqual(counters);
  expect(await db.select().from(s.jgFeeSegments)).toEqual(segments);
  expect(await db.select().from(s.auditLogs)).toEqual(events);
  expect((await generateDocs(actor, f.wo.id, f.input, db)).jg.status).toBe("draft");
});
it.each(["0.00001", "10000000000", "1.00001", "-1", "NaN", "1e20"])("rejects unrepresentable quantity %s before any write", value => {
  expect(generateDocsSchema.safeParse({ jg: { qty: value } }).success).toBe(false);
  for (const field of ["qty", "uomFactor"]) expect(generateDocsSchema.safeParse({ poGroups: [{ supplierId: 1, lines: [{ materialSkuId: 1, qty: "1", price: "1", [field]: value }] }] }).success).toBe(false);
});
it("validates price/tax storage precision and does not silently drop empty purchase groups", () => {
  for (const extra of [{ price: "0.001" }, { price: "1000000000000" }, { taxRatePct: "1000" }, { taxRatePct: "0.001" }]) expect(generateDocsSchema.safeParse({ poGroups: [{ supplierId: 1, lines: [{ materialSkuId: 1, qty: "1", price: "1", ...extra }] }] }).success).toBe(false);
  expect(generateDocsSchema.safeParse({ poGroups: [{ supplierId: 1, lines: [] }] }).success).toBe(false);
});
