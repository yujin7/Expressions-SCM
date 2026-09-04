/**
 * W9 例外打盹 / 忽略 + 连续出现天数（workbench/exception-dismissals + focus.computeExceptions）。
 *
 * 立项证据：控制塔的例外每次进页面现算、没有任何记忆——一条已知会的例外压不下去，
 * 也答不出"这条连续挂了 40 天没人点"。这里钉住四件事：
 *  1) 打盹在到期日（含当日）之前把该键整条隐藏，到期次日自动恢复——不需要人再点一次；
 *  2) 打盹是全局写路径：同事务写 audit_logs（action=snooze / snooze_clear），
 *     没有审计的"全员可见的隐藏"是不可复盘的；
 *  3) 连续出现天数按上海日推进：同日重复计算不翻倍、隔天 +1、断一天从 1 重来；
 *  4) 白名单外的键写不进去（能存进去 ≠ 有意义），打盹时长有上限（无限期打盹等于掩埋）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeExceptions } from "@/server/modules/workbench/focus";
import {
  EXCEPTION_KEYS,
  MAX_SNOOZE_DAYS,
  clearExceptionSnooze,
  loadExceptionMemory,
  recordExceptionsShown,
  shanghaiDay,
  snoozeException,
  snoozedKeys,
} from "@/server/modules/workbench/exception-dismissals";

type Db = Awaited<ReturnType<typeof createTestDb>>["db"];

const ACTOR = { id: 0, name: "计划员", roles: ["pmc"], isApprover: false };

async function actor(db: Db) {
  const [u] = await db.insert(schema.users).values({ name: "计划员", roles: ["pmc"] }).returning();
  return { ...ACTOR, id: u.id };
}

/** 造一条必然出现的例外：已过期批次库存 → key=expired_stock */
async function seedExpiredStock(db: Db) {
  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "打盹测试" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: "S1", name: "S1", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [wh] = await db.insert(schema.warehouses).values({ code: "W1", name: "主仓", kind: "finished", accountingMode: "realtime", active: true }).returning();
  await db.insert(schema.batchStocks).values({
    skuId: sku.id, warehouseId: wh.id, batchNo: "B1", qty: "10.0000", expiryDate: "2020-01-01", stocktakeDate: shanghaiDay(),
  });
}

const dayOffset = (n: number): string =>
  new Date(Date.parse(`${shanghaiDay()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("W9 例外打盹与连续出现天数", () => {
  it("打盹期间整条隐藏、到期后自动恢复；写审计", async () => {
    const { db, client } = await createTestDb();
    try {
      const me = await actor(db);
      await seedExpiredStock(db);

      const before = await computeExceptions(db);
      expect(before.map((i) => i.key)).toContain("expired_stock");

      await snoozeException(me, { exceptionKey: "expired_stock", until: dayOffset(2), note: "已排报废评审，本周处理" }, db);
      expect(await snoozedKeys(db, shanghaiDay())).toEqual(["expired_stock"]);
      const hidden = await computeExceptions(db);
      expect(hidden.map((i) => i.key), "打盹未到期应整条隐藏").not.toContain("expired_stock");

      // 审计：全员可见的隐藏必须可复盘
      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "workbench_exception"));
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe("snooze");
      expect((audits[0].after as { note?: string }).note).toContain("报废评审");

      // 到期日当天仍隐藏，次日自动恢复（不需要人再点一次）
      await db.update(schema.exceptionDismissals).set({ snoozedUntil: shanghaiDay() })
        .where(eq(schema.exceptionDismissals.exceptionKey, "expired_stock"));
      expect((await computeExceptions(db)).map((i) => i.key)).not.toContain("expired_stock");
      await db.update(schema.exceptionDismissals).set({ snoozedUntil: dayOffset(-1) })
        .where(eq(schema.exceptionDismissals.exceptionKey, "expired_stock"));
      expect((await computeExceptions(db)).map((i) => i.key)).toContain("expired_stock");
    } finally {
      await client.close();
    }
  });

  it("提前取消打盹立即恢复显示，并写第二条审计", async () => {
    const { db, client } = await createTestDb();
    try {
      const me = await actor(db);
      await seedExpiredStock(db);
      await snoozeException(me, { exceptionKey: "expired_stock", until: dayOffset(5), note: "等到货" }, db);
      expect((await computeExceptions(db)).map((i) => i.key)).not.toContain("expired_stock");

      const cleared = await clearExceptionSnooze(me, "expired_stock", db);
      expect(cleared.cleared).toBe(true);
      expect((await computeExceptions(db)).map((i) => i.key)).toContain("expired_stock");
      const actions = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "workbench_exception")))
        .map((a) => a.action).sort();
      expect(actions).toEqual(["snooze", "snooze_clear"]);

      // 幂等：没在打盹的键再取消一次不报错，也不重复写审计
      expect((await clearExceptionSnooze(me, "expired_stock", db)).cleared).toBe(false);
      expect(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "workbench_exception"))).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("连续出现天数：同日不翻倍、隔天 +1、断一天从 1 重来", async () => {
    const { db, client } = await createTestDb();
    try {
      const days = ["2026-09-01", "2026-09-02", "2026-09-05"];
      await recordExceptionsShown(db, ["below_lead"], days[0]);
      await recordExceptionsShown(db, ["below_lead"], days[0]); // 同日再算一次
      expect((await loadExceptionMemory(db)).get("below_lead")?.consecutiveDays).toBe(1);

      await recordExceptionsShown(db, ["below_lead"], days[1]);
      expect((await loadExceptionMemory(db)).get("below_lead")?.consecutiveDays).toBe(2);

      await recordExceptionsShown(db, ["below_lead"], days[2]); // 中间断了两天
      const mem = (await loadExceptionMemory(db)).get("below_lead");
      expect(mem?.consecutiveDays).toBe(1);
      expect(mem?.lastShownOn).toBe(days[2]);
    } finally {
      await client.close();
    }
  });

  it("computeExceptions 把连续天数带给前端，并在当天推进计数", async () => {
    const { db, client } = await createTestDb();
    try {
      await seedExpiredStock(db);
      const first = await computeExceptions(db);
      expect(first.find((i) => i.key === "expired_stock")?.daysShown).toBe(1);

      // 同一天再进一次页面不该把"连续 1 天"变成 2 天
      const second = await computeExceptions(db);
      expect(second.find((i) => i.key === "expired_stock")?.daysShown).toBe(1);

      // 昨天已记过 → 今天算出来是第 2 天
      const yesterday = new Date(Date.parse(`${shanghaiDay()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      await db.update(schema.exceptionDismissals).set({ lastShownOn: yesterday, consecutiveDays: 6 })
        .where(eq(schema.exceptionDismissals.exceptionKey, "expired_stock"));
      const third = await computeExceptions(db);
      expect(third.find((i) => i.key === "expired_stock")?.daysShown).toBe(7);
    } finally {
      await client.close();
    }
  });

  it("白名单外的键、非法日期与超长打盹一律拒绝", async () => {
    const { db, client } = await createTestDb();
    try {
      const me = await actor(db);
      await expect(snoozeException(me, { exceptionKey: "made_up_key", until: dayOffset(1), note: "x" }, db))
        .rejects.toThrow(/未知例外键/);
      await expect(snoozeException(me, { exceptionKey: "below_lead", until: "2026/09/01", note: "x" }, db))
        .rejects.toThrow(/YYYY-MM-DD/);
      await expect(snoozeException(me, { exceptionKey: "below_lead", until: dayOffset(-1), note: "x" }, db))
        .rejects.toThrow(/不能早于今天/);
      await expect(snoozeException(me, { exceptionKey: "below_lead", until: dayOffset(MAX_SNOOZE_DAYS + 1), note: "x" }, db))
        .rejects.toThrow(/最长/);
      await expect(snoozeException(me, { exceptionKey: "below_lead", until: dayOffset(1), note: "   " }, db))
        .rejects.toThrow(/原因/);
      // 一条都没写进去
      expect(await db.select().from(schema.exceptionDismissals)).toHaveLength(0);
      // 未登记的键连计数都不记（垃圾行不会因为读路径而长出来）
      expect(await recordExceptionsShown(db, ["made_up_key"], shanghaiDay())).toBe(0);
      expect(await db.select().from(schema.exceptionDismissals)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("白名单与 computeExceptions 产出的键一一对应（新增例外必须同步登记，否则永远打不了盹）", async () => {
    const focusSrc = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve(__dirname, "../../src/server/modules/workbench/focus.ts"),
      "utf8",
    );
    const produced = [...focusSrc.matchAll(/\bkey:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const inFocus = new Set(produced.filter((k) => !k.startsWith("q_")));
    for (const k of EXCEPTION_KEYS) expect(inFocus.has(k), `${k} 已不再由 computeExceptions 产出`).toBe(true);
  });
});
