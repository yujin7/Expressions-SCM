/**
 * 预警引擎增量（审计 #4 / #10 / A3(2)）：
 * - why[] 落 paramsSnapshot.why（开新与刷新都写）；
 * - 已知悉再命中：严重度升级立即清知悉；同级 ≥ 7 天清知悉；< 7 天保留；
 * - suppressManuallyClosedDays：窗口内人工关闭的同键不重开（自动关闭的照常重开）。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { upsertAlerts } from "@/server/modules/alerts/engine";

const cand = (k: string, severity: "medium" | "high" | "critical" = "medium", why?: { label: string; value: string; source: string }[]) => ({
  refKey: k, dedupeKey: `t:${k}`, title: `告警 ${k}`, severity, ownerRole: "pmc", paramsSnapshot: { a: 1 }, why,
});

describe("预警引擎：why 载荷", () => {
  it("开新与刷新都把 why 写进 paramsSnapshot.why；why 为空时不覆盖其他快照字段", async () => {
    const { db, client } = await createTestDb();
    try {
      const t0 = new Date("2026-09-03T03:00:00.000Z");
      await upsertAlerts(db, { category: "why_cat", candidates: [cand("A", "medium", [{ label: "阈值", value: "35 天", source: "rules/alert-threshold" }])], now: t0 });
      const [a] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "A"));
      expect(a.paramsSnapshot).toEqual({ a: 1, why: [{ label: "阈值", value: "35 天", source: "rules/alert-threshold" }] });
      await upsertAlerts(db, { category: "why_cat", candidates: [cand("A", "medium", [{ label: "阈值", value: "36 天", source: "rules/alert-threshold" }])], now: new Date("2026-09-03T04:00:00.000Z") });
      const [a2] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, a.id));
      expect((a2.paramsSnapshot as { why: { value: string }[] }).why[0].value).toBe("36 天");
      await upsertAlerts(db, { category: "why_cat", candidates: [cand("B")], now: t0 });
      const [b] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "B"));
      expect(b.paramsSnapshot).toEqual({ a: 1 });
    } finally {
      await client.close();
    }
  });
});

describe("预警引擎：已知悉再命中的清知悉规则", () => {
  it("严重度升级 → 立即清；同级 < 7 天保留；同级 ≥ 7 天清", async () => {
    const { db, client } = await createTestDb();
    try {
      const [u] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"] }).returning();
      const t0 = new Date("2026-09-01T03:00:00.000Z");
      await upsertAlerts(db, { category: "ack_cat", candidates: [cand("A"), cand("B")], now: t0 });
      await db.update(schema.systemAlerts).set({ ackedBy: u.id, ackedAt: t0 }).where(eq(schema.systemAlerts.category, "ack_cat"));
      // 第 2 天：A 升级 high → 清；B 同级 → 保留
      const r1 = await upsertAlerts(db, { category: "ack_cat", candidates: [cand("A", "high"), cand("B")], now: new Date("2026-09-02T03:00:00.000Z") });
      expect(r1.ackReset).toBe(1);
      const [a] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "A"));
      expect(a.ackedAt).toBeNull();
      expect(a.ackedBy).toBeNull();
      const [b] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "B"));
      expect(b.ackedBy).toBe(u.id);
      // 第 8 天：B 仍同级但知悉已满 7 天 → 清
      const r2 = await upsertAlerts(db, { category: "ack_cat", candidates: [cand("A", "high"), cand("B")], now: new Date("2026-09-08T03:00:00.000Z") });
      expect(r2.ackReset).toBe(1);
      const [b2] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "B"));
      expect(b2.ackedAt).toBeNull();
      expect(b2.status).toBe("open");
    } finally {
      await client.close();
    }
  });
});

describe("预警引擎：人工关闭抑制", () => {
  it("窗口内人工关闭（autoResolved=false）的同键不重开、计 suppressed；自动关闭 / 窗口外的照常重开；未启用选项时不抑制", async () => {
    const { db, client } = await createTestDb();
    try {
      const now = new Date("2026-09-04T03:00:00.000Z");
      const day = 24 * 3600 * 1000;
      await db.insert(schema.systemAlerts).values([
        { category: "sup_cat", refKey: "M", dedupeKey: "t:M", title: "人工关", severity: "high", status: "resolved", autoResolved: false, resolvedAt: new Date(now.getTime() - 10 * day) },
        { category: "sup_cat", refKey: "O", dedupeKey: "t:O", title: "人工关但太久", severity: "high", status: "resolved", autoResolved: false, resolvedAt: new Date(now.getTime() - 200 * day) },
        { category: "sup_cat", refKey: "S", dedupeKey: "t:S", title: "系统关", severity: "high", status: "resolved", autoResolved: true, resolvedAt: new Date(now.getTime() - 1 * day) },
      ]);
      const r = await upsertAlerts(db, { category: "sup_cat", candidates: [cand("M"), cand("O"), cand("S"), cand("N")], now, suppressManuallyClosedDays: 180 });
      expect(r).toMatchObject({ opened: 3, suppressed: 1, refreshed: 0 });
      const open = await db.select({ refKey: schema.systemAlerts.refKey }).from(schema.systemAlerts).where(eq(schema.systemAlerts.status, "open"));
      expect(open.map((o) => o.refKey).sort()).toEqual(["N", "O", "S"]);
      // 未启用抑制：M 也会开
      const r2 = await upsertAlerts(db, { category: "sup_cat", candidates: [cand("M")], now: new Date(now.getTime() + 3600_000), autoCloseAfterDays: 99 });
      expect(r2).toMatchObject({ opened: 1, suppressed: 0 });
    } finally {
      await client.close();
    }
  });
});
