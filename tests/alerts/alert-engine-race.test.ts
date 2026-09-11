/**
 * 审阅修复：同 category+dedupeKey 的 open 告警由部分唯一索引 uq_alert_open_dedupe 保证唯一——
 * 两次重叠运行（调度器 + 手工 CLI）不会双开；撞上的一方按"已刷新"计数。
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { upsertAlerts } from "@/server/modules/alerts/engine";

describe("预警引擎：并发重叠运行不双开", () => {
  it("两次并发 upsertAlerts 同键 → 只有一条 open；直接插第二条 open 同键 → 唯一约束拒绝", async () => {
    const { db, client } = await createTestDb();
    try {
      const cand = { refKey: "sku:1", dedupeKey: "sku:1", title: "断货", severity: "high" as const };
      const now = new Date("2026-09-04T03:00:00.000Z");
      const [a, b] = await Promise.all([
        upsertAlerts(db, { category: "race_cat", candidates: [cand], now }),
        upsertAlerts(db, { category: "race_cat", candidates: [cand], now }),
      ]);
      expect(a.opened + b.opened).toBe(1);
      expect(a.opened + a.refreshed + b.opened + b.refreshed).toBe(2);
      const open = await db.select().from(schema.systemAlerts)
        .where(and(eq(schema.systemAlerts.category, "race_cat"), eq(schema.systemAlerts.status, "open")));
      expect(open).toHaveLength(1);
      const err = await db.insert(schema.systemAlerts).values({ category: "race_cat", refKey: "sku:1", dedupeKey: "sku:1", title: "x", severity: "high" }).then(() => null, (e: unknown) => e);
      expect(String((err as { cause?: unknown })?.cause ?? err)).toMatch(/uq_alert_open_dedupe|duplicate key/);
      // 已关闭的同键不受约束（历史可以有多条 resolved）
      await db.insert(schema.systemAlerts).values({ category: "race_cat", refKey: "sku:1", dedupeKey: "sku:1", title: "x", severity: "high", status: "resolved" });
    } finally {
      await client.close();
    }
  });
});
