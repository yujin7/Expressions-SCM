/** B 项：参考数据新鲜度看门狗测试（jobs/freshness.ts） */
import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { importJobs, systemAlerts, transitRefs } from "@/db/schema";
import { runFreshnessCheck } from "@/jobs/freshness";

const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-07-24T04:00:00Z");
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

describe("runFreshnessCheck", () => {
  let db: TestDb;
  let jobId: number;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [job] = await db
      .insert(importJobs)
      .values({ template: "transit", filename: "t.xlsx", status: "done", createdBy: 1 })
      .returning();
    jobId = job.id;
    // stock_summary 过期（10 天前），fg_order 新鲜（1 天前）；pallet/demand 未导入过（不告警）
    await db.insert(transitRefs).values([
      { kind: "stock_summary", sourceJobId: jobId, skuCode: "A", createdAt: daysAgo(10) },
      { kind: "fg_order", sourceJobId: jobId, skuCode: "B", createdAt: daysAgo(1) },
    ]);
  });

  it("过期 kind 开 review_item；新鲜/未启用 kind 不开；重跑不重复开", async () => {
    const s1 = await runFreshnessCheck(db, { now: NOW });
    expect(s1.stale).toEqual(["stock_summary"]);
    expect(s1.opened).toBe(1);

    const s2 = await runFreshnessCheck(db, { now: NOW });
    expect(s2.opened).toBe(0); // 幂等：已有 open 项不重复
    const open = await db
      .select()
      .from(systemAlerts)
      .where(and(eq(systemAlerts.category, "data_freshness"), eq(systemAlerts.status, "open")));
    expect(open.length).toBe(1);
    expect(open[0].refKey).toBe("stock_summary");
  });

  it("数据重传后自动关闭 open 项", async () => {
    await db.insert(transitRefs).values({ kind: "stock_summary", sourceJobId: jobId, skuCode: "A2", createdAt: daysAgo(0) });
    const s = await runFreshnessCheck(db, { now: NOW });
    expect(s.autoClosed).toBe(1);
    const open = await db
      .select()
      .from(systemAlerts)
      .where(and(eq(systemAlerts.category, "data_freshness"), eq(systemAlerts.status, "open")));
    expect(open.length).toBe(0);
  });
});
