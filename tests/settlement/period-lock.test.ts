/**
 * W2-1 会计期间锁回归门。
 *
 * 修复前的事实：`month-close.ts` 的 `periodClosed` 只是 `month < 当前月` 的日历推断，
 * 系统里**没有任何**期间锁表，`posting/post.ts` 也**没有任何**期间检查——
 * 签认完成的月份照样可以过账，账一变，已经签过字的月结报告就永久对不上了。
 *
 * 本文件的每一条断言在修复前都会失败：
 * - `post()` 对已关账期间不抛错（当时根本没有 CLOSED_PERIOD 这个错误码）；
 * - `period_locks` 表不存在；
 * - `periodClosed` 与谁签认过无关。
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, skus, spus, stockLedger, users, warehouses } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { post, PostingError, reverse, type PostingEvent } from "@/server/posting";
import { getMonthCloseChecklist, updateMonthCloseCheck } from "@/server/modules/settlement/month-close";
import {
  closePeriod, getPeriodLock, isPeriodClosed, listClosedPeriods, periodOf, reopenPeriod,
} from "@/server/modules/settlement/period-lock";
import { createTestDb, type TestDb } from "../helpers/db";

const CLOSED_MONTH = "2026-07";
/** 2026-07-15 12:00 Asia/Shanghai —— 落在已关账期间内 */
const IN_CLOSED = new Date("2026-07-15T04:00:00.000Z");
/** 2026-08-10 12:00 Asia/Shanghai —— 开放期间 */
const IN_OPEN = new Date("2026-08-10T04:00:00.000Z");
const NOW = new Date("2026-08-20T04:00:00.000Z");

let db: TestDb;
let finance: SessionUser;
let admin: SessionUser;
let warehouse: SessionUser;
let skuId: number;
let warehouseId: number;

async function seed() {
  ({ db } = await createTestDb());
  const [f] = await db.insert(users).values({ name: "月结财务", roles: ["finance"] }).returning();
  const [a] = await db.insert(users).values({ name: "系统管理员", roles: ["admin"] }).returning();
  const [w] = await db.insert(users).values({ name: "仓管", roles: ["warehouse"] }).returning();
  finance = { id: f.id, name: f.name, roles: ["finance"], isApprover: false };
  admin = { id: a.id, name: a.name, roles: ["admin"], isApprover: true };
  warehouse = { id: w.id, name: w.name, roles: ["warehouse"], isApprover: false };
  const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
  const [sku] = await db
    .insert(skus)
    .values({ code: "YL00001", spuId: spu.id, baseUom: "kg", skuType: "raw" })
    .returning();
  const [wh] = await db.insert(warehouses).values({ code: "WH-R", name: "原料仓", kind: "raw" }).returning();
  skuId = sku.id;
  warehouseId = wh.id;
}

/** 六项检查全部例外关闭（自动控制在空库里不会全 pass），把月份推到「可关账」 */
async function signOffAllChecks() {
  for (const key of [
    "data_release", "operational_docs", "inventory_count",
    "jst_reconciliation", "borrow_reconciliation", "settlement_close",
  ] as const) {
    const list = await getMonthCloseChecklist(CLOSED_MONTH, db, NOW);
    const check = list.checks.find((c) => c.key === key)!;
    await updateMonthCloseCheck(finance, {
      month: CLOSED_MONTH,
      checkKey: key,
      status: "waived",
      note: "回归测试：例外关闭以便验证期间锁",
      version: check.version,
    }, db);
  }
}

async function openingEvent(occurredAt: Date, sourceDocId: number) {
  return post(db, {
    sourceDocType: "opening",
    sourceDocId,
    action: "post",
    occurredAt,
    lines: [{ sourceLineId: 1, skuId, warehouseId, qtyDelta: "10" }],
  });
}

describe("W2-1 会计期间锁", () => {
  beforeEach(async () => {
    await seed();
  });

  it("periodOf 按 Asia/Shanghai 日界归期（UTC 月末夜间不得漏到上个月）", () => {
    // 2026-07-31 17:00Z = 2026-08-01 01:00 上海 → 属于 8 月
    expect(periodOf(new Date("2026-07-31T17:00:00.000Z"))).toBe("2026-08");
    expect(periodOf(new Date("2026-07-31T15:00:00.000Z"))).toBe("2026-07");
  });

  it("六项检查未收口时不得关账；全部收口后才写入期间锁", async () => {
    await expect(closePeriod(finance, { period: CLOSED_MONTH }, db, NOW))
      .rejects.toThrow(/尚未收口/);
    expect(await isPeriodClosed(db, CLOSED_MONTH)).toBe(false);

    await signOffAllChecks();
    expect((await getMonthCloseChecklist(CLOSED_MONTH, db, NOW)).closable).toBe(true);
    await closePeriod(finance, { period: CLOSED_MONTH, note: "7 月预关账完成" }, db, NOW);
    expect(await isPeriodClosed(db, CLOSED_MONTH)).toBe(true);

    const lock = await getPeriodLock(CLOSED_MONTH, db);
    expect(lock).toMatchObject({ closed: true, closedByName: "月结财务", closeNote: "7 月预关账完成" });
    expect((await listClosedPeriods(db)).map((r) => r.period)).toEqual([CLOSED_MONTH]);
  });

  it("当前月/未来月不可关账（还没过完的月份谈不上关账）", async () => {
    await expect(closePeriod(finance, { period: "2026-08" }, db, NOW)).rejects.toThrow(/当前月及未来月份/);
  });

  it("关账后：业务时间落在该期间的过账被拒（CLOSED_PERIOD），且不留下任何流水", async () => {
    await signOffAllChecks();
    await closePeriod(finance, { period: CLOSED_MONTH }, db, NOW);

    const err = await openingEvent(IN_CLOSED, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostingError);
    expect((err as PostingError).code).toBe("CLOSED_PERIOD");
    expect((err as PostingError).message).toContain("2026-07");
    expect(await db.select().from(stockLedger)).toHaveLength(0);

    // 开放期间不受影响
    expect((await openingEvent(IN_OPEN, 2)).posted).toBe(true);
    expect(await db.select().from(stockLedger)).toHaveLength(1);
  });

  it("红字冲销**不豁免**期间锁：冲销进已关账期间被拒，按当前开放期间冲销则正常", async () => {
    // 先在 7 月过一笔（此时还没关账）
    await openingEvent(IN_CLOSED, 10);
    await signOffAllChecks();
    await closePeriod(finance, { period: CLOSED_MONTH }, db, NOW);

    const original: PostingEvent = {
      sourceDocType: "opening",
      sourceDocId: 10,
      action: "post",
      lines: [{ sourceLineId: 1, skuId, warehouseId, qtyDelta: "10" }],
    };

    // 冲销行标业务时间到已关账期间 → 拒绝
    const err = await reverse(db, { ...original, occurredAt: IN_CLOSED }, 99).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostingError);
    expect((err as PostingError).code).toBe("CLOSED_PERIOD");

    // 默认（不指定业务时间=当前开放期间）→ 冲销通道保持可用，纠错不被锁死
    expect((await reverse(db, { ...original }, 99)).posted).toBe(true);
  });

  it("重开：仅管理员、必须留原因、同事务写审计；重开后该期间可再过账", async () => {
    await signOffAllChecks();
    await closePeriod(finance, { period: CLOSED_MONTH }, db, NOW);

    await expect(reopenPeriod(finance, { period: CLOSED_MONTH, reason: "财务想改数" }, db, NOW))
      .rejects.toThrow(/仅管理员/);
    await expect(reopenPeriod(admin, { period: CLOSED_MONTH, reason: "太短" }, db, NOW))
      .rejects.toThrow(/至少 5 个字符/);

    await reopenPeriod(admin, { period: CLOSED_MONTH, reason: "补录 7 月漏掉的一张调拨单" }, db, NOW);
    expect(await isPeriodClosed(db, CLOSED_MONTH)).toBe(false);
    expect((await openingEvent(IN_CLOSED, 3)).posted).toBe(true);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "period_lock"));
    expect(audits.map((a) => a.action).sort()).toEqual(["period_close", "period_reopen"]);
    const reopenAudit = audits.find((a) => a.action === "period_reopen")!;
    expect(reopenAudit.userId).toBe(admin.id);
    expect(reopenAudit.after).toMatchObject({ period: CLOSED_MONTH, reason: "补录 7 月漏掉的一张调拨单" });

    // 重开后可再次关账（同一行复用）
    await closePeriod(finance, { period: CLOSED_MONTH }, db, NOW);
    expect(await isPeriodClosed(db, CLOSED_MONTH)).toBe(true);
  });

  it("已关账期间不得再改月结签认（否则签认与锁会脱节）", async () => {
    await signOffAllChecks();
    await closePeriod(finance, { period: CLOSED_MONTH }, db, NOW);
    const list = await getMonthCloseChecklist(CLOSED_MONTH, db, NOW);
    expect(list.periodClosed).toBe(true);
    await expect(updateMonthCloseCheck(finance, {
      month: CLOSED_MONTH,
      checkKey: "data_release",
      status: "pending",
      version: list.checks.find((c) => c.key === "data_release")!.version,
    }, db)).rejects.toThrow(/已关账/);
  });

  it("幂等重放不因事后关账而报错（已过账事件重试仍短路返回 posted:false）", async () => {
    await openingEvent(IN_CLOSED, 20);
    await signOffAllChecks();
    await closePeriod(finance, { period: CLOSED_MONTH }, db, NOW);
    expect((await openingEvent(IN_CLOSED, 20)).posted).toBe(false);
    expect(warehouse.roles).toContain("warehouse"); // seed 完整性（仓管账号在其他用例复用）
  });
});
