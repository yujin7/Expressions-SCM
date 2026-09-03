/**
 * alert_events 台账（闭环审计 #2）：引擎写 open/refresh/close(auto_hysteresis)、人工 ack/close 写事件与审计；
 * 表由数据库触发器强制只追加；closeAlert 权限 = ownerRole 或 admin。
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { ackAlert, closeAlert, upsertAlerts } from "@/server/modules/alerts/engine";

const cand = (k: string, ownerRole: string | null = "pmc") => ({
  refKey: k, dedupeKey: `t:${k}`, title: `告警 ${k}`, severity: "high" as const, ownerRole, actionHref: "/inventory/alerts",
});

/** drizzle 把驱动错误包成 "Failed query: …"，触发器原文在 cause 里（与 tests/inventory/bin-operations 同型） */
async function expectAppendOnlyRejection(query: PromiseLike<unknown>) {
  try {
    await query;
    throw new Error("expected append-only rejection");
  } catch (error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    expect(`${(error as Error).message}\n${cause instanceof Error ? cause.message : ""}`).toMatch(/append-only/i);
  }
}

describe("alert_events 台账", () => {
  it("引擎：open 一条、同日多次命中只一条 refresh、迟滞关闭写 close(auto_hysteresis)；表只追加", async () => {
    const { db, client } = await createTestDb();
    try {
      const t0 = new Date("2026-09-03T03:00:00.000Z");
      await upsertAlerts(db, { category: "test_cat", candidates: [cand("A"), cand("B")], now: t0 });
      const events = () => db.select().from(schema.alertEvents).orderBy(schema.alertEvents.id);
      expect((await events()).map((e) => e.event)).toEqual(["open", "open"]);

      // 同一上海日再命中两次 → refresh 只落一条（幂等键按日）
      await upsertAlerts(db, { category: "test_cat", candidates: [cand("A")], now: new Date(t0.getTime() + 3_600_000) });
      await upsertAlerts(db, { category: "test_cat", candidates: [cand("A")], now: new Date(t0.getTime() + 7_200_000) });
      expect((await events()).filter((e) => e.event === "refresh")).toHaveLength(1);
      // 次日再命中 → 第二条 refresh
      await upsertAlerts(db, { category: "test_cat", candidates: [cand("A")], now: new Date("2026-09-04T03:00:00.000Z") });
      expect((await events()).filter((e) => e.event === "refresh")).toHaveLength(2);

      // B 3 天未命中 → 迟滞关闭 → close(auto_hysteresis)，actor 为空
      await upsertAlerts(db, { category: "test_cat", candidates: [cand("A")], now: new Date("2026-09-06T03:00:00.000Z") });
      const [b] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "B"));
      const closes = (await events()).filter((e) => e.event === "close");
      expect(closes).toHaveLength(1);
      expect(closes[0]).toMatchObject({ alertId: b.id, reasonCode: "auto_hysteresis", actorId: null });

      // 只追加：UPDATE / DELETE / TRUNCATE 全部被触发器拒绝
      await expectAppendOnlyRejection(db.update(schema.alertEvents).set({ note: "改" }).where(eq(schema.alertEvents.id, closes[0].id)));
      await expectAppendOnlyRejection(db.delete(schema.alertEvents).where(eq(schema.alertEvents.id, closes[0].id)));
      await expectAppendOnlyRejection(db.execute(sql`TRUNCATE alert_events`));
      expect((await events()).find((e) => e.id === closes[0].id)?.note).not.toBe("改");
      // CHECK：close 必须带原因码；verify 必须带证据
      await expect(db.insert(schema.alertEvents).values({ alertId: b.id, event: "close", idempotencyKey: "bad-close" })).rejects.toThrow();
      await expect(db.insert(schema.alertEvents).values({ alertId: b.id, event: "verify", idempotencyKey: "bad-verify" })).rejects.toThrow();
      await expect(db.insert(schema.alertEvents).values({ alertId: b.id, event: "bogus", idempotencyKey: "bad-event" })).rejects.toThrow();
      // 幂等键唯一：重复键静默跳过而不是双写（引擎路径）
      const before = (await events()).length;
      await upsertAlerts(db, { category: "test_cat", candidates: [cand("A")], now: new Date("2026-09-06T05:00:00.000Z") });
      expect((await events()).length).toBe(before);
    } finally {
      await client.close();
    }
  });

  it("closeAlert：ownerRole/admin 才能关，非法原因 400，同事务写审计 + close 事件，重复关闭 409；ack 也落事件", async () => {
    const { db, client } = await createTestDb();
    try {
      const mk = async (name: string, roles: string[]) => {
        const [u] = await db.insert(schema.users).values({ name, roles }).returning();
        return { id: u.id, name: u.name, roles, isApprover: false };
      };
      const pmc = await mk("计划", ["pmc"]);
      const ops = await mk("运营", ["ops"]);
      const admin = await mk("管理员", ["admin"]);
      const t0 = new Date("2026-09-03T03:00:00.000Z");
      await upsertAlerts(db, { category: "test_cat", candidates: [cand("A"), cand("B"), cand("C", null)], now: t0 });
      const byRef = async (k: string) => (await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, k)))[0];
      const a = await byRef("A");

      await expect(closeAlert(ops, a.id, "fixed", null, db)).rejects.toThrow(/无权限/);
      await expect(closeAlert(pmc, a.id, "auto_hysteresis", null, db)).rejects.toThrow(/关闭原因非法/);
      await expect(closeAlert(pmc, a.id, "whatever", null, db)).rejects.toThrow(/关闭原因非法/);
      await expect(closeAlert(pmc, 0, "fixed", null, db)).rejects.toThrow(/非法/);
      await expect(closeAlert(pmc, 99999, "fixed", null, db)).rejects.toThrow(/不存在/);

      const tClose = new Date("2026-09-03T05:00:00.000Z");
      const r = await closeAlert(pmc, a.id, "false_positive", "参考仓有货，误报", db, { now: tClose });
      expect(r).toEqual({ id: a.id, resolvedAt: tClose.toISOString(), reasonCode: "false_positive" });
      const a2 = await byRef("A");
      expect(a2).toMatchObject({ status: "resolved", autoResolved: false });
      expect(a2.resolvedAt).toEqual(tClose);
      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "system_alert"));
      expect(audits.map((x) => x.action)).toEqual(["close"]);
      expect((audits[0].after as { reasonCode: string }).reasonCode).toBe("false_positive");
      const closeEv = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "close"));
      expect(closeEv).toHaveLength(1);
      expect(closeEv[0]).toMatchObject({ alertId: a.id, actorId: pmc.id, reasonCode: "false_positive", note: "参考仓有货，误报" });
      await expect(closeAlert(pmc, a.id, "fixed", null, db)).rejects.toThrow(/已关闭/);

      // ownerRole 为空的告警：pmc 不能关，admin 可以
      const c = await byRef("C");
      await expect(closeAlert(pmc, c.id, "fixed", null, db)).rejects.toThrow(/无权限/);
      await closeAlert(admin, c.id, "wont_fix", null, db);
      expect((await byRef("C")).status).toBe("resolved");

      // ack 落 ack 事件（带 actor）
      const b = await byRef("B");
      await ackAlert(pmc, b.id, db, "看到了");
      const ackEv = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "ack"));
      expect(ackEv).toHaveLength(1);
      expect(ackEv[0]).toMatchObject({ alertId: b.id, actorId: pmc.id, note: "看到了" });
      // 引擎下一轮不会因人工关闭而"复活"：A 已 resolved，同键再命中是新开告警（新 open 事件）
      await upsertAlerts(db, { category: "test_cat", candidates: [cand("A")], now: new Date("2026-09-04T03:00:00.000Z") });
      const opens = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "open"));
      expect(opens).toHaveLength(4);
    } finally {
      await client.close();
    }
  });
});
