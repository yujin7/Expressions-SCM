/**
 * W4 后台任务：jst-daily 适配器 + reconcile-jst 对账（PGlite 全链路）。
 * 口径：sys=自有仓 sales_out 过账流水（Asia/Shanghai 自然日）；jst=staged 行按运行时别名归并；
 * DoD-2 分母=jst；jst=0&sys>0 → sysOnly（不参与 maxAbsDiffPct）。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { getStagingRows } from "@/server/import/staging";
import { claimAlias } from "@/server/modules/dimension/resolver";
import { jstDailyAdapter, stageJstDaily, parseCsv, JST_DAILY_TEMPLATE } from "@/server/import/adapters/jst-daily";
import { runReconcileJst, shanghaiDayBounds } from "@/jobs/reconcile-jst";

const BIZ_DATE = "2026-07-20";

/** 4 业务行：JSTA×2（含引号字段）+ JSTB×1 + 坏日期 1 行（拒收） */
const CSV = `日期,商家编码,仓库,数量
2026-07-20,JSTA,自有仓,5
2026-07-20,JSTA,"自有仓",3
2026-07-20,JSTB,自有仓,4
坏日期,JSTA,自有仓,2
`;

function writeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jst-daily-"));
  const file = path.join(dir, "jst-2026-07-20.csv");
  writeFileSync(file, CSV, "utf8");
  return file;
}

async function seedBase(db: TestDb) {
  const [user] = await db.insert(schema.users).values({ name: "任务员" }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
  const mkSku = async (code: string) => {
    const [s] = await db
      .insert(schema.skus)
      .values({ code, name: code, spuId: spu.id, baseUom: "个", skuType: "finished" as const })
      .returning();
    return s;
  };
  const skuA = await mkSku("SKA01");
  const skuB = await mkSku("SKB01");
  const skuC = await mkSku("SKC01");
  const [wh] = await db
    .insert(schema.warehouses)
    .values({ code: "W1", name: "自有成品仓", kind: "finished" as const })
    .returning();
  await db.insert(schema.aliases).values([
    { aliasType: "sku_code" as const, rawValue: "JSTA", targetId: skuA.id },
    { aliasType: "warehouse" as const, rawValue: "自有仓", targetId: wh.id },
  ]);
  return { user, skuA, skuB, skuC, wh };
}

let docSeq = 1;
function ledgerRow(
  skuId: number,
  warehouseId: number,
  qtyDelta: number,
  occurredAt: Date,
  over: Partial<typeof schema.stockLedger.$inferInsert> = {},
): typeof schema.stockLedger.$inferInsert {
  return {
    skuId,
    warehouseId,
    qtyDelta: qtyDelta.toFixed(4),
    sourceDocType: "sales_out",
    sourceDocId: docSeq++,
    sourceLineId: 0,
    action: "post",
    occurredAt,
    ...over,
  };
}

const sh = (iso: string) => new Date(`${iso}+08:00`);

describe("jst-daily 适配器（CSV）", () => {
  it("模板文档导出且含四列说明", () => {
    for (const key of ["日期", "商家编码", "仓库", "数量"]) expect(JST_DAILY_TEMPLATE).toContain(key);
  });

  it("parseCsv：引号转义与空字段", () => {
    const rows = parseCsv('a,"b,1","c""x"\n,2,');
    expect(rows[0]).toEqual(["a", "b,1", 'c"x']);
    expect(rows[1]).toEqual([null, "2", null]);
  });

  it("解析：3 业务行 + 1 坏日期拒收；payload 形状正确", async () => {
    const res = await jstDailyAdapter(writeFixture());
    expect(res.rows.length).toBe(3);
    expect(res.rejects.length).toBe(1);
    expect(res.rejects[0].reason).toContain("日期");
    expect(res.rows[0].payload).toEqual({ bizDate: BIZ_DATE, skuCode: "JSTA", warehouseRaw: "自有仓", qty: 5 });
    expect(res.rows[1].payload.qty).toBe(3); // 引号字段
    expect(res.stats.distinctSkus).toBe(2);
  });

  it("stage：已映射行 validated、未知 SKU pending+入异常队列、拒收行留痕", async () => {
    const { db } = await createTestDb();
    const { user } = await seedBase(db);
    const sum = await stageJstDaily(db, writeFixture(), user.id);
    expect(sum.staged).toBe(3);
    expect(sum.validated).toBe(2);
    expect(sum.pending).toBe(1);
    expect(sum.rejected).toBe(1);
    expect(sum.unresolved.sku_code).toBe(1);

    const all = await getStagingRows(db, sum.jobId);
    expect(all.length).toBe(4); // 3 业务 + 1 error
    const exc = await db
      .select()
      .from(schema.aliasExceptions)
      .where(and(eq(schema.aliasExceptions.aliasType, "sku_code"), eq(schema.aliasExceptions.rawValue, "JSTB")));
    expect(exc.length).toBe(1);
    expect(exc[0].status).toBe("open");
  });
});

describe("runReconcileJst", () => {
  it("上海自然日边界", () => {
    const { start, end } = shanghaiDayBounds(BIZ_DATE);
    expect(start.toISOString()).toBe("2026-07-19T16:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-20T16:00:00.000Z");
    expect(() => shanghaiDayBounds("2026/07/20")).toThrow();
  });

  it("认领别名后对账：匹配/差异/sysOnly；日界与动作过滤；重跑幂等", async () => {
    const { db } = await createTestDb();
    const { user, skuA, skuB, skuC, wh } = await seedBase(db);
    await stageJstDaily(db, writeFixture(), user.id);
    // staging 后认领 JSTB——运行时解析应即时生效，无须重导
    await claimAlias(db, { aliasType: "sku_code", rawValue: "JSTB", targetId: skuB.id, userId: user.id });

    await db.insert(schema.stockLedger).values([
      // A：sys 5+3=8 = jst 8 → 匹配（含 00:00 边界行）
      ledgerRow(skuA.id, wh.id, -5, sh("2026-07-20T00:00:00")),
      ledgerRow(skuA.id, wh.id, -3, sh("2026-07-20T12:00:00")),
      // B：sys 3 vs jst 4 → diff -1（25%）
      ledgerRow(skuB.id, wh.id, -3, sh("2026-07-20T15:00:00")),
      // C：sys 2 vs jst 0 → sysOnly
      ledgerRow(skuC.id, wh.id, -2, sh("2026-07-20T18:00:00")),
      // 噪声：次日 00:00（界外）/ 非 post / 非 sales_out——均不计
      ledgerRow(skuA.id, wh.id, -7, sh("2026-07-21T00:00:00")),
      ledgerRow(skuA.id, wh.id, -4, sh("2026-07-20T10:00:00"), { action: "reverse" }),
      ledgerRow(skuA.id, wh.id, -6, sh("2026-07-20T11:00:00"), { sourceDocType: "issue_out" }),
    ]);

    const sum = await runReconcileJst(db, BIZ_DATE);
    expect(sum).toEqual({
      bizDate: BIZ_DATE,
      skuCount: 3,
      matchedCount: 1,
      diffCount: 2,
      sysOnly: 1,
      unresolvedRows: 0,
      maxAbsDiffPct: 25, // B 行 |−1|/4；sysOnly（分母0）不参与
    });

    const diffs = await db.select().from(schema.reconDiffs).orderBy(schema.reconDiffs.skuId);
    expect(diffs.length).toBe(3);
    const byId = new Map(diffs.map((d) => [d.skuId, d]));
    expect(byId.get(skuA.id)).toMatchObject({ sysQty: "8.0000", jstQty: "8.0000", diffQty: "0.0000", status: "resolved" });
    expect(byId.get(skuB.id)).toMatchObject({ sysQty: "3.0000", jstQty: "4.0000", diffQty: "-1.0000", status: "open" });
    expect(byId.get(skuC.id)).toMatchObject({ sysQty: "2.0000", jstQty: "0.0000", diffQty: "2.0000", status: "open" });

    // 重跑：upsert 幂等——行数与 summary 不变
    const again = await runReconcileJst(db, BIZ_DATE);
    expect(again).toEqual(sum);
    const diffs2 = await db.select().from(schema.reconDiffs);
    expect(diffs2.length).toBe(3);
  });

  it("未认领 SKU 计入 unresolvedRows；jst 单边差异分母=jst", async () => {
    const { db } = await createTestDb();
    const { user } = await seedBase(db);
    await stageJstDaily(db, writeFixture(), user.id); // JSTB 未认领；无任何流水
    const sum = await runReconcileJst(db, BIZ_DATE);
    expect(sum.unresolvedRows).toBe(1); // JSTB 行
    expect(sum.skuCount).toBe(1); // 仅 A
    expect(sum.diffCount).toBe(1); // A: sys 0 vs jst 8
    expect(sum.sysOnly).toBe(0);
    expect(sum.maxAbsDiffPct).toBe(100); // |0−8|/8
  });
});
