import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { getSuggestionAccuracy, type SuggestionAccuracy } from "@/server/modules/report/closed-loop";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-06T00:00:00+08:00");
const start = (day: string) => new Date(`${day}T00:00:00+08:00`);
const sum = (buckets: { count: number }[]) => buckets.reduce((total, item) => total + item.count, 0);
const count = (buckets: { key: string; count: number }[], key: string) => buckets.find((item) => item.key === key)!.count;

interface Fixture {
  db: TestDb;
  actorId: number;
  skuId: number;
  realtimeId: number;
  snapshotId: number;
  sequence: number;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const { db, client } = await createTestDb();
  try {
    const [actor] = await db.insert(schema.users).values({ name: "QA 计划", roles: ["pmc"] }).returning();
    const [spu] = await db.insert(schema.spus).values({ code: "AC-SPU", nameCn: "QA 准确度品" }).returning();
    const [sku] = await db.insert(schema.skus).values({ code: "AC-SKU", name: "QA 准确度品", spuId: spu.id, baseUom: "件", skuType: "finished" }).returning();
    const [rt] = await db.insert(schema.warehouses).values({ code: "AC-RT", name: "QA 实时仓", kind: "finished" }).returning();
    const [snap] = await db.insert(schema.warehouses).values({ code: "AC-SNAP", name: "QA 快照仓", kind: "snapshot", accountingMode: "snapshot" }).returning();
    await run({ db, actorId: actor.id, skuId: sku.id, realtimeId: rt.id, snapshotId: snap.id, sequence: 0 });
  } finally {
    await client.close();
  }
}

async function capture(f: Fixture, businessDate = "2026-08-01", engineVersion = "qa-engine-a", horizonDays = 4) {
  const key = `ac-${++f.sequence}`;
  const [version] = await f.db.insert(schema.planningVersions).values({
    name: key, weekStart: businessDate, engineVersion, parameters: {}, sourceMeta: {}, lineCount: 1,
    suggestedCount: 1, suppressedCount: 0, digest: key, idempotencyKey: key,
    createdBy: f.actorId, createdAt: start(businessDate),
  }).returning();
  await f.db.insert(schema.planningVersionLines).values({
    versionId: version.id, skuId: f.skuId, skuCode: "AC-SKU", skuName: "QA 准确度品", baseUom: "件",
    suggestedQty: "100", suppressed: false, onHand: "0", inTransit: "0", daily: "1", safetyQty: "0", explanation: [],
    decisionEnvelope: { businessDate, inputs: { policy: { horizonDays } }, outputs: { netRequiredBeforeRounding: "100" } },
  });
}

async function ledger(f: Fixture, rows: { at: string; qty: string }[]) {
  await f.db.insert(schema.stockLedger).values(rows.map((row) => ({
    skuId: f.skuId, warehouseId: f.realtimeId, qtyDelta: row.qty, sourceDocType: "accuracy-qa",
    sourceDocId: ++f.sequence, action: "post", occurredAt: new Date(row.at),
  })));
}

async function snapshots(f: Fixture, rows: { bizDate: string; qty: string }[]) {
  await f.db.insert(schema.stockSnapshots).values(rows.map((row) => ({ skuId: f.skuId, warehouseId: f.snapshotId, ...row })));
}

function assertExcluded(result: SuggestionAccuracy, reason: string) {
  // 先钉旧实现的错误业务输出，不能只靠版本/新增 DTO 字段令旧实现变红。
  expect(sum(result.outboundVsRequired)).toBe(0);
  expect(sum(result.orderedVsRequired)).toBe(1);
  expect(result).toMatchObject({ sample: 1, matured: 1, immature: 0, ledgerCoverage: {
    qualified: 0, excluded: 1, reasons: [{ reason, count: 1, note: expect.any(String) }],
  } });
  expect(sum(result.byEngineVersion[0].outboundVsRequired)).toBe(0);
  expect(result.engineMix).toEqual([{ engineVersion: "qa-engine-a", sample: 1, matured: 1 }]);
}

describe("建议准确度：出库统计资格按每个成熟样本自己的窗口", () => {
  it.each([
    ["窗口之后首笔", "2026-08-10T00:00:00+08:00"],
    ["窗口内首笔", "2026-08-03T00:00:00+08:00"],
  ])("%s不能把历史未知出库记成真实零", async (_name, at) => withFixture(async (f) => {
    await capture(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    await ledger(f, [{ at, qty: "100" }]);
    assertExcluded(await getSuggestionAccuracy(f.db, { now: NOW }), "realtime_ledger_starts_after_window_start");
  }));

  it("实时账已存在但快照仓有货时，出库不可代表全口径，不能计入准确度", async () => withFixture(async (f) => {
    await capture(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "100" }, { bizDate: "2026-08-04", qty: "0" }]);
    await ledger(f, [{ at: "2026-07-30T00:00:00+08:00", qty: "100" }, { at: "2026-08-03T00:00:00+08:00", qty: "-60" }]);
    assertExcluded(await getSuggestionAccuracy(f.db, { now: NOW }), "snapshot_stock_outside_ledger");
  }));

  it("同 SKU 较晚窗口清零不能替较早窗口补覆盖；引擎样本数与实际下单分布不变", async () => withFixture(async (f) => {
    await capture(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "100" }, { bizDate: "2026-08-10", qty: "0" }]);
    await ledger(f, [
      { at: "2026-07-30T00:00:00+08:00", qty: "200" },
      { at: "2026-08-03T00:00:00+08:00", qty: "-60" },
      { at: "2026-08-12T00:00:00+08:00", qty: "-100" },
    ]);
    const [bh] = await f.db.insert(schema.bhDocs).values({ docNo: "BH-AC-A", status: "approved", createdBy: f.actorId, createdAt: start("2026-08-02") }).returning();
    await f.db.insert(schema.bhLines).values({ bhId: bh.id, skuId: f.skuId, qty: "100" });
    const onlyA = await getSuggestionAccuracy(f.db, { now: NOW });
    expect(sum(onlyA.outboundVsRequired)).toBe(0);
    expect(count(onlyA.orderedVsRequired, "90_110")).toBe(1);
    await capture(f, "2026-08-11", "qa-engine-b");
    const together = await getSuggestionAccuracy(f.db, { now: NOW });
    expect(together).toMatchObject({ sample: 2, matured: 2, ledgerCoverage: { qualified: 1, excluded: 1 } });
    expect(sum(together.orderedVsRequired)).toBe(2);
    expect(count(together.orderedVsRequired, "90_110")).toBe(1);
    expect(count(together.orderedVsRequired, "none")).toBe(1);
    expect(sum(together.outboundVsRequired)).toBe(1);
    expect(count(together.outboundVsRequired, "90_110")).toBe(1);
    expect(together.byEngineVersion.find((row) => row.engineVersion === "qa-engine-a")).toEqual(onlyA.byEngineVersion[0]);
    expect(together.byEngineVersion.find((row) => row.engineVersion === "qa-engine-b")).toMatchObject({ sample: 1, matured: 1 });
    expect(sum(together.byEngineVersion.flatMap((row) => row.outboundVsRequired))).toBe(1);
  }));

  it.each([
    { name: "未提供快照基线", rows: [] },
    { name: "窗口内才首次明确零", rows: [{ bizDate: "2026-08-03", qty: "0" }] },
    { name: "无效快照基线", rows: [{ bizDate: "2026-07-31", qty: "NaN" }] },
  ])("$name必须披露历史覆盖未知，不归类成已知零", async ({ rows }) => withFixture(async (f) => {
    await capture(f);
    if (rows.length) await snapshots(f, rows);
    await ledger(f, [{ at: "2026-07-30T00:00:00+08:00", qty: "100" }]);
    assertExcluded(await getSuggestionAccuracy(f.db, { now: NOW }), "snapshot_history_incomplete");
  }));

  it("完全没有实时流水时披露无证据，不推断为快照仓 SKU", async () => withFixture(async (f) => {
    await capture(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    assertExcluded(await getSuggestionAccuracy(f.db, { now: NOW }), "snapshot_only_no_realtime_ledger");
  }));

  it("同 SKU 两个未知窗口各占一个弃权样本，原因计数不能按 SKU 去重", async () => withFixture(async (f) => {
    await capture(f);
    await capture(f, "2026-08-11", "qa-engine-b");
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    await ledger(f, [{ at: "2026-08-20T00:00:00+08:00", qty: "100" }]);
    const result = await getSuggestionAccuracy(f.db, { now: NOW });
    expect(result).toMatchObject({ sample: 2, matured: 2, ledgerCoverage: {
      qualified: 0, excluded: 2,
      reasons: [{ reason: "realtime_ledger_starts_after_window_start", count: 2, note: expect.any(String) }],
    } });
    expect(sum(result.outboundVsRequired)).toBe(0);
    expect(sum(result.orderedVsRequired)).toBe(2);
    expect(result.byEngineVersion.map((row) => sum(row.outboundVsRequired))).toEqual([0, 0]);
    expect(result.ledgerCoverage.qualified + result.ledgerCoverage.excluded).toBe(result.matured);
    expect(sum(result.ledgerCoverage.reasons)).toBe(result.ledgerCoverage.excluded);
  }));

  it("起点已有实时证据和明确零快照，窗口无出库才是真实零；未成熟样本不计覆盖", async () => withFixture(async (f) => {
    await capture(f);
    await capture(f, "2026-09-05", "qa-engine-a");
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }]);
    await ledger(f, [{ at: "2026-08-01T00:00:00+08:00", qty: "100" }]);
    const result = await getSuggestionAccuracy(f.db, { now: NOW });
    expect(result).toMatchObject({ version: "closed-loop-accuracy/v3", sample: 2, matured: 1, immature: 1,
      ledgerCoverage: { qualified: 1, excluded: 0, reasons: [] } });
    expect(count(result.outboundVsRequired, "none")).toBe(1);
    expect(sum(result.outboundVsRequired)).toBe(1);
    expect(result.engineMix).toEqual([{ engineVersion: "qa-engine-a", sample: 2, matured: 1 }]);
  }));

  it("出库与快照均使用上海业务日起的右开窗口，截止日变化不反写前窗", async () => withFixture(async (f) => {
    await capture(f);
    await snapshots(f, [{ bizDate: "2026-07-31", qty: "0" }, { bizDate: "2026-08-05", qty: "100" }]);
    await ledger(f, [
      { at: "2026-07-30T00:00:00+08:00", qty: "200" },
      { at: "2026-08-04T23:59:59.999+08:00", qty: "-100" },
      { at: "2026-08-05T00:00:00+08:00", qty: "-100" },
    ]);
    const result = await getSuggestionAccuracy(f.db, { now: NOW });
    expect(result.ledgerCoverage).toEqual({ qualified: 1, excluded: 0, reasons: [] });
    expect(count(result.outboundVsRequired, "90_110")).toBe(1);
    expect(sum(result.outboundVsRequired)).toBe(1);
  }));

  it("无捕获样本时覆盖与分布皆为空，不伪造零出库样本", async () => withFixture(async (f) => {
    const result = await getSuggestionAccuracy(f.db, { now: NOW });
    expect(result).toMatchObject({ sample: 0, matured: 0, immature: 0, ledgerCoverage: { qualified: 0, excluded: 0, reasons: [] } });
    expect(sum(result.outboundVsRequired)).toBe(0);
    expect(sum(result.orderedVsRequired)).toBe(0);
  }));
});
