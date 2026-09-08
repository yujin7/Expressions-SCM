/**
 * 预警引擎的四条红队护栏：
 *  A5   自动关闭必须带 status='open' 守卫（中途落地的人工关闭不得被翻成 autoResolved）；
 *  (a)  autoCloseAfterDays=0 的台账说明不得写"连续 0 天未命中"；
 *  (c)  清知悉必须落 alert_events(ack_reset)，否则台账重建不出这段历史；
 *  (d)  backfillAlertDedupeKeys 对键形状不同的类别必须拒绝执行（否则批量打错键）；
 *  (e)  close / ack 的幂等键必须稳定（原来嵌 now.toISOString()，等于没有幂等）。
 */
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { ackAlert, backfillAlertDedupeKeys, closeAlert, upsertAlerts } from "@/server/modules/alerts/engine";
import type { SessionUser } from "@/server/core/dto";

const cand = (k: string, severity: "medium" | "high" | "critical" = "medium") => ({
  refKey: k, dedupeKey: `t:${k}`, title: `告警 ${k}`, severity, ownerRole: "pmc",
});

/**
 * 把「人工关闭在引擎读完 open 快照之后、写自动关闭之前落地」这件事变成确定性的：
 * 代理 db，在引擎发出的**第一次 UPDATE** 真正执行前插进去一次人工关闭。
 */
type Fn = (...args: unknown[]) => unknown;
type Thenable = (onOk: unknown, onErr: unknown) => unknown;

function dbWithInterleavedWrite<T extends object>(db: T, interleave: () => Promise<unknown>): T {
  let fired = false;
  const wrapBuilder = <B extends object>(builder: B): B => new Proxy(builder, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "then") {
        return (onOk: unknown, onErr: unknown) => interleave()
          .then(() => new Promise((res, rej) => (value as Thenable).call(target, res, rej)))
          .then(onOk as never, onErr as never);
      }
      return typeof value === "function"
        ? (...args: unknown[]) => wrapBuilder((value as Fn).apply(target, args) as object)
        : value;
    },
  });
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === "update" && !fired) {
        fired = true;
        return (...args: unknown[]) => wrapBuilder((value as Fn).apply(target, args) as object);
      }
      return typeof value === "function" ? (value as Fn).bind(target) : value;
    },
  });
}

describe("预警引擎护栏", () => {
  it("auto-close evidence predicate sees the stored source and cannot promote missing or changed provenance", async () => {
    const { db, client } = await createTestDb();
    try {
      const old = new Date("2026-09-01T03:00:00Z");
      await upsertAlerts(db, { category: "source_guard", now: old, candidates: [
        { ...cand("same"), paramsSnapshot: { primaryDailySource: "ledger" } },
        { ...cand("changed"), paramsSnapshot: { primaryDailySource: "external" } },
        cand("unknown"),
      ] });
      const result = await upsertAlerts(db, { category: "source_guard", candidates: [], now: new Date("2026-09-08T03:00:00Z"), autoClosePredicate: previous => previous.paramsSnapshot?.primaryDailySource === "ledger" });
      expect(result).toMatchObject({ autoClosed: 1, stillOpen: 2 });
      expect((await db.select().from(schema.systemAlerts)).filter(row => row.status === "resolved").map(row => row.refKey)).toEqual(["same"]);
    } finally { await client.close(); }
  });
  it("历史NULL与数据库微秒时间戳未变化时仍可正常关闭，不被JS毫秒精度卡住", async () => {
    const { db, client } = await createTestDb();
    try {
      await db.insert(schema.systemAlerts).values([
        { category: "legacy_cas", refKey: "null", dedupeKey: "legacy:null", title: "历史无命中时间", severity: "high", createdAt: new Date("2026-09-01T03:00:00Z") },
        { category: "legacy_cas", refKey: "micros", dedupeKey: "legacy:micros", title: "历史SQL时间", severity: "high", createdAt: new Date("2026-09-01T03:00:00Z") },
      ]);
      await db.execute(sql`UPDATE system_alerts SET last_hit_at = '2026-09-01T03:00:00.000123Z'::timestamptz WHERE dedupe_key = 'legacy:micros'`);
      expect(await upsertAlerts(db, { category: "legacy_cas", candidates: [], now: new Date("2026-09-08T03:00:00Z"), autoCloseEligibleKeys: ["legacy:null", "legacy:micros"] })).toMatchObject({ autoClosed: 2, stillOpen: 0 });
    } finally { await client.close(); }
  });
  it.each([0, 3])("并发再次命中不能被旧评估自动关闭（迟滞%s天）；未变化的另一个对象仍正常关闭", async (days) => {
    const { db, client } = await createTestDb();
    try {
      const t0 = new Date("2026-09-01T03:00:00.000Z");
      const now = new Date("2026-09-08T03:00:00.000Z");
      await upsertAlerts(db, { category: "race_rehit", candidates: [cand("A"), cand("B")], now: t0 });
      const raced = dbWithInterleavedWrite(db, () => upsertAlerts(db, {
        category: "race_rehit", candidates: [{ ...cand("A", "critical"), title: "较新评估仍然命中" }], now,
        autoCloseEligibleKeys: [],
      }));
      const result = await upsertAlerts(raced, { category: "race_rehit", candidates: [], now, autoCloseAfterDays: days, autoCloseEligibleKeys: ["t:A", "t:B"] });
      expect(result.autoClosed).toBe(1);
      const alerts = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.category, "race_rehit"));
      expect(alerts.find(a => a.refKey === "A")).toMatchObject({ status: "open", title: "较新评估仍然命中", severity: "critical", lastHitAt: now, autoResolved: false });
      expect(alerts.find(a => a.refKey === "B")).toMatchObject({ status: "resolved", autoResolved: true });
      const closes = (await db.select().from(schema.alertEvents)).filter(e => e.event === "close");
      expect(closes).toHaveLength(1);expect(closes[0].alertId).toBe(alerts.find(a => a.refKey === "B")!.id);
    } finally { await client.close(); }
  });
  it("A5：人工关闭在自动关闭前落地 → 不被覆盖成 autoResolved，也不多写一条 close 事件", async () => {
    const { db, client } = await createTestDb();
    try {
      const [u] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"], isApprover: false }).returning();
      const pmc: SessionUser = { id: u.id, name: u.name, roles: ["pmc"], isApprover: false };
      const t0 = new Date("2026-09-03T03:00:00.000Z");
      await upsertAlerts(db, { category: "race_close", candidates: [cand("A")], now: t0, autoCloseAfterDays: 0 });
      const [a] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "A"));

      // 本轮候选为空 → 引擎准备自动关闭 A；人工关闭在那次 UPDATE 之前落地
      const tRun = new Date(t0.getTime() + 3_600_000);
      const raced = dbWithInterleavedWrite(db, () => closeAlert(pmc, a.id, "wont_fix", "我来处理", db, { now: new Date(t0.getTime() + 1_800_000) }));
      const res = await upsertAlerts(raced, { category: "race_close", candidates: [], now: tRun, autoCloseAfterDays: 0 });

      const [after] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, a.id));
      // 修复前：status 已 resolved 但会被 UPDATE 无条件覆盖成 autoResolved=true，且再落一条 close 事件
      expect(after).toMatchObject({ status: "resolved", autoResolved: false });
      expect(res.autoClosed).toBe(0);
      const closes = await db.select().from(schema.alertEvents)
        .where(and(eq(schema.alertEvents.alertId, a.id), eq(schema.alertEvents.event, "close")));
      expect(closes).toHaveLength(1);
      expect(closes[0]).toMatchObject({ reasonCode: "wont_fix", actorId: pmc.id });
    } finally {
      await client.close();
    }
  });

  it("(a)：autoCloseAfterDays=0 的关闭说明写「即刻关闭」，不写「连续 0 天未命中」", async () => {
    const { db, client } = await createTestDb();
    try {
      const t0 = new Date("2026-09-03T03:00:00.000Z");
      await upsertAlerts(db, { category: "note_cat", candidates: [cand("A"), cand("B")], now: t0, autoCloseAfterDays: 0 });
      await upsertAlerts(db, { category: "note_cat", candidates: [cand("A")], now: new Date(t0.getTime() + 3_600_000), autoCloseAfterDays: 0 });
      const [close0] = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "close"));
      expect(close0.note).not.toContain("连续 0 天");
      expect(close0.note).toContain("即刻关闭");

      // 迟滞类别仍写"连续 N 天未命中"
      await upsertAlerts(db, { category: "note3_cat", candidates: [cand("C"), cand("D")], now: t0 });
      await upsertAlerts(db, { category: "note3_cat", candidates: [cand("C")], now: new Date(t0.getTime() + 5 * 86_400_000) });
      const closes = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "close"));
      expect(closes.find((e) => e.note?.includes("连续 3 天未命中"))).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it("(c)：清知悉落 alert_events(ack_reset)，带原因与前后严重度", async () => {
    const { db, client } = await createTestDb();
    try {
      const [u] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"], isApprover: false }).returning();
      const pmc: SessionUser = { id: u.id, name: u.name, roles: ["pmc"], isApprover: false };
      const t0 = new Date("2026-09-03T03:00:00.000Z");
      await upsertAlerts(db, { category: "ackreset_cat", candidates: [cand("A", "medium")], now: t0 });
      const [a] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "A"));
      await ackAlert(pmc, a.id, db, "看到了");

      // 严重度升级 → 清知悉
      const r = await upsertAlerts(db, { category: "ackreset_cat", candidates: [cand("A", "high")], now: new Date(t0.getTime() + 3_600_000) });
      expect(r.ackReset).toBe(1);
      const [reset] = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "ack_reset"));
      expect(reset).toMatchObject({ alertId: a.id, actorId: null });
      expect(reset.note).toContain("严重度升级");
      expect(reset.evidenceRef).toMatchObject({ reason: "severity_up", prevSeverity: "medium", nextSeverity: "high" });
      const [after] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, a.id));
      expect(after.ackedAt).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("(d)：键形状不同的类别拒绝回填；传 buildKey 才放行", async () => {
    const { db, client } = await createTestDb();
    try {
      await db.insert(schema.systemAlerts).values([
        { category: "inventory_cover", refKey: "SKU-1", title: "历史断货", severity: "high", status: "resolved", autoResolved: false, resolvedAt: new Date() },
        { category: "data_freshness", refKey: "jst", title: "历史过期", severity: "medium", status: "resolved", autoResolved: false, resolvedAt: new Date() },
      ]);
      // inventory_cover 的真实键是 inventory_cover:<skuId>，不是 inventory_cover:<refKey>
      await expect(backfillAlertDedupeKeys(db, "inventory_cover")).rejects.toThrow(/拒绝回填/);
      const [untouched] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.category, "inventory_cover"));
      expect(untouched.dedupeKey).toBeNull();

      // 白名单内的类别照常回填
      expect(await backfillAlertDedupeKeys(db, "data_freshness")).toBe(1);
      const [fresh] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.category, "data_freshness"));
      expect(fresh.dedupeKey).toBe("data_freshness:jst");

      // 显式给出键构造 → 放行，且用的是调用方的形状
      expect(await backfillAlertDedupeKeys(db, "inventory_cover", { buildKey: (ref) => `inventory_cover:99:${ref}` })).toBe(1);
      const [cover] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.category, "inventory_cover"));
      expect(cover.dedupeKey).toBe("inventory_cover:99:SKU-1");
    } finally {
      await client.close();
    }
  });

  it("(e)：close / ack 幂等键稳定，不含调用时刻", async () => {
    const { db, client } = await createTestDb();
    try {
      const [u] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"], isApprover: false }).returning();
      const pmc: SessionUser = { id: u.id, name: u.name, roles: ["pmc"], isApprover: false };
      const t0 = new Date("2026-09-03T03:00:00.000Z");
      await upsertAlerts(db, { category: "key_cat", candidates: [cand("A"), cand("B")], now: t0 });
      const [a] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "A"));
      const [b] = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.refKey, "B"));
      await ackAlert(pmc, a.id, db, "看到了");
      await closeAlert(pmc, b.id, "fixed", "处理完了", db, { now: new Date(t0.getTime() + 60_000) });
      const events = await db.select().from(schema.alertEvents);
      const keyOf = (event: string) => events.find((e) => e.event === event)!.idempotencyKey;
      // ackAlert 取真实时刻（无 now 注入）：按同一份上海日公式算期望值，断言的是"键=告警+事件+上海日"这个形状
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
      expect(keyOf("ack")).toBe(`${a.id}:ack:${today}`);
      expect(keyOf("close")).toBe(`${b.id}:close`);
      for (const e of events) expect(e.idempotencyKey).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}Z/);
      // Ordinary retries must not add a fact. Clearing acknowledgement is a new
      // generation, not a retry; the real engine-reset path is tested separately.
      await ackAlert(pmc, a.id, db, "重复请求");
      expect((await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "ack"))).length).toBe(1);
      await db.update(schema.systemAlerts).set({ ackedAt: null, ackedBy: null }).where(eq(schema.systemAlerts.id, a.id));
      await ackAlert(pmc, a.id, db, "又看到了");
      const ackEvents = await db.select().from(schema.alertEvents).where(eq(schema.alertEvents.event, "ack"))
        .orderBy(schema.alertEvents.id);
      expect(ackEvents).toHaveLength(2);
      expect(ackEvents[1].idempotencyKey).toBe(`${a.id}:ack:${today}:after:${ackEvents[0].id}`);
    } finally {
      await client.close();
    }
  });
});
