/** D60 调拨成本看门狗（jobs/transfer-cost-watchdog.ts）：命中开 system_alerts(transfer_cost)，幂等，不再命中自动关闭 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { skus, spus, stockDocLines, stockDocs, systemAlerts, transferFees, users, warehouses } from "@/db/schema";
import { ALERT_CATEGORY, run } from "@/jobs/transfer-cost-watchdog";
import { createTestDb, type TestDb } from "../helpers/db";

const AS_OF = "2026-09-03";
const NOW = new Date("2026-09-03T03:00:00Z");

describe("transfer-cost watchdog", () => {
  let db: TestDb;
  let userId: number;
  let whA: number;
  let whB: number;
  let skuId: number;
  let seq = 0;
  let outlierFeeId = 0;

  async function mkDoc(date: string, qty: string, fee: string): Promise<{ docId: number; feeId: number }> {
    seq += 1;
    const ts = new Date(`${date}T10:00:00+08:00`);
    const [doc] = await db.insert(stockDocs).values({
      docNo: `DB-WD${String(seq).padStart(4, "0")}`, subtype: "transfer", status: "completed", transferType: "inter_warehouse",
      createdBy: userId, createdAt: ts, updatedAt: ts,
    }).returning();
    await db.insert(stockDocLines).values({ stockDocId: doc.id, skuId, warehouseId: whA, toWarehouseId: whB, qty });
    const [f] = await db.insert(transferFees).values({ stockDocId: doc.id, feeType: "freight", amount: fee, bizDate: date, createdBy: userId }).returning();
    return { docId: doc.id, feeId: f.id };
  }

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "看门狗", roles: ["warehouse"] }).returning();
    userId = u.id;
    const [a] = await db.insert(warehouses).values({ code: "WD-A", name: "A仓", kind: "finished" }).returning();
    const [b] = await db.insert(warehouses).values({ code: "WD-B", name: "B仓", kind: "finished" }).returning();
    whA = a.id; whB = b.id;
    const [spu] = await db.insert(spus).values({ code: "PWD01", nameCn: "看门狗品" }).returning();
    const [s] = await db.insert(skus).values({ code: "WD001", name: "SKU", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    skuId = s.id;
    // 8 单稳定单价 1.00（窗口 180 天内，但都在 30 天以外 → 不零散）
    const dates = ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20"];
    const fees = ["95.00", "100.00", "105.00", "98.00", "102.00", "97.00", "103.00", "100.00"]; // 有自然波动：MAD 不至于小到把 ±2% 判成 3σ
    for (let i = 0; i < dates.length; i++) await mkDoc(dates[i], "100", fees[i]);
    // 离群单：单价 2.00（留一法下 z ≫ 3 → alert；不把加权均价推高到让稳定单也超 20% 阈值）
    const o = await mkDoc("2026-07-27", "100", "200.00");
    outlierFeeId = o.feeId;
  });

  it("命中开告警（幂等）；离群费用红字作废后自动关闭", async () => {
    const s1 = await run(db, { now: NOW, asOf: AS_OF });
    expect(s1.opened).toBe(1);
    expect(s1.hits).toEqual(["doc:DB-WD0009"]);
    expect(s1.scatteredLaneCount).toBe(0);
    const open1 = await db.select().from(systemAlerts).where(and(eq(systemAlerts.category, ALERT_CATEGORY), eq(systemAlerts.status, "open")));
    expect(open1).toHaveLength(1);
    expect(open1[0]).toMatchObject({ refKey: "doc:DB-WD0009", severity: "high" });
    expect(open1[0].title).toContain("调拨成本异常");

    const s2 = await run(db, { now: NOW, asOf: AS_OF });
    expect(s2.opened).toBe(0);
    expect(s2.autoClosed).toBe(0);

    // 红字作废离群费用 → 该单无费用 → 不再命中 → 自动关闭
    await db.insert(transferFees).values({ stockDocId: (await db.select({ id: stockDocs.id }).from(stockDocs).where(eq(stockDocs.docNo, "DB-WD0009")))[0].id, feeType: "freight", amount: "-200.00", bizDate: AS_OF, reversalOfId: outlierFeeId, createdBy: userId });
    const s3 = await run(db, { now: NOW, asOf: AS_OF });
    expect(s3.opened).toBe(0);
    expect(s3.autoClosed).toBe(1);
    const open3 = await db.select().from(systemAlerts).where(and(eq(systemAlerts.category, ALERT_CATEGORY), eq(systemAlerts.status, "open")));
    expect(open3).toHaveLength(0);
    const [resolved] = await db.select().from(systemAlerts).where(eq(systemAlerts.refKey, "doc:DB-WD0009"));
    expect(resolved.autoResolved).toBe(true);
    expect(resolved.resolvedAt).toEqual(NOW);
  });

  it("零散线路：30 天内 5 单 → lane 告警", async () => {
    const more: [string, string][] = [["2026-08-10", "96.00"], ["2026-08-15", "104.00"], ["2026-08-20", "99.00"], ["2026-08-25", "101.00"], ["2026-09-01", "100.00"]];
    for (const [d, fee] of more) await mkDoc(d, "100", fee);
    const s = await run(db, { now: NOW, asOf: AS_OF });
    expect(s.scatteredLaneCount).toBe(1);
    expect(s.hits.some((h) => h.startsWith("lane:"))).toBe(true);
    const open = await db.select().from(systemAlerts).where(and(eq(systemAlerts.category, ALERT_CATEGORY), eq(systemAlerts.status, "open")));
    expect(open.some((a) => a.title.startsWith("零散调拨"))).toBe(true);
  });
});
