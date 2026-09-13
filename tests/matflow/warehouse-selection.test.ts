import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { createFl, submitFl, approveFl } from "@/server/modules/matflow/fl";
import { createTl, submitTl, approveTl } from "@/server/modules/matflow/tl";
import { createSh, submitSh, approveSh, createQc, confirmInbound, getSh } from "@/server/modules/matflow/sh";
import { getOutsourceWarehouseOf } from "@/server/modules/matflow/common-notes";
import { getJgMaterialBasis } from "@/server/modules/matflow/material-basis";
import { getBalance } from "@/server/posting";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, product: number, material: number, bom: number, seq = 0;
let maker: typeof s.users.$inferSelect, checker: typeof s.users.$inferSelect;
beforeAll(async () => {
  f = await createTestDb();
  [maker, checker] = await f.db.insert(s.users).values([
    { name: "选仓制单", roles: ["warehouse"] }, { name: "选仓审批", roles: ["warehouse"], isApprover: true },
  ]).returning();
  await f.db.insert(s.approvalConfigs).values(["fl", "tl", "sh"].map(docType => ({ docType, approverRole: "warehouse" })));
  const [spu] = await f.db.insert(s.spus).values({ code: "WH-SELECT", nameCn: "明确选仓" }).returning();
  const skus = await f.db.insert(s.skus).values([
    { code: "WH-SELECT-CP", spuId: spu.id, skuType: "finished", baseUom: "支" },
    { code: "WH-SELECT-MAT", spuId: spu.id, skuType: "raw", baseUom: "个" },
  ]).returning(); product = skus[0].id; material = skus[1].id;
  const [b] = await f.db.insert(s.boms).values({ productSkuId: product, versionNo: "1" }).returning(); bom = b.id;
});
afterAll(async () => f?.client.close());
afterEach(() => vi.restoreAllMocks());

it("admin-approved extra-WO material stays reachable in return creation evidence and posts a real TL", async () => {
  const x = await fixture();
  const [original] = await f.db.select().from(s.skus).where(eq(s.skus.id, material));
  const [extra] = await f.db.insert(s.skus).values({ code: "WH-SELECT-EXTRA", spuId: original.spuId, skuType: "raw", baseUom: "个" }).returning();
  const [admin] = await f.db.insert(s.users).values({ name: "额外物料审批", roles: ["admin"], isApprover: true }).returning();
  await f.db.insert(s.stockBalances).values({ warehouseId: x.own.id, skuId: extra.id, qty: "10" });
  const fl = await createFl(maker, { ...x.fl, lines: [{ skuId: extra.id, qty: "3" }] }, f.db);
  const pending = await submitFl(maker, fl.id, fl.version, f.db);
  await approveFl(admin, fl.id, { action: "approve", version: pending.version }, f.db);
  const basis = await getJgMaterialBasis(maker, x.jg.id, f.db);
  const row = basis.lines.find(l => l.materialSkuId === extra.id);
  expect(row).toMatchObject({ issuedQty: "3.0000", grossReq: "0", suggestedIssueQty: "0" });
  const tl = await createTl(maker, { ...x.tl, lines: [{ skuId: row!.materialSkuId, qty: "1", reason: "surplus_return" }] }, f.db);
  const tp = await submitTl(maker, tl.id, tl.version, f.db);
  await approveTl(checker, tl.id, { action: "approve", version: tp.version }, f.db);
  expect(await getBalance(f.db, extra.id, x.b.id)).toBe("2.0000");
  expect((await getJgMaterialBasis(maker, x.jg.id, f.db)).lines.find(l => l.materialSkuId === extra.id)?.returnedQty).toBe("1.0000");
});

async function fixture() {
  const key = `WH-SELECT-${++seq}`;
  const [supplier, other] = await f.db.insert(s.suppliers).values([{ code: key, name: "甲厂" }, { code: `${key}-B`, name: "乙厂" }]).returning();
  const [own, a, b, wrong] = await f.db.insert(s.warehouses).values([
    { code: `${key}-OWN`, name: "自有仓", kind: "raw" },
    { code: `${key}-A`, name: "甲厂一仓", kind: "outsource", supplierId: supplier.id },
    { code: `${key}-B`, name: "甲厂二仓", kind: "outsource", supplierId: supplier.id },
    { code: `${key}-WRONG`, name: "乙厂仓", kind: "outsource", supplierId: other.id },
  ]).returning();
  const [wo] = await f.db.insert(s.woDocs).values({ docNo: `${key}-WO`, productSkuId: product, supplierId: supplier.id,
    bomId: bom, qty: "100", feeRatePlan: "1", status: "in_progress", createdBy: maker.id }).returning();
  await f.db.insert(s.woLines).values({ woId: wo.id, materialSkuId: material, qtyPer: "2", planLossRatePct: "0", grossReq: "200", suggestedQty: "200" });
  const [jg] = await f.db.insert(s.jgDocs).values({ docNo: `${key}-JG`, woId: wo.id, productSkuId: product,
    supplierId: supplier.id, qty: "100", feeRateCurrent: "1", status: "in_progress", createdBy: maker.id }).returning();
  await f.db.insert(s.stockBalances).values([
    { warehouseId: own.id, skuId: material, qty: "100" }, { warehouseId: a.id, skuId: material, qty: "30" },
    { warehouseId: b.id, skuId: material, qty: "30" },
  ]);
  const fl = { jgId: jg.id, fromWarehouseId: own.id, toWarehouseId: b.id, lines: [{ skuId: material, qty: "10" }] };
  const tl = { jgId: jg.id, toWarehouseId: own.id, fromWarehouseId: b.id, lines: [{ skuId: material, qty: "2", reason: "surplus_return" }] };
  return { supplier, own, a, b, wrong, jg, fl, tl };
}
async function receipt(x: Awaited<ReturnType<typeof fixture>>) {
  const sh = await createSh(maker, { sourceType: "jg", sourceId: x.jg.id, warehouseId: x.own.id,
    lines: [{ skuId: product, actualQty: "3" }] }, f.db);
  const pending = await submitSh(maker, sh.id, sh.version, f.db);
  await approveSh(checker, sh.id, { action: "approve", version: pending.version }, f.db);
  const detail = await getSh(sh.id, f.db);
  await createQc(maker, { shId: sh.id, lines: detail.lines.map(l => ({ shLineId: l.id, passQty: "3", failQty: "0", concessionQty: "0" })) }, f.db);
  return sh;
}
async function snapshot() {
  return { fl: await f.db.select().from(s.flDocs), tl: await f.db.select().from(s.tlDocs), sh: await f.db.select().from(s.shDocs),
    audit: await f.db.select().from(s.auditLogs), approvals: await f.db.select().from(s.approvals),
    stock: await f.db.select().from(s.stockBalances), ledger: await f.db.select().from(s.stockLedger), counters: await f.db.select().from(s.docCounters) };
}

it("same-factory second warehouse survives FL → TL → SH, audit, detail and replay; first warehouse stays untouched", async () => {
  const x = await fixture();
  const fl = await createFl(maker, x.fl, f.db); expect(fl.toWarehouseId).toBe(x.b.id);
  const fp = await submitFl(maker, fl.id, fl.version, f.db);
  await approveFl(checker, fl.id, { action: "approve", version: fp.version }, f.db);
  const tl = await createTl(maker, x.tl, f.db); expect(tl.fromWarehouseId).toBe(x.b.id);
  const tp = await submitTl(maker, tl.id, tl.version, f.db);
  await approveTl(checker, tl.id, { action: "approve", version: tp.version }, f.db);
  const sh = await receipt(x);
  expect(await confirmInbound(maker, sh.id, f.db, { outsourceWarehouseId: x.b.id })).toMatchObject({ status: "completed" });
  expect(await getBalance(f.db, material, x.a.id)).toBe("30.0000");
  expect(await getBalance(f.db, material, x.b.id)).toBe("32.0000");
  expect(await getBalance(f.db, material, x.own.id)).toBe("92.0000");
  expect(await getBalance(f.db, product, x.own.id)).toBe("3.0000");
  const detail = await getSh(sh.id, f.db);
  expect(detail.sourceSupplierId).toBe(x.supplier.id);
  expect(detail.consumptionWarehouses).toEqual([{ id: x.b.id, code: x.b.code, name: x.b.name }]);
  const [event] = await f.db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "sh"), eq(s.auditLogs.entityId, sh.id), eq(s.auditLogs.action, "inbound")));
  expect(event.after).toMatchObject({ outsourceWarehouse: { id: x.b.id, code: x.b.code, name: x.b.name } });
  await f.db.update(s.warehouses).set({ active: false, name: "二仓已停用" }).where(eq(s.warehouses.id, x.b.id));
  expect((await getSh(sh.id, f.db)).consumptionWarehouses).toEqual([{ id: x.b.id, code: x.b.code, name: "二仓已停用" }]);
  const before = await snapshot();
  await expect(confirmInbound(maker, sh.id, f.db, { outsourceWarehouseId: x.a.id })).rejects.toMatchObject({ status: 409 });
  expect((await approveFl(checker, fl.id, { action: "approve", version: fp.version }, f.db)).idempotent).toBe(true);
  expect(await snapshot()).toEqual(before);
});

it("ambiguous legacy creation refuses both FL/TL without writing; a single eligible warehouse still works", async () => {
  const x = await fixture(), before = await snapshot();
  await expect(createFl(maker, { ...x.fl, toWarehouseId: undefined }, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("多个") });
  await expect(createTl(maker, { ...x.tl, fromWarehouseId: undefined }, f.db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
  await f.db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, x.b.id));
  expect((await createFl(maker, { ...x.fl, toWarehouseId: undefined }, f.db)).toWarehouseId).toBe(x.a.id);
  expect((await createTl(maker, { ...x.tl, fromWarehouseId: undefined }, f.db)).fromWarehouseId).toBe(x.a.id);
});

it.each(["other_factory", "own", "inactive", "snapshot", "missing"])("FL/TL reject %s selection atomically", async kind => {
  const x = await fixture();
  if (kind === "inactive") await f.db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, x.b.id));
  if (kind === "snapshot") await f.db.update(s.warehouses).set({ kind: "snapshot", accountingMode: "snapshot", supplierId: null }).where(eq(s.warehouses.id, x.b.id));
  const id = kind === "other_factory" ? x.wrong.id : kind === "own" ? x.own.id : kind === "missing" ? 999999 : x.b.id;
  const before = await snapshot();
  await expect(createFl(maker, { ...x.fl, toWarehouseId: id }, f.db)).rejects.toMatchObject({ status: 409 });
  await expect(createTl(maker, { ...x.tl, fromWarehouseId: id }, f.db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
});

it.each(["fl", "tl"])("%s approval rechecks saved source/destination after deactivation, rollback includes approval and audit", async kind => {
  const x = await fixture();
  const doc = kind === "fl" ? await createFl(maker, x.fl, f.db) : await createTl(maker, x.tl, f.db);
  const pending = await (kind === "fl" ? submitFl : submitTl)(maker, doc.id, doc.version, f.db);
  await f.db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, x.b.id));
  const before = await snapshot();
  await expect((kind === "fl" ? approveFl : approveTl)(checker, doc.id, { action: "approve", version: pending.version }, f.db)).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
});

it("SH ambiguous/wrong-factory/disabled source and audit failure all preserve approved receipt and stock; retry uses explicit warehouse", async () => {
  const x = await fixture(), sh = await receipt(x), before = await snapshot();
  await expect(confirmInbound(maker, sh.id, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("多个") });
  await expect(confirmInbound(maker, sh.id, f.db, { outsourceWarehouseId: x.wrong.id })).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("atomic audit failed"));
  await expect(confirmInbound(maker, sh.id, f.db, { outsourceWarehouseId: x.b.id })).rejects.toThrow("atomic audit failed");
  expect(await snapshot()).toEqual(before);
  await f.db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, x.b.id));
  await expect(confirmInbound(maker, sh.id, f.db, { outsourceWarehouseId: x.b.id })).rejects.toMatchObject({ status: 409 });
  expect(await snapshot()).toEqual(before);
  expect(await confirmInbound(maker, sh.id, f.db, { outsourceWarehouseId: x.a.id })).toMatchObject({ status: "completed" });
});

it("unique resolver excludes inactive and non-realtime rows rather than relying on arbitrary order", async () => {
  const x = await fixture();
  await f.db.update(s.warehouses).set({ kind: "snapshot", accountingMode: "snapshot", supplierId: null }).where(eq(s.warehouses.id, x.a.id));
  expect((await getOutsourceWarehouseOf(f.db, x.supplier.id)).id).toBe(x.b.id);
  await f.db.update(s.warehouses).set({ active: false }).where(eq(s.warehouses.id, x.b.id));
  await expect(getOutsourceWarehouseOf(f.db, x.supplier.id)).rejects.toMatchObject({ status: 404 });
});
