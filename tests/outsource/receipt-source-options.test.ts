import { beforeAll, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { listPos } from "@/server/modules/outsource/po";
import { getJg, listJgs } from "@/server/modules/outsource/jg";
import * as s from "@/db/schema";

let db: TestDb, poId: number, jgId: number, closedPo: number, closedJg: number;
beforeAll(async () => {
  ({ db } = await createTestDb());
  const [u] = await db.insert(s.users).values({ name: "receipt-options", roles: ["warehouse"] }).returning();
  const [sup] = await db.insert(s.suppliers).values({ code: "RO", name: "候选加工厂", kinds: ["processor"] }).returning();
  const [spu] = await db.insert(s.spus).values({ code: "RO", nameCn: "合成" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "RO", name: "合成成品", spuId: spu.id, skuType: "finished", baseUom: "盒" }).returning();
  const [bom] = await db.insert(s.boms).values({ productSkuId: sku.id, versionNo: "RO" }).returning();
  const [wo] = await db.insert(s.woDocs).values({ docNo: "WO-RO", productSkuId: sku.id, qty: "10", supplierId: sup.id, feeRatePlan: "1", bomId: bom.id, createdBy: u.id }).returning();
  const statuses = ["approved", "completed", ...Array.from({ length: 1005 }, () => "draft")] as ("approved" | "completed" | "draft")[];
  const pos = await db.insert(s.poDocs).values(statuses.map((status, i) => ({ docNo: `PO-RO-${i}`, supplierId: sup.id, createdBy: u.id, status }))).returning();
  const jgs = await db.insert(s.jgDocs).values(statuses.map((status, i) => ({ docNo: `JG-RO-${i}`, woId: wo.id, batchSeq: i + 1, supplierId: sup.id, productSkuId: sku.id, qty: "10", feeRateCurrent: "1", createdBy: u.id, status }))).returning();
  poId = pos[0].id; closedPo = pos[1].id; jgId = jgs[0].id; closedJg = jgs[1].id;
});
it.each(["po", "jg"])("%s filters receipt eligibility before paging past 1005 newer drafts", async kind => {
  const result = await (kind === "po" ? listPos : listJgs)("", { page: 1, pageSize: 50, receiptEligible: true }, db);
  expect(result.total).toBe(1); expect(result.rows).toMatchObject([{ id: kind === "po" ? poId : jgId }]);
});
it("PC's unrestricted JG search and exact label lookup reach beyond the old first-page cap", async () => {
  const first = await listJgs("", { page: 1, pageSize: 50 }, db);
  expect(first.total).toBe(1007);
  expect(first.rows).toHaveLength(50);
  expect(first.rows).not.toContainEqual(expect.objectContaining({ id: jgId }));
  expect(await listJgs("JG-RO-0", { page: 1, pageSize: 50 }, db)).toMatchObject({ total: 1, rows: [{ id: jgId }] });
  expect(await listJgs("", { page: 1, pageSize: 50, selectedValues: [jgId] }, db)).toMatchObject({ total: 1, rows: [{ id: jgId }] });
  expect((await listJgs("", { page: 21, pageSize: 50 }, db)).rows).toContainEqual(expect.objectContaining({ id: jgId }));
});
it("return sources include completed JG but exclude drafts before paging and exact selection", async () => {
  const result = await listJgs("", { page: 1, pageSize: 50, returnEligible: true }, db);
  expect(result.total).toBe(2);
  expect(result.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: jgId }), expect.objectContaining({ id: closedJg })]));
  expect(await listJgs("", { page: 9, pageSize: 1, returnEligible: true, selectedValues: [closedJg] }, db))
    .toMatchObject({ total: 1, rows: [{ id: closedJg }] });
});
it("JG list, detail and capacity share the SKU base unit without fabricating progress", async () => {
  const result = await listJgs("", { page: 1, pageSize: 50, selectedValues: [closedJg] }, db);
  expect(result.rows).toMatchObject([{ id: closedJg, status: "completed", inProduction: false, baseUom: "盒", qty: "10.0000" }]);
  const detail = await getJg(closedJg, db);
  expect(detail).toMatchObject({ baseUom: "盒", status: "completed", inProduction: false, capacity: { baseUom: "盒" } });
});
it.each(["po", "jg"])("%s selected identities intersect receipt status and search, ignoring ordinary page offset", async kind => {
  const list = kind === "po" ? listPos : listJgs, id = kind === "po" ? poId : jgId;
  const opts = { page: 9, pageSize: 1, receiptEligible: true, selectedValues: [id, kind === "po" ? closedPo : closedJg] };
  expect(await list("", opts, db)).toMatchObject({ total: 1, rows: [{ id }] });
  expect(await list("NO-MATCH", opts, db)).toMatchObject({ total: 0, rows: [] });
  expect(await list("", { ...opts, selectedValues: [] }, db)).toMatchObject({ total: 0, rows: [] });
});
