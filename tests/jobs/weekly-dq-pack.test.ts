/**
 * weekly-dq-pack：生成本期核对包 + 飞书摘要入队（dedupe）+ 低于目标开 system_alerts(data_quality)；重复运行幂等。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { DQ_ALERT_CATEGORY, runWeeklyDqPack } from "@/jobs/weekly-dq-pack";

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

describe("runWeeklyDqPack", () => {
  it("生成周核对包、入队飞书摘要、低于目标开告警；再跑不重复", async () => {
    const { db, client } = await createTestDb();
    try {
      const [spu] = await db.insert(schema.spus).values({ code: "P90030", nameCn: "任务测试" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "WJ-1", name: "WJ-1", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
      // recon 一致率 50% < 95% 目标 → rpa 告警
      await db.insert(schema.reconDiffs).values([
        { bizDate: daysAgo(1), skuId: sku.id, sysQty: "10.0000", jstQty: "10.0000", diffQty: "0.0000" },
        { bizDate: daysAgo(2), skuId: sku.id, sysQty: "10.0000", jstQty: "20.0000", diffQty: "-10.0000" },
      ]);
      const today = "2026-09-07"; // 周一
      const first = await runWeeklyDqPack(db, { today });
      expect(first).toMatchObject({ periodKind: "week", periodKey: "2026-W36", created: 3, existing: 0, notified: true, alertsOpened: 1 });
      expect(first.belowTarget).toEqual([{ sourceClass: "rpa_warehouse", rate: 50, targetPct: 95 }]);
      expect(first.summaryText).toContain("2026-W36");
      expect(first.summaryText).toContain("RPA 仓库快照：准确率 50%");

      const reviews = await db.select().from(schema.dataQualityReviews);
      expect(reviews).toHaveLength(3);
      expect(reviews.every((r) => r.periodKey === "2026-W36" && r.status === "pending")).toBe(true);
      const notes = await db.select().from(schema.notifications);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ channel: "feishu", dedupeKey: "dq-pack:week:2026-W36", targetRole: "pmc", severity: "high", href: "/import/data-quality" });
      const alerts = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.category, DQ_ALERT_CATEGORY));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ refKey: "rpa_warehouse:2026-W36", status: "open" });
      expect(await db.select().from(schema.auditLogs)).toHaveLength(0);

      const second = await runWeeklyDqPack(db, { today });
      expect(second).toMatchObject({ created: 0, existing: 3, notified: false, alertsOpened: 0 });
      expect(await db.select().from(schema.dataQualityReviews)).toHaveLength(3);
      expect(await db.select().from(schema.notifications)).toHaveLength(1);
      expect(await db.select().from(schema.systemAlerts)).toHaveLength(1);

      const silent = await runWeeklyDqPack(db, { today: "2026-09-14", notify: false });
      expect(silent).toMatchObject({ periodKey: "2026-W37", created: 3, notified: false });
      /* W1：data_quality 是**周期事实**，下个周期的候选里当然不会再出现上周期的键——
         若按"不再命中即自动关闭"处理，下周一一跑就把上周未处理的不达标自动清账了。
         引擎对本类传 autoCloseAfterDays=null（永不自动关闭），只能人工带原因关闭。 */
      const dqAlerts = await db.select().from(schema.systemAlerts)
        .where(eq(schema.systemAlerts.category, DQ_ALERT_CATEGORY));
      expect(dqAlerts.map((a) => `${a.refKey}/${a.status}`).sort())
        .toEqual(["rpa_warehouse:2026-W36/open", "rpa_warehouse:2026-W37/open"]);
      expect(dqAlerts[0]).toMatchObject({ ownerRole: "pmc", dedupeKey: "data_quality:rpa_warehouse:2026-W36", actionHref: "/import/data-quality" });
    } finally {
      await client.close();
    }
  });
});
