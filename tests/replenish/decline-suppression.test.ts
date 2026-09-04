/**
 * W2-#6 放弃一条建议之后，下一次运行必须有所不同。
 *
 * 事故形状：`replenish/decline.ts` 只写一条审计，第二天（甚至下一次刷新）同一个 SKU
 * 照旧出现在建议里。计划员每天对同一条建议重复做同一个判断，「已复核并放弃」等于一张便签。
 *
 * 纪律：抑制**绝不静默**——行仍在列表里，带原因、到期日、被扣下的建议量与解除入口。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { clearReplenishSuppression, declineReplenishSuggestion } from "@/server/modules/replenish/decline";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";
import { todayShanghai } from "@/server/modules/master/common";
import { SUPPRESSION_POLICY, suppressionState, suppressionWindowFor } from "@/server/rules/replenish-suppression";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb } from "../helpers/db";

describe("抑制窗口纯规则（rules/replenish-suppression）", () => {
  it("窗口按原因取不同长度：需求估高最短，供应已安排最长且随到货解除", () => {
    expect(SUPPRESSION_POLICY.demand_overstated.days).toBeLessThan(SUPPRESSION_POLICY.supply_already_arranged.days);
    expect(SUPPRESSION_POLICY.supply_already_arranged.releaseOnArrival).toBe(true);
    expect(SUPPRESSION_POLICY.demand_overstated.releaseOnArrival).toBe(false);
    expect(suppressionWindowFor("demand_overstated", "2026-09-04").untilDate).toBe("2026-09-11");
    expect(suppressionWindowFor("supply_already_arranged", "2026-09-04").untilDate).toBe("2026-10-04");
  });

  it("到期即失效；管道量回升（供应落库）提前解除", () => {
    const base = { untilDate: "2026-09-11", releaseOnArrival: true, pipelineBaseline: 100, today: "2026-09-05" };
    expect(suppressionState({ ...base, pipelineNow: 100 })).toMatchObject({ active: true, daysLeft: 6 });
    expect(suppressionState({ ...base, pipelineNow: 400 })).toMatchObject({ active: false, releasedBy: "supply_arrived" });
    expect(suppressionState({ ...base, pipelineNow: 100, today: "2026-09-12" })).toMatchObject({ active: false, releasedBy: "expired" });
    // 不随到货解除的原因，管道量涨了也照压
    expect(suppressionState({ ...base, releaseOnArrival: false, pipelineNow: 400 })).toMatchObject({ active: true });
  });
});

async function seedShortage(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [pmc] = await db.insert(schema.users).values({ name: "计划员", roles: ["pmc"] }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: "CP00001", name: "面霜", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  const [wh] = await db.insert(schema.warehouses).values({ code: "WH-CP", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();
  for (const ym of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
    await db.insert(schema.salesMonthly).values({ skuId: sku.id, channelId: ch.id, yearMonth: ym, qty: "900" });
  }
  await db.insert(schema.skuParams).values({ skuId: sku.id, normalLeadDays: 30, logisticsLeadDays: 15 });
  await db.insert(schema.stockBalances).values({ skuId: sku.id, warehouseId: wh.id, qty: "100" });
  const user: SessionUser = { id: pmc.id, name: pmc.name, roles: ["pmc"] } as SessionUser;
  return { sku, wh, user };
}

describe("放弃 → 抑制窗口（W2-#6）", () => {
  it("放弃后同一 SKU 不再重复建议，但行上明确标出抑制、原因、到期日与被扣下的建议量", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku, user } = await seedShortage(db);
      const before = await getReplenishSuggestions({ allRows: true }, db);
      const rowBefore = before.rows.find((r) => r.skuId === sku.id)!;
      expect(rowBefore.suggestQty, "先要有一条真建议，否则测的是空气").not.toBeNull();
      expect(rowBefore.suppression).toBeNull();

      const res = await declineReplenishSuggestion(user, { skuId: sku.id, reason: "本月已跟工厂口头约好一批", reasonCode: "supply_already_arranged" }, db);
      expect(res.duplicate).toBe(false);
      expect(res.suppression).not.toBeNull();
      expect(res.suppression!.releaseOnArrival).toBe(true);
      expect(res.suppression!.days).toBe(30);

      const after = await getReplenishSuggestions({ allRows: true }, db);
      const row = after.rows.find((r) => r.skuId === sku.id)!;
      expect(row.suggestQty, "下一次运行不得再给同一条建议").toBeNull();
      expect(row.heldQty, "被扣下的量必须保留，人工勾选即可放行").toBe(rowBefore.suggestQty);
      expect(row.suppression).not.toBeNull();
      expect(row.suppression!.reasonCode).toBe("supply_already_arranged");
      expect(row.suppression!.reason).toBe("本月已跟工厂口头约好一批");
      expect(row.suppression!.untilDate).toBe(suppressionWindowFor("supply_already_arranged", todayShanghai()).untilDate);
      expect(row.suppression!.withheldQty).toBe(rowBefore.suggestQty);
      expect(row.noSuggestReason?.code, "抑制不许静默：必须能从行上读出为什么没建议").toBe("decline_suppressed");
      expect(row.noSuggestReason!.text).toContain("抑制至");
      expect(after.meta.declineSuppressedCount).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("「供应已安排」的抑制在那批供应真的落库后自动解除", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku, wh, user } = await seedShortage(db);
      await declineReplenishSuggestion(user, { skuId: sku.id, reason: "已跟工厂约好一批", reasonCode: "supply_already_arranged" }, db);
      expect((await getReplenishSuggestions({ allRows: true }, db)).rows.find((r) => r.skuId === sku.id)!.suppression).not.toBeNull();

      // 那批「系统看不见」的供应落库：管道量回升
      await db.update(schema.stockBalances).set({ qty: "9000" }).where(eq(schema.stockBalances.skuId, sku.id));
      const after = await getReplenishSuggestions({ allRows: true }, db);
      const row = after.rows.find((r) => r.skuId === sku.id)!;
      expect(row.suppression, "供应兑现了，抑制就该自己解除").toBeNull();
      expect(row.planExplain.some((l) => l.includes("自动解除"))).toBe(true);
      expect(wh.id).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("人工可随时解除；解除后建议立刻恢复", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku, user } = await seedShortage(db);
      const declined = await declineReplenishSuggestion(user, { skuId: sku.id, reason: "促销尾巴，日均虚高", reasonCode: "demand_overstated" }, db);
      const suppressionId = declined.suppression!.id;
      expect(declined.suppression!.days).toBe(7); // 需求判断压得最短

      await clearReplenishSuppression(user, { id: suppressionId, note: "复盘后确认需求真实" }, db);
      const row = (await getReplenishSuggestions({ allRows: true }, db)).rows.find((r) => r.skuId === sku.id)!;
      expect(row.suppression).toBeNull();
      expect(row.suggestQty).not.toBeNull();

      await expect(clearReplenishSuppression(user, { id: suppressionId }, db)).rejects.toMatchObject({ status: 409 });
    } finally {
      await client.close();
    }
  });

  it("同一 SKU 改主意重新放弃：旧抑制留痕作废，新窗口生效（唯一索引不得把改主意判成冲突）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { sku, user } = await seedShortage(db);
      const [other] = await db.insert(schema.users).values({ name: "计划员乙", roles: ["pmc"] }).returning();
      const first = await declineReplenishSuggestion(user, { skuId: sku.id, reason: "促销尾巴，日均虚高", reasonCode: "demand_overstated" }, db);
      const second = await declineReplenishSuggestion(
        { id: other.id, name: other.name, roles: ["pmc"] } as SessionUser,
        { skuId: sku.id, reason: "改判：其实是已经安排了供应", reasonCode: "supply_already_arranged" },
        db,
      );
      expect(second.suppression!.id).not.toBe(first.suppression!.id);
      const rows = await db.select().from(schema.replenishSuppressions);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.clearedAt == null)).toHaveLength(1);
      const row = (await getReplenishSuggestions({ allRows: true }, db)).rows.find((r) => r.skuId === sku.id)!;
      expect(row.suppression!.reasonCode).toBe("supply_already_arranged");
    } finally {
      await client.close();
    }
  });
});
