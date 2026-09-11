/**
 * 补货页的**决策列**与**规整警告**：引擎早就算出来了，只是从没上过屏。
 *
 * 1) 决策字段（`shortageDate / daysToShortage / orderByDate / orderWindowMissed / safetyQty`）
 *    一直在 DTO 里，但列上没有、也不能排序；计划员只能拿「可销天数」近似——
 *    而可销不含生产周期，短周期 SKU 因此被误判为急、长周期的被误判为不急。
 *    缺省排序也改成**最晚下单日升序**：补货页要回答的是「今天该下哪几张单」。
 *
 * 2) `rules/netreq.suggestQtyDetailed` 支持 `maxOrder` / `dailyDemand`，并据此发出
 *    「超买 N 天库存」「已按单次上限下调」两类警告——而服务端从来不传这两个入参，
 *    这两条警告**结构上永远不可能触发**（规则写了没接）。
 *    现由运行参数 `replenish_max_order_cover_days` / `replenish_overshoot_warn_days` 驱动。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  channels, salesMonthly, skuParams, skus, spus, stockBalances, sysParams, uomConvs, users, warehouses,
} from "@/db/schema";
import {
  compareReplenishRows, getReplenishSuggestions, normalizeReplenishSort,
  REPLENISH_DEFAULT_SORT_BY, REPLENISH_SORT_FIELDS,
} from "@/server/modules/replenish/service";
import { createTestDb, type TestDb } from "../helpers/db";
import { clearParamCache } from "@/server/core/params";

describe("补货建议：决策列可排序 + 规整警告可触发", () => {
  let db: TestDb;
  let fast = 0; // 生产周期短：可销低但下单日晚
  let slow = 0; // 生产周期长：可销更高但下单日最早——缺省排序必须把它排在前面

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await db.insert(users).values({ name: "PMC", roles: ["pmc"] });
    const [spu] = await db.insert(spus).values({ code: "P50001", nameCn: "决策列测试品" }).returning();
    const mk = async (code: string, name: string) => {
      const [s] = await db.insert(skus).values({
        code, name, spuId: spu.id, skuType: "finished", baseUom: "盒", active: true,
      }).returning();
      return s.id;
    };
    fast = await mk("CP50001", "短周期成品");
    slow = await mk("CP50002", "长周期成品");

    const [wh] = await db.insert(warehouses).values({
      code: "WH-DC", name: "决策仓", kind: "finished", accountingMode: "realtime", active: true,
    }).returning();
    await db.insert(stockBalances).values([
      { skuId: fast, warehouseId: wh.id, batchId: null, qty: "200.0000" },
      { skuId: slow, warehouseId: wh.id, batchId: null, qty: "600.0000" },
    ]);
    const [ch] = await db.insert(channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
    for (const ym of ["2026-04", "2026-05", "2026-06"]) {
      await db.insert(salesMonthly).values([
        { skuId: fast, channelId: ch.id, yearMonth: ym, qty: "910" },
        { skuId: slow, channelId: ch.id, yearMonth: ym, qty: "910" },
      ]);
    }
    // 日均相同（唯一差别是生产周期）→ 最晚下单日完全由周期决定
    await db.insert(skuParams).values([
      { skuId: fast, normalLeadDays: 5, logisticsLeadDays: 0 },
      { skuId: slow, normalLeadDays: 90, logisticsLeadDays: 0 },
    ]);
    // 大 MOQ：净需求几百，MOQ 一万 → 超买必然发生
    await db.insert(uomConvs).values({ skuId: slow, purchaseUom: "箱", factor: "1", moq: "10000" });
  });

  it("排序白名单收录决策字段，缺省排序＝最晚下单日升序", () => {
    expect(REPLENISH_SORT_FIELDS).toContain("orderByDate");
    expect(REPLENISH_SORT_FIELDS).toContain("daysToShortage");
    expect(REPLENISH_DEFAULT_SORT_BY).toBe("orderByDate");
    expect(normalizeReplenishSort(undefined, undefined)).toEqual({ sortBy: "orderByDate", sortOrder: "ascend" });
    // 白名单外的值一律回落缺省，不是「随便按什么排」
    expect(normalizeReplenishSort("dropTable", "ascend").sortBy).toBe("orderByDate");
  });

  it("缺省排序把「今天必须下单的」排在前面——长周期 SKU 尽管可销更高", async () => {
    const res = await getReplenishSuggestions({ coverDaysTarget: 45, minCoverAlert: 30 }, db);
    const bySku = new Map(res.rows.map((r) => [r.skuId, r]));
    const f = bySku.get(fast)!;
    const s = bySku.get(slow)!;
    // 可销：长周期那个更高（600 vs 200）
    expect(s.daysCover!).toBeGreaterThan(f.daysCover!);
    // 但最晚下单日更早（短缺日 − 90 天周期）
    expect(s.orderByDate).not.toBeNull();
    expect(s.orderByDate! < (f.orderByDate ?? "9999-12-31")).toBe(true);
    expect(res.rows[0].skuId).toBe(slow);
    // 决策字段成套下发
    expect(s.shortageDate).not.toBeNull();
    expect(typeof s.daysToShortage).toBe("number");
    expect(typeof s.orderWindowMissed).toBe("boolean");
    expect(s.safetyQty).toBeGreaterThan(0);
  });

  it("显式排序 daysToShortage 降序：空值仍置底（服务端排序，不是页面自己排当前页）", async () => {
    const res = await getReplenishSuggestions({ sortBy: "daysToShortage", sortOrder: "descend" }, db);
    const vals = res.rows.map((r) => r.daysToShortage);
    const nonNull = vals.filter((v): v is number => v != null);
    expect([...nonNull].sort((a, b) => b - a)).toEqual(nonNull);
    expect(vals.slice(nonNull.length).every((v) => v == null)).toBe(true);
  });

  it("compareReplenishRows：orderByDate 为空的行无论升降序都置底", () => {
    const mk = (code: string, orderByDate: string | null) =>
      ({ code, orderByDate } as Parameters<typeof compareReplenishRows>[0]);
    const withDate = mk("A", "2026-09-10");
    const noDate = mk("B", null);
    expect(compareReplenishRows(noDate, withDate, "orderByDate", "ascend")).toBeGreaterThan(0);
    expect(compareReplenishRows(noDate, withDate, "orderByDate", "descend")).toBeGreaterThan(0);
  });

  it("超买警告：MOQ 撑出的多买量折算天数超阈值即上行（此前服务端不传 dailyDemand，永不触发）", async () => {
    clearParamCache();
    await db.insert(sysParams).values({ scope: "global", key: "replenish_overshoot_warn_days", value: "30" });
    const res = await getReplenishSuggestions({ coverDaysTarget: 45, minCoverAlert: 30 }, db);
    const row = res.rows.find((r) => r.skuId === slow)!;
    expect(row.suggestQty).toBe("10000.0000"); // MOQ 抬上去的
    expect(row.overshootDays).not.toBeNull();
    expect(row.overshootDays!).toBeGreaterThan(30);
    const warn = row.lotWarnings.find((w) => w.message.includes("最小起订量"));
    expect(warn?.level).toBe("warn");
    expect(warn?.message).toContain("天库存");
  });

  it("单次订货上限：参数 >0 时按「日均×天数」封顶并给出可拆单提示", async () => {
    clearParamCache();
    await db.insert(sysParams).values({ scope: "global", key: "replenish_max_order_cover_days", value: "20" });
    const res = await getReplenishSuggestions({ coverDaysTarget: 45, minCoverAlert: 30 }, db);
    const daily = res.rows.find((r) => r.skuId === slow)!.daily;
    const cap = daily * 20;

    // MOQ 10000 远高于上限 → 策略自相矛盾：低于 MOQ 供应商不接单、高于上限我们不批，刻意不下调，打阻塞级警告
    const row = res.rows.find((r) => r.skuId === slow)!;
    expect(row.lotWarnings.some((w) => w.level === "blocking" && w.message.includes("策略冲突"))).toBe(true);
    expect(row.suggestQty).toBe("10000.0000");

    // 无 MOQ 的那个：真的被封顶，并提示需拆成多次订货
    const fastRow = res.rows.find((r) => r.skuId === fast)!;
    expect(fastRow.suggestQty).not.toBeNull();
    expect(Number(fastRow.suggestQty)).toBeLessThanOrEqual(cap);
    expect(fastRow.lotWarnings.some((w) => w.level === "warn" && w.message.includes("拆成多次订货"))).toBe(true);
  });
});
