/**
 * 红队审计 A6：打盹是**展示层**策略，不是静音开关。
 *
 * exception-dismissals 模块头、打盹路由文案与页面都写着"只影响展示：不改告警状态、不动待办"，
 * 可 jobs/notify.runExceptionNotify 调的是同一个 computeExceptions(db)（默认过滤打盹），
 * 于是 pmc/purchasing/ops/warehouse 任一角色打个盹，就能让一条 critical 例外**最长 90 天不再推送**。
 * 这里钉住：打盹后页面不显示、但推送照常入队；同时推送路径不推进"连续出现天数"
 * （否则那个计数量的是"例外存在了几天"，而页面把它当"连续 N 天摆在人面前没人管"来读）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeExceptions } from "@/server/modules/workbench/focus";
import { loadExceptionMemory, shanghaiDay, snoozeException } from "@/server/modules/workbench/exception-dismissals";
import { runExceptionNotify } from "@/jobs/notify";

type Db = Awaited<ReturnType<typeof createTestDb>>["db"];

/** 造一条必然出现的例外：已过期批次库存 → key=expired_stock（与 exception-dismissals 测试同一份造数） */
async function seedExpiredStock(db: Db) {
  const [spu] = await db.insert(schema.spus).values({ code: "NP1", nameCn: "推送测试" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: "NS1", name: "NS1", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [wh] = await db.insert(schema.warehouses).values({ code: "NW1", name: "主仓", kind: "finished", accountingMode: "realtime", active: true }).returning();
  await db.insert(schema.batchStocks).values({
    skuId: sku.id, warehouseId: wh.id, batchNo: "NB1", qty: "10.0000", expiryDate: "2020-01-01", stocktakeDate: shanghaiDay(),
  });
}

const dayOffset = (n: number): string =>
  new Date(Date.parse(`${shanghaiDay()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("红队 A6：打盹只影响展示，不静音推送", () => {
  it("打盹后控制塔不显示该例外，但 runExceptionNotify 照常入队", async () => {
    const { db, client } = await createTestDb();
    try {
      const [u] = await db.insert(schema.users).values({ name: "计划员", roles: ["pmc"] }).returning();
      await seedExpiredStock(db);
      expect((await computeExceptions(db)).map((i) => i.key)).toContain("expired_stock");

      await snoozeException({ id: u.id, name: u.name, roles: ["pmc"], isApprover: false },
        { exceptionKey: "expired_stock", until: dayOffset(30), note: "已排报废评审" }, db);

      // 展示：隐藏
      expect((await computeExceptions(db)).map((i) => i.key)).not.toContain("expired_stock");
      // 推送：照常（修复前这里是 0 条——打盹把 30 天的推送一起静音了）
      const r = await runExceptionNotify(db);
      expect(r.enqueued).toBeGreaterThanOrEqual(1);
      const notes = await db.select().from(schema.notifications);
      expect(notes.some((n) => n.dedupeKey?.startsWith("expired_stock:"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("推送路径不推进「连续出现天数」——那个计数只应由人真的看到来推进", async () => {
    const { db, client } = await createTestDb();
    try {
      await seedExpiredStock(db);
      // 只跑推送任务，不进页面
      await runExceptionNotify(db);
      const afterNotify = await loadExceptionMemory(db);
      expect(afterNotify.get("expired_stock")?.consecutiveDays ?? 0).toBe(0);

      // 人打开控制塔 → 计数才从 1 起算
      const shown = await computeExceptions(db);
      expect(shown.find((i) => i.key === "expired_stock")?.daysShown).toBe(1);
      const afterView = await loadExceptionMemory(db);
      expect(afterView.get("expired_stock")?.consecutiveDays).toBe(1);
      expect(afterView.get("expired_stock")?.lastShownOn).toBe(shanghaiDay());

      // 推送再跑一次也不会把计数推到 2
      await db.delete(schema.notifications).where(eq(schema.notifications.channel, "in_app"));
      await runExceptionNotify(db);
      expect((await loadExceptionMemory(db)).get("expired_stock")?.consecutiveDays).toBe(1);
    } finally {
      await client.close();
    }
  });
});
