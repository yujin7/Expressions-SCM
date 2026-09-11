/**
 * D60 调拨成本看门狗改走预警引擎（审计 #10）：
 * - 开出的行带 ownerRole=warehouse / actionHref / dedupeKey / sourceRule / paramsSnapshot(.why)；
 * - title/detail/why/paramsSnapshot 全部不含 %、σ、倍数（system_alerts 全员可读，不得反推单位费用）；
 * - 180 天人工关闭抑制（引擎 suppressManuallyClosedDays）；
 * - 历史行（无 dedupe_key）一次性回填后按新键刷新，不双开。
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { skus, spus, stockDocLines, stockDocs, systemAlerts, transferFees, users, warehouses } from "@/db/schema";
import { ALERT_CATEGORY, MANUAL_CLOSE_SUPPRESS_DAYS, TRANSFER_COST_ACTION_HREF, TRANSFER_COST_SOURCE_RULE, dedupeKeyOf, run } from "@/jobs/transfer-cost-watchdog";
import { createTestDb, type TestDb } from "../helpers/db";

const AS_OF = "2026-09-03";
const NOW = new Date("2026-09-03T03:00:00Z");
const DAY = 24 * 3600 * 1000;
const SENSITIVE = /\d+(?:\.\d+)?\s*%|σ|×\s*\d/;

describe("transfer-cost watchdog（引擎路径）", () => {
  let db: TestDb;
  let userId: number;
  let whA: number;
  let whB: number;
  let skuId: number;
  let seq = 0;

  async function mkDoc(date: string, qty: string, fee: string): Promise<{ docNo: string }> {
    seq += 1;
    const ts = new Date(`${date}T10:00:00+08:00`);
    const docNo = `DB-WE${String(seq).padStart(4, "0")}`;
    const [doc] = await db.insert(stockDocs).values({
      docNo, subtype: "transfer", status: "completed", transferType: "inter_warehouse", createdBy: userId, createdAt: ts, updatedAt: ts,
    }).returning();
    await db.insert(stockDocLines).values({ stockDocId: doc.id, skuId, warehouseId: whA, toWarehouseId: whB, qty });
    await db.insert(transferFees).values({ stockDocId: doc.id, feeType: "freight", amount: fee, bizDate: date, createdBy: userId });
    return { docNo };
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "看门狗", roles: ["warehouse"] }).returning();
    userId = u.id;
    const [a] = await db.insert(warehouses).values({ code: "WE-A", name: "A仓", kind: "finished" }).returning();
    const [b] = await db.insert(warehouses).values({ code: "WE-B", name: "B仓", kind: "finished" }).returning();
    whA = a.id; whB = b.id;
    const [spu] = await db.insert(spus).values({ code: "PWE01", nameCn: "看门狗品" }).returning();
    const [s] = await db.insert(skus).values({ code: "WE001", name: "SKU", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    skuId = s.id;
    const dates = ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20"];
    const fees = ["95.00", "100.00", "105.00", "98.00", "102.00", "97.00", "103.00", "100.00"];
    for (let i = 0; i < dates.length; i++) await mkDoc(dates[i], "100", fees[i]);
    await mkDoc("2026-07-27", "100", "200.00"); // 离群单 DB-WE0009
  });

  it("历史无键 open 行回填后按新键刷新（不双开）；新行带责任角色/链接/规则/快照/why，且不含敏感数值", async () => {
    // 引擎接入前的历史行：只有 category/refKey/title，无 dedupe_key
    await db.insert(systemAlerts).values({ category: ALERT_CATEGORY, refKey: "doc:DB-WE0009", title: "旧版：调拨成本异常", severity: "high", createdAt: new Date(NOW.getTime() - 10 * DAY) });
    const s1 = await run(db, { now: NOW, asOf: AS_OF });
    expect(s1.backfilled).toBe(1);
    expect(s1.hits).toEqual(["doc:DB-WE0009"]);
    expect(s1).toMatchObject({ opened: 0, refreshed: 1, autoClosed: 0, suppressed: 0 });
    const open = await db.select().from(systemAlerts).where(and(eq(systemAlerts.category, ALERT_CATEGORY), eq(systemAlerts.status, "open")));
    expect(open).toHaveLength(1);
    const row = open[0];
    expect(row).toMatchObject({
      refKey: "doc:DB-WE0009", dedupeKey: dedupeKeyOf("doc:DB-WE0009"), severity: "high", ownerRole: "warehouse",
      actionHref: TRANSFER_COST_ACTION_HREF, sourceRule: TRANSFER_COST_SOURCE_RULE,
    });
    expect(row.title).toContain("调拨成本异常"); // 刷新后标题已是新版
    expect(row.lastHitAt).toEqual(NOW);
    const snap = row.paramsSnapshot as { why: { label: string; value: string; source: string }[]; docNo: string; level: string; asOf: string };
    expect(snap.docNo).toBe("DB-WE0009");
    expect(snap.level).toBe("alert");
    expect(snap.asOf).toBe(AS_OF);
    expect(snap.why.map((w) => w.label)).toEqual(["费用判定", "档位", "样本"]);
    expect(snap.why[0].value).toContain("高于线路中位数");
    // 全员可读：标题/详情/why/快照都不得含偏差百分比、σ、倍数
    expect(`${row.title}\n${row.detail}`).not.toMatch(SENSITIVE);
    expect(JSON.stringify(snap)).not.toMatch(SENSITIVE);
    expect(JSON.stringify(snap)).not.toMatch(/feePctDev|feeZ|unitFee|amount/);
    // 幂等
    const s2 = await run(db, { now: new Date(NOW.getTime() + 3600_000), asOf: AS_OF });
    expect(s2).toMatchObject({ opened: 0, refreshed: 1, autoClosed: 0, backfilled: 0 });
  });

  it("人工关闭 180 天内不重开（suppressed），超 180 天重开；自动关闭的照常重开", async () => {
    const key = dedupeKeyOf("doc:DB-WE0009");
    // 人工关闭当前 open 行（模拟人在页面处理）
    await db.update(systemAlerts).set({ status: "resolved", autoResolved: false, resolvedAt: NOW })
      .where(and(eq(systemAlerts.category, ALERT_CATEGORY), eq(systemAlerts.dedupeKey, key), eq(systemAlerts.status, "open")));
    const s3 = await run(db, { now: new Date(NOW.getTime() + DAY), asOf: AS_OF });
    expect(s3).toMatchObject({ opened: 0, suppressed: 1 });
    expect(await db.select().from(systemAlerts).where(and(eq(systemAlerts.category, ALERT_CATEGORY), eq(systemAlerts.status, "open")))).toHaveLength(0);
    // 181 天后：抑制窗口过期 → 重开
    const s4 = await run(db, { now: new Date(NOW.getTime() + (MANUAL_CLOSE_SUPPRESS_DAYS + 1) * DAY), asOf: AS_OF });
    expect(s4).toMatchObject({ opened: 1, suppressed: 0 });
    // 系统自动关闭的不受抑制：把 s4 开出的行改成自动关闭，且此时人工关闭已出窗口（182 天）→ 重开
    await db.update(systemAlerts).set({ status: "resolved", autoResolved: true, resolvedAt: NOW })
      .where(and(eq(systemAlerts.category, ALERT_CATEGORY), eq(systemAlerts.status, "open")));
    const s5 = await run(db, { now: new Date(NOW.getTime() + (MANUAL_CLOSE_SUPPRESS_DAYS + 2) * DAY), asOf: AS_OF });
    expect(s5).toMatchObject({ opened: 1, suppressed: 0 });
  });

  it("历史 resolved 无键行也回填（让人工关闭抑制对历史关闭生效）", async () => {
    await db.insert(systemAlerts).values({ category: ALERT_CATEGORY, refKey: "lane:legacy", title: "旧版零散", severity: "medium", status: "resolved", autoResolved: false, resolvedAt: NOW });
    const s = await run(db, { now: new Date(NOW.getTime() + 3 * DAY), asOf: AS_OF });
    expect(s.backfilled).toBe(1);
    const [legacy] = await db.select().from(systemAlerts).where(eq(systemAlerts.refKey, "lane:legacy"));
    expect(legacy.dedupeKey).toBe(dedupeKeyOf("lane:legacy"));
  });
});
