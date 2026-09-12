import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { suggestLeftoverAfterInbound } from "@/server/modules/outsource/leftover";
import { listReviewItems } from "@/server/modules/review/checklist";
import type { DB } from "@/db";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";
let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"];
let actor: SessionUser, cp: number, mat: number, extra: number, wh: number, sup: number, bom: number, seq = 0;
beforeAll(async () => {
  ({ db, client } = await createTestDb());
  const [user] = await db.insert(s.users).values({ name: "合成仓管", roles: ["warehouse"] }).returning(); actor = user;
  const [spu] = await db.insert(s.spus).values({ code: "INB", nameCn: "入库物料核对" }).returning();
  const skus = await db.insert(s.skus).values([
    { code: "INB-CP", name: "成品", spuId: spu.id, skuType: "finished" as const, baseUom: "支" },
    { code: "INB-MAT", name: "物料", spuId: spu.id, skuType: "raw" as const, baseUom: "个" },
    { code: "INB-EXTRA", name: "工单外", spuId: spu.id, skuType: "raw" as const, baseUom: "个" },
  ]).returning(); [cp, mat, extra] = skus.map(x => x.id);
  [sup] = (await db.insert(s.suppliers).values({ code: "INB-SUP", name: "加工厂" }).returning()).map(x => x.id);
  [wh] = (await db.insert(s.warehouses).values({ code: "INB-WH", name: "合成仓", kind: "finished" }).returning()).map(x => x.id);
  [bom] = (await db.insert(s.boms).values({ productSkuId: cp, versionNo: "1" }).returning()).map(x => x.id);
});
afterAll(async () => { await client.close(); });
async function fixture(completed = true) {
  const no = `INB-${++seq}`;
  const [wo] = await db.insert(s.woDocs).values({ docNo: `WO-${no}`, productSkuId: cp, supplierId: sup, bomId: bom, qty: "100", feeRatePlan: "1", createdBy: actor.id }).returning();
  await db.insert(s.woLines).values([40, 60].map(n => ({ woId: wo.id, materialSkuId: mat, qtyPer: "0.5", grossReq: String(n), suggestedQty: "0" })));
  const [jg] = await db.insert(s.jgDocs).values({ docNo: `JG-${no}`, woId: wo.id, productSkuId: cp, supplierId: sup, qty: "100", feeRateCurrent: "1", status: "in_progress", createdBy: actor.id }).returning();
  const [fl] = await db.insert(s.flDocs).values({ docNo: `FL-${no}`, jgId: jg.id, fromWarehouseId: wh, toWarehouseId: wh, status: "completed", createdBy: actor.id }).returning();
  await db.insert(s.flLines).values({ flId: fl.id, skuId: mat, qty: "120" });
  const [sh] = await db.insert(s.shDocs).values({ docNo: `SH-${no}`, sourceType: "jg", sourceId: jg.id, warehouseId: wh, status: completed ? "completed" : "approved", createdBy: actor.id }).returning();
  const sl = await db.insert(s.shLines).values([
    { shId: sh.id, skuId: cp, actualQty: "90", lineType: "normal" },
    { shId: sh.id, skuId: cp, actualQty: "10", lineType: "spare" },
    { shId: sh.id, skuId: cp, actualQty: "5", lineType: "rework" },
  ]).returning();
  const [qc] = await db.insert(s.qcRecords).values({ shId: sh.id, createdBy: actor.id }).returning();
  const ql = await db.insert(s.qcLines).values([
    { qcId: qc.id, shLineId: sl[0].id, passQty: "80", concessionQty: "5", failQty: "5" },
    { qcId: qc.id, shLineId: sl[1].id, passQty: "8", concessionQty: "2" },
    { qcId: qc.id, shLineId: sl[2].id, passQty: "5" },
  ]).returning();
  return { wo, jg, fl, sh, ql };
}
const items = (id: number) => db.select().from(s.reviewItems).where(eq(s.reviewItems.refKey, String(id)));
it("aggregates duplicate WO material once; completed pass+concession+spare+rework total is 100", async () => {
  const f = await fixture(); await suggestLeftoverAfterInbound(actor, f.jg.id, db);
  const [row] = await items(f.jg.id);
  expect(row.detail).toContain("累计入库 100"); expect(row.detail?.match(/INB-MAT/g)).toHaveLength(1);
  expect(row.detail).toContain("净发料 120.0000；毛用量估算 100.0000；差额 20.0000");
  expect(row.detail).toContain("不是实盘或可退库存");
  expect((await db.select().from(s.stockLedger))).toHaveLength(0);
  const log = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityId, row.id)); expect(log).toHaveLength(1);
  const filtered = await listReviewItems({ category: "material_leftover", page: 1, pageSize: 100 }, db as unknown as DB);
  expect(filtered.data.every(r => r.category === "material_leftover")).toBe(true);
});
it("excludes approved but not posted QC and pending FL/TL, even on the same JG", async () => {
  const f = await fixture(false); await suggestLeftoverAfterInbound(actor, f.jg.id, db); expect(await items(f.jg.id)).toHaveLength(0);
  await db.update(s.shDocs).set({ status: "completed" }).where(eq(s.shDocs.id, f.sh.id));
  const [unposted] = await db.insert(s.shDocs).values({ ...f.sh, id: undefined, docNo: `SH-NOT-${f.jg.id}`, status: "approved" }).returning();
  const [sl] = await db.insert(s.shLines).values({ shId: unposted.id, skuId: cp, actualQty: "999" }).returning();
  const [qc] = await db.insert(s.qcRecords).values({ shId: unposted.id, createdBy: actor.id }).returning();
  await db.insert(s.qcLines).values({ qcId: qc.id, shLineId: sl.id, passQty: "999" });
  await db.update(s.flDocs).set({ status: "pending" }).where(eq(s.flDocs.id, f.fl.id));
  await suggestLeftoverAfterInbound(actor, f.jg.id, db);
  expect((await items(f.jg.id))[0].detail).toContain("净发料 0.0000；毛用量估算 100.0000；差额 -100.0000");
});
it("keeps missing QC unknown rather than claiming zero consumption", async () => {
  const f = await fixture(); await db.delete(s.qcLines).where(eq(s.qcLines.id, f.ql[0].id));
  await suggestLeftoverAfterInbound(actor, f.jg.id, db);
  expect((await items(f.jg.id))[0].detail).toContain("估算暂停"); expect((await items(f.jg.id))[0].detail).toContain("毛用量估算 未知；差额 未知");
});
it("retains off-WO issued material without inventing its expected usage", async () => {
  const f = await fixture(); await db.insert(s.flLines).values({ flId: f.fl.id, skuId: extra, qty: "7" });
  await suggestLeftoverAfterInbound(actor, f.jg.id, db);
  expect((await items(f.jg.id))[0].detail).toContain("INB-EXTRA（个）：净发料 7.0000；毛用量估算 未知；差额 未知；工单外物料");
});
it("same snapshot is idempotent; changed facts refresh one open item and preserve human note; done is not reopened", async () => {
  const f = await fixture(); await suggestLeftoverAfterInbound(actor, f.jg.id, db); const [first] = await items(f.jg.id);
  await db.update(s.reviewItems).set({ note: "现场复核中" }).where(eq(s.reviewItems.id, first.id));
  await suggestLeftoverAfterInbound(actor, f.jg.id, db); expect(await items(f.jg.id)).toHaveLength(1);
  await db.update(s.flLines).set({ qty: "130" }).where(eq(s.flLines.flId, f.fl.id));
  await suggestLeftoverAfterInbound(actor, f.jg.id, db); const [updated] = await items(f.jg.id);
  expect(updated.id).toBe(first.id); expect(updated.note).toBe("现场复核中"); expect(updated.detail).toContain("差额 30.0000");
  await db.update(s.reviewItems).set({ status: "done" }).where(eq(s.reviewItems.id, first.id));
  await suggestLeftoverAfterInbound(actor, f.jg.id, db); expect(await items(f.jg.id)).toHaveLength(1);
  await db.update(s.flLines).set({ qty: "140" }).where(eq(s.flLines.flId, f.fl.id));
  await suggestLeftoverAfterInbound(actor, f.jg.id, db); expect((await items(f.jg.id)).map(r => r.status).sort()).toEqual(["done", "open"]);
});
it("audit failure rolls back the review item; stale claimed warehouse role cannot generate it", async () => {
  const f = await fixture(); const fail = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(new Error("audit unavailable"));
  await expect(suggestLeftoverAfterInbound(actor, f.jg.id, db)).rejects.toThrow("audit unavailable"); fail.mockRestore();
  expect(await items(f.jg.id)).toHaveLength(0);
  await db.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, actor.id));
  await expect(suggestLeftoverAfterInbound(actor, f.jg.id, db)).rejects.toMatchObject({ status: 403 });
  await db.update(s.users).set({ roles: ["warehouse"] }).where(eq(s.users.id, actor.id));
});
it("database round trips remain constant with 52 rather than 2 WO lines", async () => {
  const f = await fixture(); const statements: string[] = [];
  const measured = drizzle(client, { schema: s, logger: { logQuery: q => { statements.push(q); } } });
  await suggestLeftoverAfterInbound(actor, f.jg.id, measured);
  const first = statements.length;
  await db.insert(s.woLines).values(Array.from({ length: 50 }, () => ({ woId: f.wo.id, materialSkuId: mat, qtyPer: "0.01", grossReq: "1", suggestedQty: "0" })));
  statements.length = 0; await suggestLeftoverAfterInbound(actor, f.jg.id, measured); const second = statements.length;
  expect(first).toBeGreaterThan(0); expect(second).toBe(first);
});
it("a completed receipt with no lines is unknown, not zero consumption", async () => {
  const f = await fixture();
  await db.insert(s.shDocs).values({ ...f.sh, id: undefined, docNo: `SH-EMPTY-${f.jg.id}` });
  await suggestLeftoverAfterInbound(actor, f.jg.id, db); expect((await items(f.jg.id))[0].detail).toContain("估算暂停");
});
it("a changed snapshot returning to an older value refreshes the open item instead of matching stale history", async () => {
  const f = await fixture(); await suggestLeftoverAfterInbound(actor, f.jg.id, db); const [old] = await items(f.jg.id);
  await db.update(s.reviewItems).set({ status: "done" }).where(eq(s.reviewItems.id, old.id));
  await db.update(s.flLines).set({ qty: "130" }).where(eq(s.flLines.flId, f.fl.id));
  await suggestLeftoverAfterInbound(actor, f.jg.id, db);
  await db.update(s.flLines).set({ qty: "120" }).where(eq(s.flLines.flId, f.fl.id));
  await suggestLeftoverAfterInbound(actor, f.jg.id, db);
  const rows = await items(f.jg.id); expect(rows).toHaveLength(2);
  expect(rows.find(row => row.status === "open")?.detail).toContain("差额 20.0000");
});
