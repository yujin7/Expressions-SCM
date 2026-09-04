/**
 * 爆单预警（D56）判定窗口下推回归。
 *
 * 生产实测（2026-09-04）：`report/sales-spike.ts` 的重建耗时 490s。原因不是判定规则，
 * 而是取数形状：锚点 `a` 从 `s` 这个 CTE 自己 `max(d)` 推出来，于是 `s` 的 `DISTINCT ON`
 * 必须先对**整批**（68k 行、三个 jsonb 表达式排序）跑完，才轮到 `WHERE s.d > a.d − N` 把
 * 结果裁到 ~12 天。锚点改成一次独立的 `max(...)`、把日期谓词推进 `s` 的 WHERE（DISTINCT ON 之前），
 * 排序集合就只剩窗口内的行。
 *
 * 本文件钉两件事：
 *  ① 结构：判定窗口谓词必须在 `s` 的 WHERE 里，且不得再有从 CTE 自身派生锚点的 `max(d::date)`；
 *  ② 口径：同一份种子数据（含窗口外的历史行）产出的读模型与优化前逐字一致——**只准变快，不准变口径**。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeSalesSpike } from "@/server/modules/report/sales-spike";

const source = readFileSync(
  path.resolve(__dirname, "../../src/server/modules/report/sales-spike.ts"),
  "utf8",
);

/** 判定窗口内每日序列：前 7 天 10，最近 3 天 20/25/30 → 命中 */
const WINDOW_DAYS = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"];
/** 判定窗口外的历史行：只增加 DISTINCT ON 的排序集合，不得进入任何输出 */
const HISTORY_DAYS = ["2026-05-01", "2026-05-02", "2026-06-10", "2026-07-15", "2026-07-16", "2026-07-17"];

async function seed(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [actor] = await db.insert(schema.users).values({ name: "责任人", roles: ["pmc"] }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
  const [hot] = await db.insert(schema.skus).values({ code: "N001-000", name: "爆款", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [salesJob, cwJob] = await db.insert(schema.importJobs).values([
    { template: "jdy_tmall_sku_sales_observation", filename: "s", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_crosswalk_observation", filename: "c", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" },
  ]).returning();
  const finishedAt = new Date("2026-09-03T03:00:00.000Z");
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "s", status: "succeeded", importJobId: salesJob.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "c", status: "succeeded", importJobId: cwJob.id, finishedAt },
  ]);
  const shop = "(天猫国际)NING海外旗舰店";
  await db.insert(schema.stagingRows).values({
    importJobId: cwJob.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
    payload: { data: { shopName: shop, platformSkuId: "P-HOT" }, _identity: { skuId: hot.id } },
  });
  const rows: { importJobId: number; rowNo: number; status: "pending"; targetTable: string; payload: unknown }[] = [];
  let n = 1;
  const push = (d: string, psku: string, qty: number) => {
    rows.push({
      importJobId: salesJob.id, rowNo: n++, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: d, shopName: shop, skuId: psku, paidNumber: String(qty), paidAmount: String(qty * 100) } },
    });
  };
  WINDOW_DAYS.forEach((d, i) => {
    push(d, "P-HOT", i < 7 ? 10 : [20, 25, 30][i - 7]);
    push(d, "P-COLD", i < 7 ? 40 : 41);
  });
  // 历史行：同键重复两次（DISTINCT ON 要去重），全部在判定窗口外
  for (const d of HISTORY_DAYS) {
    push(d, "P-HOT", 999);
    push(d, "P-HOT", 998);
    push(d, "P-COLD", 999);
  }
  await db.insert(schema.stagingRows).values(rows);
  return { hot };
}

describe("爆单预警：判定窗口谓词下推（只快不改口径）", () => {
  it("锚点由独立 max(...) 查询给出，日期谓词写在 DISTINCT ON 之前的 s.WHERE 里", () => {
    const cte = source.slice(source.indexOf("WITH s AS ("), source.indexOf("ORDER BY payload->'data'->>'shopName'"));
    expect(cte, "判定窗口谓词必须进入 s 的 WHERE（DISTINCT ON 之前），否则整批 68k 行都要先排序去重")
      .toMatch(/left\(payload->'data'->>'statisticalDate',10\)::date\s*>/);
    expect(source, "锚点不得再从 s 自身派生——那正是 DISTINCT ON 无法被裁剪的原因")
      .not.toMatch(/a AS \(SELECT max\(d::date\)/);
    expect(source, "锚点必须来自一次独立的 max(...) 查询").toMatch(/anchorOf\s*\(/);
  });

  it("窗口外历史行不改变任何输出（与优化前逐字一致）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { hot } = await seed(db);
      const model = await computeSalesSpike(db);
      expect(model.state).toBe("ready");
      expect(model.anchorDate).toBe("2026-09-02");
      expect(model.hits).toHaveLength(1);
      const [h] = model.hits;
      expect(h.skuId).toBe(hot.id);
      // 判定窗口 = consecutiveDays(3) + baselineDays(7) + 2 = 12 天，锚点前 11 天
      expect(h.days.map((d) => d.date)).toEqual(["2026-08-31", "2026-09-01", "2026-09-02"]);
      expect(h.days.map((d) => d.qty)).toEqual(["20.0000", "25.0000", "30.0000"]);
      expect(h.baseline).toBe("10.0000"); // 历史 999 行若混进基线窗口，这里立刻变形
      expect(model.coverage).toMatchObject({ platformSeries: 2, mappedSeries: 1, systemSkus: 1 });
      expect(model.unmappedHits).toHaveLength(0); // P-COLD 涨幅 2.5% 不命中
    } finally {
      await client.close();
    }
  });
});
