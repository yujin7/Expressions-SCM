import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLogs, opsDemandSubmissions, sysParams } from "@/db/schema";
import { getReconcile, parseOpsDemandCsv, submitOpsDemand } from "@/server/modules/replenish/reconcile";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedTierWorld, type TierWorld } from "../helpers/tier-seed";

/**
 * 过渡期运营提报核对（D55/R3）：提报 append-only（supersedes 链）+ 系统基线并排；
 * |差异| ≥ ops_demand_diff_pct 标「需核对」；只对照不驱动（本模块不写建议/单据）。
 */
describe("replenish/reconcile", () => {
  let db: TestDb;
  let w: TierWorld;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    w = await seedTierWorld(db);
  });

  it("CSV 解析：BOM/引号/英文别名表头；错误逐行返回、不吞行", () => {
    const ok = parseOpsDemandCsv('﻿SKU编码,渠道编码,月份,数量,依据\nTIER-S,tmall,2026-07,"1,200",大促\nTIER-A,,2026-07,300,\n');
    expect(ok.errors).toEqual([]);
    expect(ok.rows).toEqual([
      { line: 2, skuCode: "TIER-S", channelCode: "tmall", period: "2026-07", qty: "1200.0000", basis: "大促" },
      { line: 3, skuCode: "TIER-A", channelCode: null, period: "2026-07", qty: "300.0000", basis: null },
    ]);
    const bad = parseOpsDemandCsv("sku_code,period,qty\nTIER-S,2026/07,10\nTIER-S,2026-07,-5\n,2026-07,1\nTIER-B,2026-07,7.5");
    expect(bad.rows).toHaveLength(1);
    expect(bad.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(parseOpsDemandCsv("a,b\n1,2").errors[0].message).toContain("表头");
    expect(parseOpsDemandCsv("").errors[0].message).toContain("为空");
  });

  it("提报：任一行出错整批回退（未知 SKU / 范围外渠道）；warehouse 403", async () => {
    await expect(submitOpsDemand(w.warehouse, { rows: [{ skuCode: "TIER-S", period: "2026-07", qty: 1 }] }, db)).rejects.toMatchObject({ status: 403 });
    await expect(submitOpsDemand(w.ops, { rows: [{ skuCode: "TIER-S", period: "2026-07", qty: 1 }, { skuCode: "NOPE", period: "2026-07", qty: 1 }] }, db))
      .rejects.toMatchObject({ status: 400 });
    await expect(submitOpsDemand(w.opsPdd, { rows: [{ skuCode: "TIER-S", channelCode: "tmall", period: "2026-07", qty: 1 }] }, db))
      .rejects.toThrow(/无权提报/);
    expect(await db.select().from(opsDemandSubmissions)).toHaveLength(0);
  });

  it("提报：落库 + 审计；修正 = 新行 supersedes 旧行；相同数量与依据幂等不落行", async () => {
    const r1 = await submitOpsDemand(w.ops, {
      rows: [
        { skuCode: "TIER-S", channelCode: "tmall", period: "2026-07", qty: 900, basis: "大促" },
        { skuCode: "TIER-A", period: "2026-07", qty: 260 },
        { skuCode: "TIER-NEW", channelCode: "pdd", period: "2026-07", qty: 10, basis: "新品计划" },
      ],
    }, db);
    expect(r1).toMatchObject({ inserted: 3, superseded: 0, unchanged: 0 });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "ops_demand_submission"));
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(w.ops.id);

    const r2 = await submitOpsDemand(w.ops, { rows: [{ skuId: w.sku.S, channelId: w.tmall, period: "2026-07", qty: "950", basis: "大促" }] }, db);
    expect(r2).toMatchObject({ inserted: 1, superseded: 1 });
    const rows = await db.select().from(opsDemandSubmissions).where(eq(opsDemandSubmissions.skuId, w.sku.S));
    expect(rows).toHaveLength(2);
    const head = rows.find((x) => x.id === r2.ids[0])!;
    expect(head.supersedesId).toBe(r1.ids[0]);
    expect(head.qty).toBe("950.0000");

    const r3 = await submitOpsDemand(w.ops, { rows: [{ skuCode: "TIER-S", channelCode: "tmall", period: "2026-07", qty: 950, basis: "大促" }] }, db);
    expect(r3).toMatchObject({ inserted: 0, unchanged: 1 });
  });

  it("核对：Holt 基线并排；|差异| ≥ 阈值标需核对；无销量序列而提报 >0 也标；只读不写", async () => {
    const r = await getReconcile(w.pmc, { period: "2026-07" }, db);
    expect(r.period).toBe("2026-07");
    expect(r.meta.thresholdPct).toBe(30);
    expect(r.meta.months6).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
    expect(r.total).toBe(3);
    const by = new Map(r.rows.map((x) => [x.skuId, x]));
    const s = by.get(w.sku.S)!;
    expect(s.submittedQty).toBe("950.0000");
    expect(s.revisions).toBe(1);
    expect(s.baselineQty).toBe("600.0000"); // 恒定序列 Holt = 600
    expect(s.naiveQty).toBe("600.0000");
    expect(s.diffPct).toBe(58.3);
    expect(s.flagged).toBe(true);
    expect(s.flagReason).toContain("高 58.3%");
    const a = by.get(w.sku.A)!; // 不分渠道 = 全渠道汇总 250；260 → +4% 不标
    expect(a.baselineQty).toBe("250.0000");
    expect(a.diffPct).toBe(4);
    expect(a.flagged).toBe(false);
    const n = by.get(w.sku.NEW)!;
    expect(n.baselineQty).toBeNull();
    expect(n.flagged).toBe(true);
    expect(n.flagReason).toContain("无销量序列");
    expect(r.summary).toMatchObject({ submissions: 3, flagged: 2, noBaseline: 1, submittedQty: "1220.0000", baselineQty: "850.0000" });
    // 排序：需核对优先、差异大者靠前
    expect(r.rows[0].flagged).toBe(true);
    const onlyFlagged = await getReconcile(w.pmc, { period: "2026-07", flaggedOnly: true }, db);
    expect(onlyFlagged.total).toBe(2);
  });

  it("阈值参数化：ops_demand_diff_pct 调到 60 后 S 不再标", async () => {
    await db.insert(sysParams).values({ scope: "global", key: "ops_demand_diff_pct", value: "60" });
    const r = await getReconcile(w.pmc, { period: "2026-07" }, db);
    expect(r.meta.thresholdPct).toBe(60);
    expect(r.rows.find((x) => x.skuId === w.sku.S)!.flagged).toBe(false);
  });

  it("渠道范围（D62）：受限用户只见范围内渠道 + 不分渠道；请求范围外渠道 403", async () => {
    const r = await getReconcile(w.opsPdd, { period: "2026-07" }, db);
    expect(r.meta.scopeForced).toBe(true);
    expect(new Set(r.rows.map((x) => x.skuId))).toEqual(new Set([w.sku.A, w.sku.NEW]));
    await expect(getReconcile(w.opsPdd, { period: "2026-07", channelId: w.tmall }, db)).rejects.toMatchObject({ status: 403 });
    const empty = await getReconcile(w.pmc, { period: "2025-01" }, db);
    expect(empty.total).toBe(0);
    expect(empty.periods).toEqual(["2026-07"]);
  });

  it("受限渠道运营（D62）：提报 channelId 必填且须在范围内——缺渠道 403、范围外 403、范围内可提；不受限用户仍可提不分渠道", async () => {
    await expect(submitOpsDemand(w.opsPdd, { rows: [{ skuCode: "TIER-S", period: "2026-08", qty: 1 }] }, db)).rejects.toMatchObject({ status: 403 });
    await expect(submitOpsDemand(w.opsPdd, { rows: [{ skuId: w.sku.S, channelId: null, period: "2026-08", qty: 1 }] }, db)).rejects.toMatchObject({ status: 403 });
    await expect(submitOpsDemand(w.opsPdd, { rows: [{ skuId: w.sku.S, channelId: w.tmall, period: "2026-08", qty: 1 }] }, db)).rejects.toMatchObject({ status: 403 });
    // 混合批：任一行缺渠道即 403、整批不落
    await expect(submitOpsDemand(w.opsPdd, {
      rows: [{ skuCode: "TIER-S", channelCode: "pdd", period: "2026-08", qty: 1 }, { skuCode: "TIER-A", period: "2026-08", qty: 1 }],
    }, db)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(opsDemandSubmissions).where(eq(opsDemandSubmissions.period, "2026-08"))).toHaveLength(0);

    const ok = await submitOpsDemand(w.opsPdd, { rows: [{ skuCode: "TIER-S", channelCode: "pdd", period: "2026-08", qty: 5 }] }, db);
    expect(ok).toMatchObject({ inserted: 1, superseded: 0 });
    const scoped = await getReconcile(w.opsPdd, { period: "2026-08" }, db);
    expect(scoped.rows.map((x) => [x.skuId, x.channelId])).toEqual([[w.sku.S, w.pdd]]);
    const unrestricted = await submitOpsDemand(w.ops, { rows: [{ skuCode: "TIER-S", period: "2026-08", qty: 5 }] }, db);
    expect(unrestricted).toMatchObject({ inserted: 1 });
  });
});
