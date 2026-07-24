/** #11 单据时效看门狗测试（jobs/doc-aging.ts） */
import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { bhDocs, systemAlerts } from "@/db/schema";
import { runDocAging } from "@/jobs/doc-aging";

const DAY = 86_400_000;
const NOW = new Date("2026-07-24T04:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe("runDocAging", () => {
  let db: TestDb;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    // pending 5 天前（超 3 天阈值）→ 应告警；pending 1 天前 → 不告警；draft 老单 → 不告警
    await db.insert(bhDocs).values([
      { docNo: "BH-OLD", status: "pending", createdBy: 1, updatedAt: daysAgo(5) },
      { docNo: "BH-FRESH", status: "pending", createdBy: 1, updatedAt: daysAgo(1) },
      { docNo: "BH-DRAFT", status: "draft", createdBy: 1, updatedAt: daysAgo(30) },
    ]);
  });

  it("超阈值等待态开提醒；新鲜/草稿不开；重跑幂等", async () => {
    const s1 = await runDocAging(db, { now: NOW });
    expect(s1.opened).toBe(1);
    expect(s1.aging.map((a) => a.docNo)).toEqual(["BH-OLD"]);

    const s2 = await runDocAging(db, { now: NOW });
    expect(s2.opened).toBe(0); // 幂等
    const open = await db
      .select()
      .from(systemAlerts)
      .where(and(eq(systemAlerts.category, "doc_aging"), eq(systemAlerts.status, "open")));
    expect(open.length).toBe(1);
    expect(open[0].refKey).toBe("BH:BH-OLD");
  });

  it("单据流转出等待态后自动关闭提醒", async () => {
    await db.update(bhDocs).set({ status: "approved", updatedAt: NOW }).where(eq(bhDocs.docNo, "BH-OLD"));
    const s = await runDocAging(db, { now: NOW });
    expect(s.autoClosed).toBe(1);
    const open = await db
      .select()
      .from(systemAlerts)
      .where(and(eq(systemAlerts.category, "doc_aging"), eq(systemAlerts.status, "open")));
    expect(open.length).toBe(0);
  });
});
