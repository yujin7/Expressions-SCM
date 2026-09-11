/**
 * 审阅修复：supersedes 链每键只能有一个链头（supersedes_id IS NULL）。
 * 并发首提两条都以 supersedes_id=NULL 落库的窗口，由部分唯一索引关死 → 23505 → 409。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";

describe("链头唯一：sales_amount_monthly / ops_demand_submissions", () => {
  it("同键第二个链头被拒绝；正常 supersede（supersedes_id 指向前行）放行；company 的 NULL scope_id 也参与唯一", async () => {
    const { db, client } = await createTestDb();
    try {
      const [u] = await db.insert(schema.users).values({ name: "财务", roles: ["finance"] }).returning();
      const [head] = await db.insert(schema.salesAmountMonthly).values({ yearMonth: "2026-08", scopeKind: "company", scopeId: null, amount: "100.00", createdBy: u.id }).returning();
      const e1 = await db.insert(schema.salesAmountMonthly).values({ yearMonth: "2026-08", scopeKind: "company", scopeId: null, amount: "200.00", createdBy: u.id }).then(() => null, (e: unknown) => e);
      expect(String((e1 as { cause?: unknown })?.cause ?? e1)).toMatch(/uq_sales_amount_monthly_head|duplicate key/);
      await db.insert(schema.salesAmountMonthly).values({ yearMonth: "2026-08", scopeKind: "company", scopeId: null, amount: "200.00", createdBy: u.id, supersedesId: head.id });

      const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "P" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "CP1", name: "A", spuId: spu.id, baseUom: "盒", skuType: "finished" }).returning();
      const [h2] = await db.insert(schema.opsDemandSubmissions).values({ skuId: sku.id, channelId: null, period: "2026-10", qty: "10", submittedBy: u.id }).returning();
      const e2 = await db.insert(schema.opsDemandSubmissions).values({ skuId: sku.id, channelId: null, period: "2026-10", qty: "12", submittedBy: u.id }).then(() => null, (e: unknown) => e);
      expect(String((e2 as { cause?: unknown })?.cause ?? e2)).toMatch(/uq_ops_demand_submissions_head|duplicate key/);
      await db.insert(schema.opsDemandSubmissions).values({ skuId: sku.id, channelId: null, period: "2026-10", qty: "12", submittedBy: u.id, supersedesId: h2.id });
    } finally {
      await client.close();
    }
  });
});
