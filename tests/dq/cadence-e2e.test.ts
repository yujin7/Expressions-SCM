/**
 * D65 核对节奏端到端（只走 runWeeklyDqPack + closeReview，不直接调 resolveCadence）：
 * - 四个周包依次完成且达标后，下一次运行生成的是月包（本次即将生成的周期不计入评估，否则月核对永远不可达）；
 * - 月包待完成时再下一周仍是月包（粘滞、幂等不重复生成）；
 * - 月包一类被豁免 → 退回周包。
 * 三类准确率种子：recon 100%（rpa ≥ 95）、人工模板放行 100%（manual ≥ 90）、天猫一致性 100%（external ≥ 90）。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import type { SessionUser } from "@/server/core/dto";
import { runWeeklyDqPack } from "@/jobs/weekly-dq-pack";
import { closeReview } from "@/server/modules/dq/reviews";

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  const { db, client } = await createTestDb();
  const [pmc] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"] }).returning();
  const actor: SessionUser = { id: pmc.id, name: pmc.name, roles: pmc.roles as string[], isApprover: pmc.isApprover };
  const [tmall] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P90040", nameCn: "节奏测试" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: "CD-1", name: "CD-1", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  // rpa：recon 两行全一致 → 100%
  await db.insert(schema.reconDiffs).values([
    { bizDate: daysAgo(1), skuId: sku.id, sysQty: "10.0000", jstQty: "10.0000", diffQty: "0.0000" },
    { bizDate: daysAgo(2), skuId: sku.id, sysQty: "20.0000", jstQty: "20.0000", diffQty: "0.0000" },
  ]);
  // manual：人工模板 100/0 → 100%
  await db.insert(schema.importJobs).values({ template: "sales", filename: "s.xlsx", status: "done", okRows: 100, failRows: 0, sourceAsOf: daysAgo(1), createdBy: pmc.id });
  // external：天猫观察 7 月完整（首日 07-01，锚点 08-01）vs sales_monthly 7 月 → 100%
  const [crosswalk, sales] = await db.insert(schema.importJobs).values([
    { template: "jdy_tmall_sku_crosswalk_observation", filename: "cw", sourceAsOf: "2026-08-01", createdBy: pmc.id, status: "done" },
    { template: "jdy_tmall_sku_sales_observation", filename: "sales", sourceAsOf: "2026-08-01", createdBy: pmc.id, status: "done" },
  ]).returning();
  const finishedAt = new Date("2026-08-01T03:00:00.000Z");
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "cw-e2e", status: "succeeded", importJobId: crosswalk.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "sales-e2e", status: "succeeded", importJobId: sales.id, finishedAt },
  ]);
  await db.insert(schema.stagingRows).values([
    { importJobId: crosswalk.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
      payload: { data: { shopName: "旗舰店", platformSkuId: "P-CD" }, _identity: { skuId: sku.id } } },
    { importJobId: sales.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: "2026-07-01", shopName: "旗舰店", skuId: "P-CD", paidNumber: "60" } } },
    { importJobId: sales.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: "2026-07-20", shopName: "旗舰店", skuId: "P-CD", paidNumber: "40" } } },
    { importJobId: sales.id, rowNo: 3, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: "2026-08-01", shopName: "旗舰店", skuId: "P-CD", paidNumber: "9" } } },
  ]);
  await db.insert(schema.salesMonthly).values({ skuId: sku.id, channelId: tmall.id, yearMonth: "2026-07", qty: "100.0000" });
  return { db, client, actor };
}

describe("核对节奏端到端（runWeeklyDqPack + closeReview）", () => {
  it("四周达标 → 月包；月包待完成 → 仍是月包；月包被豁免 → 退回周包", async () => {
    const { db, client, actor } = await seed();
    try {
      const completeAll = async (periodKey: string) => {
        const rows = await db.select().from(schema.dataQualityReviews);
        for (const r of rows.filter((x) => x.periodKey === periodKey && x.status === "pending")) {
          await closeReview(actor, r.id, { status: "completed", note: "已核对" }, db);
        }
      };

      // 周一 09-07 / 09-14 / 09-21 / 09-28：四个周包，逐个完成且达标（三类准确率均 ≥ 目标，无告警）
      const mondays: [string, string][] = [["2026-09-07", "2026-W36"], ["2026-09-14", "2026-W37"], ["2026-09-21", "2026-W38"], ["2026-09-28", "2026-W39"]];
      for (const [today, key] of mondays) {
        const run = await runWeeklyDqPack(db, { today, notify: false });
        expect(run).toMatchObject({ periodKind: "week", periodKey: key, created: 3, belowTarget: [], alertsOpened: 0 });
        expect(run.summaryText).toContain("销量一致性（仅天猫）比较月 2026-07");
        await completeAll(key);
      }
      // 第 4 周达标之后：10-05 评估 W39..W36（本次周期 W40 不计）→ 月包 2026-09
      const month = await runWeeklyDqPack(db, { today: "2026-10-05", notify: false });
      expect(month).toMatchObject({ periodKind: "month", periodKey: "2026-09", created: 3, existing: 0 });
      expect(month.cadenceReason).toContain("连续 4 周");
      // 再下一周：月包待完成 → 仍是月包，幂等不重复生成
      const sticky = await runWeeklyDqPack(db, { today: "2026-10-12", notify: false });
      expect(sticky).toMatchObject({ periodKind: "month", periodKey: "2026-09", created: 0, existing: 3 });
      expect(sticky.cadenceReason).toContain("待完成");
      expect((await db.select().from(schema.dataQualityReviews)).filter((r) => r.periodKind === "week")).toHaveLength(12);

      // 月包一类被豁免 → 退回周包（周期键 = 上一完整周 W42）
      const monthRows = (await db.select().from(schema.dataQualityReviews)).filter((r) => r.periodKind === "month");
      expect(monthRows).toHaveLength(3);
      await closeReview(actor, monthRows[0].id, { status: "waived", note: "本月无法核对" }, db);
      const back = await runWeeklyDqPack(db, { today: "2026-10-19", notify: false });
      expect(back).toMatchObject({ periodKind: "week", periodKey: "2026-W42", created: 3 });
      expect(back.cadenceReason).toContain("被豁免");
      expect(back.cadenceReason).toContain("退回周核对");
      // 月核对期间未生成的 W40/W41 不算达标：不会立刻再转月
      const next = await runWeeklyDqPack(db, { today: "2026-10-26", notify: false });
      expect(next).toMatchObject({ periodKind: "week", periodKey: "2026-W43" });
    } finally {
      await client.close();
    }
  });
});
