/**
 * 预警引擎（D56/D57）：去重键幂等、迟滞自动关闭、人工已知悉写审计。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { ackAlert, countOpenAlerts, upsertAlerts } from "@/server/modules/alerts/engine";

describe("预警引擎", () => {
  it("显式空资格名单不关旧项；指定对象仍遵守迟滞，空历史键不猜测认领", async () => {
    const { db, client } = await createTestDb();
    try {
      const t0 = new Date("2026-09-01T03:00:00Z");
      await upsertAlerts(db, { category: "coverage_test", now: t0, candidates: ["A", "B"].map((key) => ({
        dedupeKey: key, refKey: key, title: key, severity: "high", ownerRole: "pmc", actionHref: "/alerts",
      })) });
      await db.insert(schema.systemAlerts).values({ category: "coverage_test", title: "legacy", severity: "high", status: "open", lastHitAt: t0 });
      expect(await upsertAlerts(db, { category: "coverage_test", candidates: [], autoCloseEligibleKeys: ["A"], now: new Date("2026-09-02T03:00:00Z") })).toMatchObject({ autoClosed: 0 });
      expect(await upsertAlerts(db, { category: "coverage_test", candidates: [], autoCloseEligibleKeys: [], now: new Date("2026-09-10T03:00:00Z") })).toMatchObject({ autoClosed: 0, stillOpen: 3 });
      expect(await upsertAlerts(db, { category: "coverage_test", candidates: [], autoCloseEligibleKeys: ["A"], now: new Date("2026-09-10T03:00:00Z") })).toMatchObject({ autoClosed: 1, stillOpen: 2 });
      const rows = await db.select().from(schema.systemAlerts);
      expect(rows.find((r) => r.dedupeKey === "B")?.status).toBe("open");
      expect(rows.find((r) => r.dedupeKey === null)?.status).toBe("open");
    } finally { await client.close(); }
  });
  it("同 dedupeKey 只保留一条 open；再次命中只续命；3 天不命中才自动关闭；已知悉写审计不改 status", async () => {
    const { db, client } = await createTestDb();
    try {
      const [u] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"] }).returning();
      const t0 = new Date("2026-09-03T03:00:00.000Z");
      const cand = (k: string) => ({ refKey: k, dedupeKey: `t:${k}`, title: `告警 ${k}`, severity: "high" as const, ownerRole: "pmc", actionHref: "/inventory/alerts" });
      const r1 = await upsertAlerts(db, { category: "test_cat", candidates: [cand("A"), cand("B"), cand("A")], now: t0 });
      expect(r1).toMatchObject({ opened: 2, refreshed: 0, autoClosed: 0, stillOpen: 2 });
      // 第二轮：A 续命，B 未命中但未满 3 天 → 不关
      const t1 = new Date("2026-09-04T03:00:00.000Z");
      const r2 = await upsertAlerts(db, { category: "test_cat", candidates: [cand("A")], now: t1 });
      expect(r2).toMatchObject({ opened: 0, refreshed: 1, autoClosed: 0, stillOpen: 2 });
      // 第四轮：B 已 3 天未命中 → 自动关闭
      const t3 = new Date("2026-09-06T03:00:00.000Z");
      const r3 = await upsertAlerts(db, { category: "test_cat", candidates: [cand("A")], now: t3 });
      expect(r3).toMatchObject({ autoClosed: 1, stillOpen: 1 });
      const [b] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "B"));
      expect(b.status).toBe("resolved");
      expect(b.autoResolved).toBe(true);
      // 已知悉
      const [a] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "A"));
      const ack = await ackAlert({ id: u.id, name: u.name, roles: ["pmc"], isApprover: false }, a.id, db, "看到了");
      expect(ack.id).toBe(a.id);
      const [a2] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, a.id));
      expect(a2.status).toBe("open");
      expect(a2.ackedBy).toBe(u.id);
      const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "system_alert"));
      expect(audits.length).toBe(1);
      expect(audits[0].action).toBe("ack");
      expect(await countOpenAlerts(db, "test_cat")).toEqual({ open: 1, unacked: 0 });
      await expect(ackAlert({ id: u.id, name: u.name, roles: ["pmc"], isApprover: false }, b.id, db)).rejects.toThrow(/已关闭/);
    } finally {
      await client.close();
    }
  });
});
