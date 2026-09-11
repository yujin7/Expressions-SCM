/**
 * C9 + C10：两页各自都对，合起来是错的。
 *
 * C9 **被抑制的采购在决策表上必须看得见**。`report/move-or-buy` 只收 `suggestQty != null` 的行，
 * 而被「已复核并放弃」抑制的行 `suggestQty` 恰恰是 null——于是它要么整行消失、
 * 要么以「先挪即可」的面目出现。系统扣下了一笔采购，读者在决策表上看不到任何痕迹，
 * 这与「抑制绝不静默」的纪律直接冲突。
 *
 * C10 **跨页重复下单**。先挪后买页起草的是**净额后**的 `residualBuyQty`，
 * `/replenish` 同一时刻仍按**全额** `suggestQty` 下发；计划员在一页起草调拨、另一页起草采购，
 * 多订的正好是那个调拨量。两页都必须看得见对方在飞的草稿（只提示，不自动扣减：
 * 草稿随时会被驳回或改量，拿它去改写判定口径等于让临时单据决定建议量）。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { declineReplenishSuggestion } from "@/server/modules/replenish/decline";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";
import { loadInFlightDrafts } from "@/server/modules/replenish/in-flight-drafts";
import { getMoveOrBuyDecisions } from "@/server/modules/report/move-or-buy";
import { createTestDb, type TestDb } from "../helpers/db";

/** 制造一个真会触发建议的短缺 SKU（日均 ≈ 9.9/天，在库 100 → 约 10 天可销） */
async function seedShortage(db: TestDb) {
  const [pmc] = await db.insert(schema.users).values({ name: "计划员", roles: ["pmc"] }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
  const [sku] = await db.insert(schema.skus).values({
    code: "CP00001", name: "面霜", spuId: spu.id, skuType: "finished", baseUom: "支",
  }).returning();
  const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  const [wh] = await db.insert(schema.warehouses).values({
    code: "WH-CP", name: "成品仓", kind: "finished", accountingMode: "realtime",
  }).returning();
  for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
    await db.insert(schema.salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: ym, qty: "900" });
  }
  await db.insert(schema.skuParams).values({ skuId: sku.id, normalLeadDays: 30, logisticsLeadDays: 15 });
  await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "100" });
  const user: SessionUser = { id: pmc.id, name: pmc.name, roles: ["pmc"] } as SessionUser;
  return { sku, wh, user };
}

describe("C9 被抑制的采购必须出现在「先挪后买」决策表上", () => {
  it("放弃后行不消失、不伪装成「先挪即可」，而是标 buy_suppressed 并带出被扣下的量", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku, user } = await seedShortage(db);
      const before = await getMoveOrBuyDecisions({ roles: ["pmc"] }, db);
      expect(before.rows.find((r) => r.skuId === sku.id), "先要有一条真建议，否则测的是空气").toBeDefined();

      await declineReplenishSuggestion(user, {
        skuId: sku.id, reasonCode: "supply_already_arranged", reason: "线下已让工厂排产，PO 明天补",
      }, db);

      const after = await getMoveOrBuyDecisions({ roles: ["pmc"] }, db);
      const row = after.rows.find((r) => r.skuId === sku.id);
      expect(row, "修复前这一行整个消失了——系统扣下一笔采购，决策表上不留痕迹").toBeDefined();
      expect(row!.suggestQty).toBeNull();
      expect(row!.action).toBe("buy_suppressed");
      expect(row!.suppression).not.toBeNull();
      expect(row!.suppression!.reasonCode).toBe("supply_already_arranged");
      expect(Number(row!.withheldBuyQty)).toBeGreaterThan(0);
      expect(row!.suppression!.label).toContain("放弃");
      expect(after.summary.declineSuppressed).toBe(1);
      // 「先挪即可」是一个结论（不用买），不能拿来盖住「被扣着」这个事实
      expect(after.summary.coveredByTransfer).toBe(0);
    } finally {
      await client.close();
    }
  });
});

describe("C10 两页必须看得见对方在飞的草稿", () => {
  it("已起草未收口的调拨会出现在 /replenish 行上（全额建议照发，但明确提示别重复下）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku, wh, user } = await seedShortage(db);
      const [wh2] = await db.insert(schema.warehouses).values({
        code: "WH-CP2", name: "成品二仓", kind: "finished", accountingMode: "realtime",
      }).returning();

      const clean = await getReplenishSuggestions({ allRows: true }, db);
      const cleanRow = clean.rows.find((r) => r.skuId === sku.id)!;
      expect(cleanRow.suggestQty).not.toBeNull();
      expect(cleanRow.inFlightWarning, "没有在飞草稿时不该在行上说任何话").toBeNull();

      // 另一页（先挪后买 / 调拨建议）起草了一张调拨草稿
      const [dbDoc] = await db.insert(schema.stockDocs).values({
        docNo: "DB-2026-0001", subtype: "transfer", status: "draft", createdBy: user.id,
      }).returning();
      await db.insert(schema.stockDocLines).values({
        stockDocId: dbDoc.id, skuId: sku.id, warehouseId: wh2.id, toWarehouseId: wh.id, qty: "300",
      });

      const after = await getReplenishSuggestions({ allRows: true }, db);
      const row = after.rows.find((r) => r.skuId === sku.id)!;
      expect(row.inFlightDrafts).toMatchObject({ transferQty: 300, transferDocs: 1 });
      expect(row.inFlightWarning).toContain("调拨");
      expect(row.inFlightWarning).toContain("300");
      expect(row.planExplain.some((l) => l.includes("跨页在途草稿"))).toBe(true);
      // 只提示，不自动扣减——草稿随时会被驳回或改量
      expect(row.suggestQty).toBe(cleanRow.suggestQty);
    } finally {
      await client.close();
    }
  });

  it("已起草未收口的备货申请（BH）会出现在决策表行上", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku, user } = await seedShortage(db);
      const [bh] = await db.insert(schema.bhDocs).values({
        docNo: "BH-2026-0001", status: "pending", createdBy: user.id,
      }).returning();
      await db.insert(schema.bhLines).values({ bhId: bh.id, skuId: sku.id, qty: "500" });

      const res = await getMoveOrBuyDecisions({ roles: ["pmc"] }, db);
      const row = res.rows.find((r) => r.skuId === sku.id)!;
      expect(row.inFlightDrafts).toMatchObject({ buyQty: 500, buyDocs: 1 });
      expect(row.inFlightWarning).toContain("备货申请");
    } finally {
      await client.close();
    }
  });

  it("已收口的单据不再算在飞（完成的采购已进未结供给/在库，再提示一次就是重复计数）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku, user } = await seedShortage(db);
      for (const status of ["completed", "void", "closed"] as const) {
        const [bh] = await db.insert(schema.bhDocs).values({
          docNo: `BH-DONE-${status}`, status, createdBy: user.id,
        }).returning();
        await db.insert(schema.bhLines).values({ bhId: bh.id, skuId: sku.id, qty: "500" });
      }
      const map = await loadInFlightDrafts(db, [sku.id]);
      expect(map.get(sku.id)).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
