import { beforeEach, describe, expect, it } from "vitest";
import {
  auditLogs, poDocs, poLines, poPromiseRevisions, skus, spus, suppliers, users,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { generateConfirmToken, submitPoConfirm } from "@/server/modules/outsource/po-confirm";
import { createTestDb, type TestDb } from "../helpers/db";
import { eq } from "drizzle-orm";

describe("供应商确认 token 原子消费", () => {
  let db: TestDb;
  let buyer: SessionUser;
  let poId = 0;
  let lineId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [user] = await db.insert(users).values({
      username: "buyer",
      name: "采购",
      roles: ["purchasing"],
      isApprover: true,
    }).returning();
    buyer = { id: user.id, name: user.name, roles: ["purchasing"], isApprover: true };
    const [supplier] = await db.insert(suppliers).values({
      code: "PC-SUP",
      name: "确认供应商",
      kinds: ["material"],
      status: "qualified",
    }).returning();
    const [spu] = await db.insert(spus).values({ code: "PC-SPU", nameCn: "确认产品" }).returning();
    const [sku] = await db.insert(skus).values({
      spuId: spu.id,
      code: "PC-SKU",
      name: "确认物料",
      skuType: "raw",
      baseUom: "kg",
    }).returning();
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-CONFIRM-1",
      status: "approved",
      supplierId: supplier.id,
      createdBy: user.id,
    }).returning();
    poId = po.id;
    const [line] = await db.insert(poLines).values({
      poId,
      skuId: sku.id,
      lineType: "raw",
      purchaseUom: "kg",
      qty: "10",
      price: "2",
    }).returning();
    lineId = line.id;
  });

  it("逐行越权失败时，表头更新、token 消费和审计全部回滚", async () => {
    const { token } = await generateConfirmToken(buyer, poId, db);
    await expect(submitPoConfirm(token, {
      expectedDate: "2026-08-10",
      lines: [{ poLineId: lineId + 999, expectedDate: "2026-08-10" }],
    }, db)).rejects.toMatchObject({ status: 400 });

    const [po] = await db.select().from(poDocs).where(eq(poDocs.id, poId));
    expect(po.confirmTokenUsedAt).toBeNull();
    expect(po.expectedDate).toBeNull();
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "supplier_confirm"));
    expect(audits).toHaveLength(0);
    expect(await db.select().from(poPromiseRevisions)).toHaveLength(0);
  });

  it("并发提交只有一个请求能消费 token，且只落一条确认审计", async () => {
    const { token } = await generateConfirmToken(buyer, poId, db);
    const results = await Promise.allSettled([
      submitPoConfirm(token, { expectedDate: "2026-08-10" }, db),
      submitPoConfirm(token, { expectedDate: "2026-08-11" }, db),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "supplier_confirm"));
    expect(audits).toHaveLength(1);
    const [po] = await db.select().from(poDocs).where(eq(poDocs.id, poId));
    expect(po.confirmTokenUsedAt).not.toBeNull();
    expect(["2026-08-10", "2026-08-11"]).toContain(po.expectedDate);
    const revisions = await db.select().from(poPromiseRevisions);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      poId,
      poLineId: lineId,
      sequence: 1,
      previousDate: null,
      promisedDate: po.expectedDate,
      source: "supplier_confirm",
      actorType: "supplier_token",
      recordedBy: null,
    });
  });

  it("再次确认会追加新版本，旧承诺不可被覆盖", async () => {
    const first = await generateConfirmToken(buyer, poId, db);
    await submitPoConfirm(first.token, { expectedDate: "2026-08-10", note: "首次承诺" }, db);
    const second = await generateConfirmToken(buyer, poId, db);
    await submitPoConfirm(second.token, { expectedDate: "2026-08-15", note: "原料延迟" }, db);

    const revisions = await db.select().from(poPromiseRevisions).orderBy(poPromiseRevisions.sequence);
    expect(revisions.map((row) => ({
      sequence: row.sequence,
      previousDate: row.previousDate,
      promisedDate: row.promisedDate,
      reason: row.reason,
    }))).toEqual([
      { sequence: 1, previousDate: null, promisedDate: "2026-08-10", reason: "首次承诺" },
      { sequence: 2, previousDate: "2026-08-10", promisedDate: "2026-08-15", reason: "原料延迟" },
    ]);
    await expect(
      db.update(poPromiseRevisions).set({ reason: "覆盖历史" }).where(eq(poPromiseRevisions.id, revisions[0].id)),
    ).rejects.toThrow();
    const [unchanged] = await db.select().from(poPromiseRevisions).where(eq(poPromiseRevisions.id, revisions[0].id));
    expect(unchanged.reason).toBe("首次承诺");
  });
});
