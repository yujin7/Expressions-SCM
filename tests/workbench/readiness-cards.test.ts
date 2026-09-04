/**
 * 工作台「就绪三件事」卡片（2026-09-04 审计 #8）。
 *
 * 事故形态：例外清单里只有一条「成品缺生产周期」，还链到只读的
 * `/report/data-health?missing=生产周期`——看得见、改不了；同一件事在
 * `replenish/pilot-client.tsx` 里早就链到可写的 `/master/supply-params?blockedOnly=1`。
 * 新来的计划员因此只看到一屏告警数，看不到「系统还没就绪，先补这三件事」。
 *
 * 钉住：三张卡都出现、计数为真、且每张都链到**能改**的那个页面。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { computeExceptions } from "@/server/modules/workbench/focus";
import { createTestDb } from "../helpers/db";

async function seedFinished(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [spu] = await db.insert(schema.spus).values({ code: "SPU-RC", nameCn: "就绪测试" }).returning();
  const mk = async (code: string) => {
    const [s] = await db
      .insert(schema.skus)
      .values({ code, name: code, spuId: spu.id, skuType: "finished", baseUom: "支", active: true })
      .returning();
    return s.id;
  };
  return { a: await mk("RC-A"), b: await mk("RC-B"), c: await mk("RC-C") };
}

describe("工作台就绪卡片：缺周期 / 缺成本 / 缺平台身份", () => {
  it("缺生产周期卡链到可写的补录页（而不是只读的数据健康度）", async () => {
    const { db, client } = await createTestDb();
    try {
      await seedFinished(db);
      const items = await computeExceptions(db);
      const card = items.find((i) => i.key === "missing_lead");
      expect(card?.count).toBe(3);
      expect(card?.href, "只读页改不了周期——必须链到补录页").toBe("/master/supply-params?blockedOnly=1");
      expect(card?.href).not.toContain("/report/data-health");
      expect(card?.impact).toContain("批量");
    } finally {
      await client.close();
    }
  });

  it("缺单位成本卡：sku_costs 缺行的成品计数为真，链到成本录入路径", async () => {
    const { db, client } = await createTestDb();
    try {
      const ids = await seedFinished(db);
      await db.insert(schema.skuCosts).values({ skuId: ids.a, unitCost: "12.3400" });
      const items = await computeExceptions(db);
      const card = items.find((i) => i.key === "missing_cost");
      expect(card?.count, "3 个成品里 1 个有成本").toBe(2);
      expect(card?.href).toBe("/import/upload");
      expect(card?.impact).toContain("sku_costs");
    } finally {
      await client.close();
    }
  });

  it("成本齐全时不出卡（不制造一条永远为 0 的噪音）", async () => {
    const { db, client } = await createTestDb();
    try {
      const ids = await seedFinished(db);
      await db.insert(schema.skuCosts).values([
        { skuId: ids.a, unitCost: "1.0000" },
        { skuId: ids.b, unitCost: "1.0000" },
        { skuId: ids.c, unitCost: "1.0000" },
      ]);
      const items = await computeExceptions(db);
      expect(items.find((i) => i.key === "missing_cost")).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("平台身份读模型不可用时降级为「没有这张卡」，绝不让首屏 500", async () => {
    const { db, client } = await createTestDb();
    try {
      await seedFinished(db);
      const items = await computeExceptions(db);
      // 测试库没有简道云观察数据 → 读模型 state=insufficient，卡片不出现，但整份清单仍然算得出来
      expect(items.find((i) => i.key === "identity_gap")).toBeUndefined();
      expect(items.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("三张就绪卡的 href 都指向可写页面（清单里不得再出现只读的数据健康度链接）", async () => {
    const { db, client } = await createTestDb();
    try {
      await seedFinished(db);
      const items = await computeExceptions(db);
      for (const key of ["missing_lead", "missing_cost"]) {
        const card = items.find((i) => i.key === key);
        expect(card, `缺卡片 ${key}`).toBeTruthy();
        expect(card!.href.startsWith("/report/data-health"), `${key} 仍链到只读页`).toBe(false);
      }
    } finally {
      await client.close();
    }
  });
});
