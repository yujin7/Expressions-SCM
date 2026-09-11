import { beforeAll, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { batches, skus, spus, warehouses, stockDocs } from "@/db/schema";
import { traceBatch } from "@/server/modules/inventory/batch-trace";
import { post } from "@/server/posting";

let db: TestDb;
beforeAll(async () => {
  ({ db } = await createTestDb());
  const [spu] = await db.insert(spus).values({ code: "TRACE-ALL", nameCn: "全量追溯验证" }).returning();
  const [sku] = await db.insert(skus).values({ code: "TRACE-ALL", spuId: spu.id, name: "测试精华", skuType: "finished", baseUom: "瓶" }).returning();
  const [wh] = await db.insert(warehouses).values({ code: "TRACE-ALL", name: "测试仓", kind: "finished" }).returning();
  const [batch] = await db.insert(batches).values({ skuId: sku.id, batchNo: "LOT-ALL" }).returning();
  const base = { skuId: sku.id, warehouseId: wh.id, batchId: batch.id };
  await db.insert(stockDocs).values({ id: 411, docNo: "CK-TRACE-411", subtype: "sales_out", createdBy: 1 });
  await post(db, { sourceDocType: "opening", sourceDocId: 410, action: "post", occurredAt: new Date("2026-09-01T12:00:00Z"), lines: [{ ...base, sourceLineId: 1, qtyDelta: "10" }] });
  await post(db, { sourceDocType: "sales_out", sourceDocId: 411, action: "post", occurredAt: new Date("2026-09-02T12:00:00Z"), lines: [{ ...base, sourceLineId: 1, qtyDelta: "-1" }] });
  await post(db, { sourceDocType: "opening", sourceDocId: 412, action: "post", occurredAt: new Date("2026-09-03T18:00:00Z"), lines: Array.from({ length: 201 }, (_, i) => ({ ...base, sourceLineId: i + 1, qtyDelta: "0.0001" })) });
  const [adjustment] = await db.insert(batches).values({ skuId: sku.id, batchNo: "LOT-ADJUST" }).returning();
  await post(db, { sourceDocType: "opening", sourceDocId: 413, action: "post", lines: [{ ...base, batchId: adjustment.id, sourceLineId: 1, qtyDelta: "2" }] });
  await post(db, { sourceDocType: "count_adjust", sourceDocId: 414, action: "post", lines: [{ ...base, batchId: adjustment.id, sourceLineId: 1, qtyDelta: "-1" }] });
});

it("outbound evidence beyond the first 200 rows still informs full-batch coverage", async () => {
  const result = await traceBatch("TRACE-ALL", "LOT-ALL", db);
  expect(result.coverage.outboundTraceable).toBe(true);
});
it("all rows remain reachable in stable, bounded pages with truthful total", async () => {
  const ids: number[] = [];
  for (let page = 1; page <= 7; page++) {
    const result = await traceBatch("TRACE-ALL", "LOT-ALL", db, { page, pageSize: 30 });
    expect(result.ledgerPage).toEqual({ page, pageSize: 30, total: 203 });
    expect(result.ledger.length).toBe(page < 7 ? 30 : 23);
    ids.push(...result.ledger.map(row => row.id));
  }
  expect(new Set(ids).size).toBe(203); expect(ids).toEqual([...ids].sort((a, b) => b - a));
});
it("same document's rows retain ledger and source-line identities and Shanghai date", async () => {
  const result = await traceBatch("TRACE-ALL", "LOT-ALL", db);
  expect(result.batch.baseUom).toBe("瓶");
  expect(result.ledger[0]).toMatchObject({ occurredAt: "2026-09-04", sourceLineId: 201, qtyDelta: "0.0001" });
  expect(result.ledger[0].id).not.toBe(result.ledger[1].id);
});
it("an empty out-of-range page preserves the full total and outbound evidence", async () => {
  const result = await traceBatch("TRACE-ALL", "LOT-ALL", db, { page: 20, pageSize: 30 });
  expect(result.ledger).toEqual([]); expect(result.ledgerPage.total).toBe(203); expect(result.coverage.outboundTraceable).toBe(true);
});
it("actual source documents receive precise links; missing documents stay unresolved", async () => {
  const result = await traceBatch("TRACE-ALL", "LOT-ALL", db, { page: 7 });
  expect(result.ledger.find(row => row.sourceDocId === 411)).toMatchObject({ sourceDocNo: "CK-TRACE-411", sourceHref: "/inventory/docs?docId=411" });
  expect(result.ledger.find(row => row.sourceDocId === 410)).toMatchObject({ sourceDocNo: null, sourceHref: null });
});
it("negative stock-count adjustments are not evidence of physical outbound traceability", async () => {
  const result = await traceBatch("TRACE-ALL", "LOT-ADJUST", db);
  expect(result.ledgerPage.total).toBe(2); expect(result.coverage.outboundTraceable).toBe(false);
});
it.each([{ page: 0 }, { page: 1.5 }, { page: NaN }, { pageSize: 0 }, { pageSize: 101 }])("invalid pagination %j is explicitly rejected", async query => {
  await expect(traceBatch("TRACE-ALL", "LOT-ALL", db, query)).rejects.toThrow(/分页/);
});
