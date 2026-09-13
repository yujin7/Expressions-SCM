import { afterAll, beforeAll, expect, it } from "vitest";
import * as s from "@/db/schema";
import { getJgMaterialBasis } from "@/server/modules/matflow/material-basis";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, actor: typeof s.users.$inferSelect;
let jg: typeof s.jgDocs.$inferSelect, other: typeof s.jgDocs.$inferSelect, mat: number, extra: number, untouched: number;
let own: number, factory: number, sequence = 0;
beforeAll(async () => {
  f = await createTestDb();
  [actor] = await f.db.insert(s.users).values({ name: "物料依据仓管", roles: ["warehouse"] }).returning();
  const [spu] = await f.db.insert(s.spus).values({ code: "BASIS", nameCn: "依据" }).returning();
  const rows = await f.db.insert(s.skus).values(["CP", "MAT", "EXTRA", "NONE"].map((code, i) => ({ code: `BASIS-${code}`, spuId: spu.id, skuType: i ? "raw" as const : "finished" as const, baseUom: "个" }))).returning();
  mat = rows[1].id; extra = rows[2].id; untouched = rows[3].id;
  const [supplier] = await f.db.insert(s.suppliers).values({ code: "BASIS", name: "厂" }).returning();
  const whs = await f.db.insert(s.warehouses).values([{ code: "BASIS-OWN", name: "自有", kind: "raw" }, { code: "BASIS-F", name: "厂仓", kind: "outsource", supplierId: supplier.id }]).returning();
  own = whs[0].id; factory = whs[1].id;
  const [bom] = await f.db.insert(s.boms).values({ productSkuId: rows[0].id, versionNo: "1" }).returning();
  const wos = await f.db.insert(s.woDocs).values(["ONE", "OTHER"].map(code => ({ docNo: `BASIS-${code}`, productSkuId: rows[0].id, supplierId: supplier.id, bomId: bom.id, qty: "1", feeRatePlan: "0", status: "in_progress" as const, createdBy: actor.id }))).returning();
  await f.db.insert(s.woLines).values([
    { woId: wos[0].id, materialSkuId: mat, qtyPer: "1", planLossRatePct: "0", grossReq: "8.6", suggestedQty: "8.6" },
    { woId: wos[0].id, materialSkuId: mat, qtyPer: "1", planLossRatePct: "0", grossReq: "0.1", suggestedQty: "0.1" },
    { woId: wos[0].id, materialSkuId: untouched, qtyPer: "1", planLossRatePct: "0", grossReq: "5", suggestedQty: "5" },
  ]);
  [jg, other] = await f.db.insert(s.jgDocs).values(wos.map(w => ({ docNo: `${w.docNo}-JG`, woId: w.id, productSkuId: rows[0].id, supplierId: supplier.id, qty: "1", feeRateCurrent: "0", status: "in_progress" as const, createdBy: actor.id }))).returning();
});
afterAll(async () => f?.client.close());
async function doc(kind: "fl" | "tl", status: "draft" | "pending" | "completed" | "void", sku: number, qty: string, source = jg.id) {
  const [d] = await f.db.insert(kind === "fl" ? s.flDocs : s.tlDocs).values({ docNo: `BASIS-D${++sequence}`, jgId: source, fromWarehouseId: kind === "fl" ? own : factory, toWarehouseId: kind === "fl" ? factory : own, status, createdBy: actor.id }).returning();
  if (kind === "fl") await f.db.insert(s.flLines).values({ flId: d.id, skuId: sku, qty });
  else await f.db.insert(s.tlLines).values({ tlId: d.id, skuId: sku, qty, reason: "surplus_return" });
  return d;
}
it("merges repeated WO material rows without duplicate editable keys; exact untouched default", async () => {
  const result = await getJgMaterialBasis(actor, jg.id, f.db);
  expect(result.lines).toHaveLength(2);
  expect(result.lines.find(l => l.materialSkuId === mat)).toMatchObject({ grossReq: "8.7000", issuedQty: "0", suggestedIssueQty: "8.7000" });
  expect(result).toMatchObject({ jgId: jg.id, woId: jg.woId, supplierId: jg.supplierId, openDocuments: [] });
  expect(new Date(result.observedAt).getTime()).toBeGreaterThan(0);
});
it("counts only this JG's active documents, exact decimal remainder and no automatic TL credit", async () => {
  await doc("fl", "completed", mat, "8.6"); await doc("tl", "completed", mat, "2");
  await doc("fl", "completed", mat, "999", other.id); await doc("fl", "void", mat, "999");
  const result = await getJgMaterialBasis(actor, jg.id, f.db);
  expect(result.lines.find(l => l.materialSkuId === mat)).toMatchObject({ issuedQty: "8.6000", returnedQty: "2.0000", suggestedIssueQty: "0.1000" });
});
it("keeps approved extra-BOM materials reachable for TL, and never proposes extra issue", async () => {
  await doc("fl", "completed", extra, "3");
  const result = await getJgMaterialBasis(actor, jg.id, f.db);
  expect(result.lines.find(l => l.materialSkuId === extra)).toMatchObject({ grossReq: "0", issuedQty: "3.0000", suggestedIssueQty: "0" });
});
it("open documents are separate evidence and suppress repeated prefill only for their own material", async () => {
  const draft = await doc("fl", "draft", mat, "0.05"); const pending = await doc("fl", "pending", mat, "0.05");
  await doc("tl", "draft", mat, "0.2"); await doc("tl", "pending", mat, "0.3");
  const result = await getJgMaterialBasis(actor, jg.id, f.db);
  expect(result.lines.find(l => l.materialSkuId === mat)).toMatchObject({ draftIssueQty: "0.0500", pendingIssueQty: "0.0500", draftReturnQty: "0.2000", pendingReturnQty: "0.3000", suggestedIssueQty: "0", issuedQty: "8.6000" });
  expect(result.lines.find(l => l.materialSkuId === untouched)?.suggestedIssueQty).toBe("5.0000");
  expect(result.openDocuments).toEqual(expect.arrayContaining([{ kind: "fl", id: draft.id, docNo: draft.docNo, status: "draft" }, { kind: "fl", id: pending.id, docNo: pending.docNo, status: "pending" }]));
  expect(await f.db.select().from(s.stockLedger)).toEqual([]);
  expect(await f.db.select().from(s.auditLogs)).toEqual([]);
});
it("sibling JG shares WO totals and open issue links without corrupting this JG return evidence", async () => {
  const [sibling] = await f.db.insert(s.jgDocs).values({ docNo: "BASIS-SIBLING", woId: jg.woId, productSkuId: jg.productSkuId,
    supplierId: jg.supplierId, qty: "0.5", feeRateCurrent: "0", status: "in_progress", batchSeq: 2, createdBy: actor.id }).returning();
  await doc("fl", "completed", untouched, "3", sibling.id);
  await doc("tl", "completed", untouched, "1", sibling.id);
  let result = await getJgMaterialBasis(actor, jg.id, f.db);
  expect(result.lines.find(l => l.materialSkuId === untouched)).toMatchObject({ issuedQty: "0", returnedQty: "0", woIssuedQty: "3.0000", suggestedIssueQty: "2.0000" });
  const pending = await doc("fl", "pending", untouched, "2", sibling.id);
  result = await getJgMaterialBasis(actor, jg.id, f.db);
  expect(result.lines.find(l => l.materialSkuId === untouched)).toMatchObject({ pendingIssueQty: "0", woPendingIssueQty: "2.0000", suggestedIssueQty: "0" });
  expect(result.woOpenIssues).toContainEqual({ kind: "fl", id: pending.id, docNo: pending.docNo, status: "pending", jgId: sibling.id, jgDocNo: sibling.docNo });
  expect(result.openDocuments.some(d => d.id === pending.id && d.kind === "fl")).toBe(false);
});
it.each([0, -1, 1.5, 2147483648, NaN])("rejects invalid source %s", async id => {
  await expect(getJgMaterialBasis(actor, id, f.db)).rejects.toMatchObject({ status: 400 });
});
it("missing is not empty, and other roles cannot read warehouse creation evidence", async () => {
  await expect(getJgMaterialBasis(actor, 999999, f.db)).rejects.toMatchObject({ status: 404 });
  await expect(getJgMaterialBasis({ ...actor, roles: ["ops"] }, jg.id, f.db)).rejects.toMatchObject({ status: 403 });
});
