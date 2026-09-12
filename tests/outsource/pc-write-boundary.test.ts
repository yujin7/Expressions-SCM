import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import * as audit from "@/server/core/audit";
import { createPcForJgFee } from "@/server/modules/outsource/jg";
import { approvePc } from "@/server/modules/outsource/po";
import { getPc } from "@/server/modules/outsource/pc-detail";
import { maskSensitive } from "@/server/core/dto";
import { createTestDb } from "../helpers/db";

let f: Awaited<ReturnType<typeof createTestDb>>, skuId: number, rawSkuId: number, supplierId: number, woId: number, seq = 0;
beforeAll(async () => {
  f = await createTestDb();
  const [spu] = await f.db.insert(s.spus).values({ code: "PCW", nameCn: "改价写入测试" }).returning();
  const [sku] = await f.db.insert(s.skus).values({ code: "PCW", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning(); skuId = sku.id;
  const [rawSpu] = await f.db.insert(s.spus).values({ code: "PCW-RAW", nameCn: "改价测试原料" }).returning();
  const [raw] = await f.db.insert(s.skus).values({ code: "PCW-RAW", spuId: rawSpu.id, skuType: "raw", baseUom: "kg" }).returning(); rawSkuId = raw.id;
  const [supplier] = await f.db.insert(s.suppliers).values({ code: "PCW", name: "加工厂" }).returning(); supplierId = supplier.id;
  const [bom] = await f.db.insert(s.boms).values({ productSkuId: skuId, versionNo: "1" }).returning();
  const maker = await actor();
  const [wo] = await f.db.insert(s.woDocs).values({ docNo: "PCW-WO", createdBy: maker.id, productSkuId: skuId, supplierId, bomId: bom.id, qty: "10", feeRatePlan: "2.50" }).returning(); woId = wo.id;
  await f.db.insert(s.approvalConfigs).values({ docType: "pc", approverRole: "purchasing" });
});
afterAll(async () => f?.client.close());
afterEach(() => vi.restoreAllMocks());
async function actor() {
  const [u] = await f.db.insert(s.users).values({ name: `PCW-${++seq}`, roles: ["purchasing"], isApprover: true }).returning();
  return { id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover, sessionVersion: u.sessionVersion };
}
async function setup() {
  const maker = await actor(), checker = await actor();
  const [jg] = await f.db.insert(s.jgDocs).values({ docNo: `PCW-${seq}`, woId, batchSeq: seq, productSkuId: skuId, supplierId,
    qty: "10.125", feeRateCurrent: "2.50", status: "in_progress", createdBy: maker.id }).returning();
  return { maker, checker, jg };
}
const input = (jgId: number) => ({ jgId, newPrice: "2.80", scope: "unreceived_only" });
const snap = async (jgId: number) => ({ jg: (await f.db.select().from(s.jgDocs).where(eq(s.jgDocs.id, jgId)))[0],
  pcs: await f.db.select().from(s.pcDocs).where(eq(s.pcDocs.jgId, jgId)),
  segments: await f.db.select().from(s.jgFeeSegments).where(eq(s.jgFeeSegments.jgId, jgId)),
  approvals: await f.db.select().from(s.approvals), audit: await f.db.select().from(s.auditLogs) });

for (const operation of ["create", "approve", "reject"] as const) {
  it.each(["disabled", "session", "role", "approver"])(`${operation}: rechecks current %s authority`, async reason => {
    const a = await setup();
    const pc = operation === "create" ? null : await createPcForJgFee(a.maker, input(a.jg.id), f.db);
    const user = operation === "create" ? a.maker : a.checker;
    const before = await snap(a.jg.id);
    await f.db.update(s.users).set(reason === "disabled" ? { active: false } : reason === "session"
      ? { sessionVersion: user.sessionVersion + 1 } : reason === "role" ? { roles: ["ops"] } : { isApprover: false }).where(eq(s.users.id, user.id));
    const run = operation === "create" ? createPcForJgFee(user, input(a.jg.id), f.db)
      : approvePc(user, pc!.id, { action: operation, version: 1 }, f.db);
    if (operation === "create" && reason === "approver") {
      expect(await run).toMatchObject({ status: "pending" }); // Creating does not require approval qualification.
    } else {
      await expect(run).rejects.toMatchObject({ status: reason === "session" ? 401 : 403 });
      expect(await snap(a.jg.id)).toEqual(before);
    }
  });
}
it("creation audit rollback also releases its number; repeated pending application conflicts", async () => {
  const a = await setup(), before = await snap(a.jg.id);
  const counters = await f.db.select().from(s.docCounters);
  vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(Error("create audit failure"));
  await expect(createPcForJgFee(a.maker, input(a.jg.id), f.db)).rejects.toThrow("create audit failure");
  expect(await snap(a.jg.id)).toEqual(before);
  expect(await f.db.select().from(s.docCounters)).toEqual(counters);
  expect(await createPcForJgFee(a.maker, input(a.jg.id), f.db)).toMatchObject({ oldPrice: "2.50", newPrice: "2.80", deviationPct: "12.00" });
  await expect(createPcForJgFee(a.maker, input(a.jg.id), f.db)).rejects.toMatchObject({ status: 409 });
});
it("approval audit failure rolls back PC, approval, current fee and segment; replay never repeats fee effect", async () => {
  const a = await setup(), pc = await createPcForJgFee(a.maker, input(a.jg.id), f.db), before = await snap(a.jg.id);
  const original = audit.writeAudit;
  vi.spyOn(audit, "writeAudit").mockImplementation(async (db, event) => {
    if (event.action === "fee_change") throw Error("fee audit failure");
    return original(db, event);
  });
  await expect(approvePc(a.checker, pc.id, { action: "approve", version: 1 }, f.db)).rejects.toThrow("fee audit failure");
  expect(await snap(a.jg.id)).toEqual(before);
  vi.restoreAllMocks();
  expect(await approvePc(a.checker, pc.id, { action: "approve", version: 1 }, f.db)).toMatchObject({ idempotent: false });
  const approved = await snap(a.jg.id);
  expect(approved.jg).toMatchObject({ feeRateCurrent: "2.80", qty: "10.1250" });
  expect(approved.segments.map(r => r.rate)).toEqual(["2.80"]);
  expect(await approvePc(a.checker, pc.id, { action: "approve", version: 1 }, f.db)).toMatchObject({ idempotent: true });
  expect(await snap(a.jg.id)).toEqual(approved);
  expect(await f.db.select().from(s.stockLedger)).toHaveLength(0);
});
it("stale price evidence refuses approval without rewriting it; rejection permits a fresh application", async () => {
  const a = await setup(), pc = await createPcForJgFee(a.maker, input(a.jg.id), f.db);
  await f.db.update(s.jgDocs).set({ feeRateCurrent: "3.00" }).where(eq(s.jgDocs.id, a.jg.id));
  const before = await snap(a.jg.id);
  await expect(approvePc(a.checker, pc.id, { action: "approve", version: 1 }, f.db)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("现价") });
  expect(await snap(a.jg.id)).toEqual(before);
  await approvePc(a.checker, pc.id, { action: "reject", version: 1 }, f.db);
  expect(await createPcForJgFee(a.maker, input(a.jg.id), f.db)).toMatchObject({ oldPrice: "3.00", deviationPct: "-6.67" });
});
it("self approval remains forbidden even for a current admin", async () => {
  const a = await setup(), pc = await createPcForJgFee(a.maker, input(a.jg.id), f.db), before = await snap(a.jg.id);
  await f.db.update(s.users).set({ roles: ["admin"] }).where(eq(s.users.id, a.maker.id));
  await expect(approvePc(a.maker, pc.id, { action: "approve", version: 1 }, f.db)).rejects.toMatchObject({ status: 403 });
  expect(await snap(a.jg.id)).toEqual(before);
  expect(await f.db.select().from(s.approvals).where(and(eq(s.approvals.docType, "pc"), eq(s.approvals.docId, pc.id)))).toHaveLength(0);
});

it.each(["ops", "warehouse", "quality"])("configured %s checker cannot approve hidden JG or PO prices, including a stale visible-money session", async role => {
  const a = await setup(), feePc = await createPcForJgFee(a.maker, input(a.jg.id), f.db);
  const [po] = await f.db.insert(s.poDocs).values({ docNo: `PCW-PO-${seq}`, supplierId, createdBy: a.maker.id }).returning();
  const [line] = await f.db.insert(s.poLines).values({ poId: po.id, skuId: rawSkuId, lineType: "raw", purchaseUom: "kg",
    qty: "10", price: "2.80" }).returning();
  // A po_line PC releases the later PO submission; it must not mutate the saved PO price.
  const [linePc] = await f.db.insert(s.pcDocs).values({ docNo: `PCW-LINE-${seq}`, target: "po_line",
    poLineId: line.id,
    oldPrice: "2.50", newPrice: "2.80", deviationPct: "12.00", scope: "unreceived_only",
    status: "pending", createdBy: a.maker.id }).returning();
  await f.db.update(s.users).set({ roles: [role] }).where(eq(s.users.id, a.checker.id));
  await f.db.update(s.approvalConfigs).set({ approverRole: role }).where(eq(s.approvalConfigs.docType, "pc"));
  try {
    const reader = { ...a.checker, roles: [role] };
    for (const pc of [feePc, linePc]) {
      const detail = maskSensitive(await getPc(pc.id, reader, f.db), reader.roles);
      for (const key of ["oldPrice", "newPrice", "deviationPct"]) expect(detail).not.toHaveProperty(key);
      const before = await snap(a.jg.id);
      const pcBefore = await f.db.select().from(s.pcDocs).where(eq(s.pcDocs.id, pc.id));
      for (const caller of [reader, a.checker, { ...reader, roles: ["finance"] }]) {
        await expect(approvePc(caller, pc.id, { action: "approve", version: 1 }, f.db))
          .rejects.toMatchObject({ status: 403, message: expect.stringContaining("不可查看改价金额") });
        expect(await snap(a.jg.id)).toEqual(before);
        expect(await f.db.select().from(s.pcDocs).where(eq(s.pcDocs.id, pc.id))).toEqual(pcBefore);
      }
      expect(detail).toMatchObject({ actions: { approve: false, reject: true } });
      expect(await approvePc(reader, pc.id, { action: "reject", version: 1, comment: "请由可核对金额的审批人处理" }, f.db))
        .toMatchObject({ status: "draft", idempotent: false });
      const rejected = await snap(a.jg.id);
      expect(rejected.jg).toEqual(before.jg);
      expect(rejected.segments).toEqual(before.segments);
      expect(await f.db.select().from(s.approvals).where(and(eq(s.approvals.docType, "pc"), eq(s.approvals.docId, pc.id))))
        .toMatchObject([{ action: "reject", approverId: reader.id }]);
    }
    expect(await f.db.select().from(s.stockLedger)).toHaveLength(0);
    expect(await f.db.select().from(s.poLines).where(eq(s.poLines.id, line.id))).toEqual([line]);
    expect(await f.db.select().from(s.poDocs).where(eq(s.poDocs.id, po.id))).toEqual([po]);
    await f.db.update(s.users).set({ roles: [role, "finance"] }).where(eq(s.users.id, a.checker.id));
    const replacement = await createPcForJgFee(a.maker, input(a.jg.id), f.db);
    expect(await approvePc(reader, replacement.id, { action: "approve", version: 1 }, f.db))
      .toMatchObject({ status: "approved", idempotent: false });
    expect((await snap(a.jg.id)).jg).toMatchObject({ feeRateCurrent: "2.80" });
    await f.db.update(s.users).set({ roles: [role] }).where(eq(s.users.id, a.checker.id));
    const completed = await snap(a.jg.id);
    expect(await approvePc(reader, replacement.id, { action: "approve", version: 1 }, f.db))
      .toMatchObject({ status: "approved", idempotent: true });
    expect(await snap(a.jg.id)).toEqual(completed);
    await expect(approvePc(reader, replacement.id, { action: "approve", version: 999 }, f.db)).rejects.toMatchObject({ status: 409 });
    const next = await createPcForJgFee(a.maker, { ...input(a.jg.id), newPrice: "3.20" }, f.db);
    const beforeNext = await snap(a.jg.id);
    await expect(approvePc(reader, next.id, { action: "approve", version: 1 }, f.db)).rejects.toMatchObject({ status: 403 });
    expect(await snap(a.jg.id)).toEqual(beforeNext);
    await f.db.update(s.users).set({ isApprover: false }).where(eq(s.users.id, a.checker.id));
    await expect(approvePc(reader, replacement.id, { action: "approve", version: 1 }, f.db)).rejects.toMatchObject({ status: 403 });
  } finally {
    await f.db.update(s.approvalConfigs).set({ approverRole: "purchasing" }).where(eq(s.approvalConfigs.docType, "pc"));
  }
});
