/**
 * W3 / W5 / B7 逐行可解释：
 * - targetBasis：目标覆盖天数到底由哪一层给出（页面 > 分域 sku/brand/segment > ABC 分层 > 全局），
 *   并证明分域覆盖**真的生效**（此前 /api/admin/params/scoped 写得进、建议量纹丝不动）；
 * - safetyDaysBasis：安全库存兜底天数命中的分域层；
 * - noSuggestReason：suggestQty=null 时的结构化原因（六种），空单元格不再模棱两可；
 * - declinedToday：当日「已复核并放弃」由服务端（审计台账）下发，不再只存在点击者的浏览器里；
 * - forecastAccuracy：引擎本就算好的滚动回测 WAPE/偏差随行下发。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  brands, channels, salesMonthly, skuParams, skus, spus, stockBalances, transitRefs, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { clearScopedParamCache, setScopedParam } from "@/server/core/scoped-params";
import { declineReplenishSuggestion } from "@/server/modules/replenish/decline";
import { getReplenishSuggestions, type ReplenishRow } from "@/server/modules/replenish/service";
import { createTestDb, type TestDb } from "../helpers/db";

const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];

describe("replenish/service：目标依据 / 无建议原因 / 放弃状态 / 预测误差", () => {
  let db: TestDb;
  let admin: SessionUser;
  let pmc: SessionUser;
  let brandId = 0;
  const sku: Record<string, number> = {};

  const rowOf = async (code: string, query = {}): Promise<ReplenishRow> => {
    const res = await getReplenishSuggestions({ allRows: true, ...query }, db);
    const r = res.rows.find((x) => x.code === code);
    if (!r) throw new Error(`未找到 ${code}`);
    return r;
  };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    clearScopedParamCache();
    const [a] = await db.insert(users).values({ name: "管理员", roles: ["admin"] }).returning();
    const [p] = await db.insert(users).values({ name: "计划员", roles: ["pmc"] }).returning();
    admin = { id: a.id, name: a.name, roles: ["admin"], isApprover: false };
    pmc = { id: p.id, name: p.name, roles: ["pmc"], isApprover: false };
    const [b] = await db.insert(brands).values({ code: "EXP", nameCn: "解释品牌", nameEn: "EXP" }).returning();
    brandId = b.id;
    const [spu] = await db.insert(spus).values({ code: "EXP01", nameCn: "解释品" }).returning();
    const [ch] = await db.insert(channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
    const [wh] = await db.insert(warehouses).values({ code: "EX-WH", name: "成品仓", kind: "finished", accountingMode: "realtime" }).returning();

    const mk = async (code: string, name: string): Promise<number> => {
      const [s] = await db.insert(skus).values({ code, name, spuId: spu.id, skuType: "finished", baseUom: "件", brandId }).returning();
      sku[code] = s.id;
      return s.id;
    };
    const sales = async (skuId: number, qty: string): Promise<void> => {
      await db.insert(salesMonthly).values(MONTHS.map((ym) => ({ skuId, channelId: ch.id, yearMonth: ym, qty })));
    };
    const stock = async (skuId: number, qty: string): Promise<void> => {
      await db.insert(stockBalances).values({ skuId, warehouseId: wh.id, batchId: null, qty });
    };

    // 日均 = 3 月合计 ÷ 91；300/月 → 900/91 ≈ 9.89 件/天
    const cover = await mk("R-COVER", "库存充足");
    await sales(cover, "300");
    await stock(cover, "100000"); // 视野内水位始终高于安全库存
    await db.insert(skuParams).values({ skuId: cover, normalLeadDays: 10, logisticsLeadDays: 0 });

    const noDemand = await mk("R-NODEMAND", "有历史无动销");
    await sales(noDemand, "0");
    await stock(noDemand, "500");

    await mk("R-NOHISTORY", "无销量历史"); // 完全没有 sales_monthly 行

    const leadUnknown = await mk("R-LEADUNKNOWN", "缺生产周期");
    await sales(leadUnknown, "300");
    // 约 60 天后才跌破安全库存（留足余量：本文件后续用例会把品牌层兜底天数调到 21 天），
    // 而无生产周期时行动窗口只能按预警阈值 30 天近似 → 不触发，且无法倒推最晚下单日
    await stock(leadUnknown, "800");

    const notTriggered = await mk("R-NOTTRIGGERED", "短缺尚远");
    await sales(notTriggered, "300");
    // 有生产周期 → 统计法安全库存（本序列无波动 → 0）；800/9.89 会超出推演视野，故取 400：
    // 约 41 天后跌破安全线，落在视野内但远超 10 天行动窗口 → 现在下单过早
    await stock(notTriggered, "400");
    await db.insert(skuParams).values({ skuId: notTriggered, normalLeadDays: 10, logisticsLeadDays: 0 });

    const suppressed = await mk("R-SUPPRESS", "覆盖缺口抑制");
    await sales(suppressed, "300");
    await stock(suppressed, "50"); // 系统可销 ~5 天 < 行动窗口 10 天 → 触发
    await db.insert(skuParams).values({ skuId: suppressed, normalLeadDays: 10, logisticsLeadDays: 0 });
    await db.insert(transitRefs).values({ kind: "stock_summary", skuId: suppressed, qty: "5000", progress: "2026-07-21", sourceJobId: 1 });
  });

  it("W3 目标依据：默认落 ABC 分层 / 无分层落全局；品牌与 SKU 分域覆盖真的生效；页面输入优先级最高", async () => {
    /* 默认：有分层走 cover_target_days_a/b/c，无销量历史的 SKU 无分层 → 全局 45 */
    const cover = await rowOf("R-COVER");
    expect(cover.abcClass).not.toBeNull();
    expect(cover.targetBasis.source).toBe(`abc_${cover.abcClass!.toLowerCase()}`);
    expect(cover.targetBasis.value).toBe(cover.effectiveTarget);
    expect(cover.targetBasis.abcClass).toBe(cover.abcClass);
    expect(cover.targetBasis.label).toContain(`ABC ${cover.abcClass}`);

    const noHistory = await rowOf("R-NOHISTORY");
    expect(noHistory.abcClass).toBeNull();
    expect(noHistory.targetBasis.source).toBe("global");
    expect(noHistory.targetBasis.value).toBe(45);

    /* 品牌层覆盖：解析器命中 brand → 压过 ABC 分层默认值（否则那次设置等于没设） */
    await setScopedParam(admin, { key: "cover_target_days", scope: { kind: "brand", brandId }, value: 33 }, db);
    const branded = await rowOf("R-COVER");
    expect(branded.targetBasis).toMatchObject({ source: "brand", value: 33, scope: `brand:${brandId}` });
    expect(branded.effectiveTarget).toBe(33);
    expect(branded.targetBasis.label).toContain("品牌「解释品牌」");

    /* SKU 层再覆盖品牌层 */
    await setScopedParam(admin, { key: "cover_target_days", scope: { kind: "sku", skuId: sku["R-COVER"] }, value: 21 }, db);
    const skuLevel = await rowOf("R-COVER");
    expect(skuLevel.targetBasis).toMatchObject({ source: "sku", value: 21, scope: `sku:${sku["R-COVER"]}` });
    expect(skuLevel.effectiveTarget).toBe(21);
    // 同品牌的其他 SKU 仍是品牌层
    expect((await rowOf("R-NOTTRIGGERED")).targetBasis).toMatchObject({ source: "brand", value: 33 });

    /* 页面显式指定目标天数：覆盖全部层级并如实标注 */
    const userTarget = await rowOf("R-COVER", { coverDaysTarget: 50 });
    expect(userTarget.targetBasis).toMatchObject({ source: "user", value: 50, scope: null });
    expect(userTarget.effectiveTarget).toBe(50);
  });

  it("W3 安全库存兜底依据：默认系统缺省，分层/品牌覆盖后命中层随之改变", async () => {
    const before = await rowOf("R-NOHISTORY");
    expect(before.safetyDaysBasis).toMatchObject({ layer: "fallback", scope: "fallback", value: 7 });
    expect(before.safetyDaysBasis.label).toContain("系统缺省");

    await setScopedParam(admin, { key: "safety_days_fallback", scope: { kind: "brand", brandId }, value: 21 }, db);
    const after = await rowOf("R-NOHISTORY");
    expect(after.safetyDaysBasis).toMatchObject({ layer: "brand", scope: `brand:${brandId}`, value: 21 });
    expect(after.safetyDaysBasis.label).toContain("品牌「解释品牌」");
  });

  it("W3 无建议原因：库存充足 / 无动销 / 无销量历史 / 缺生产周期 / 未到窗口 / 已抑制", async () => {
    const res = await getReplenishSuggestions({ allRows: true }, db);
    const byCode = new Map(res.rows.map((r) => [r.code, r]));
    const reason = (code: string): { code: string; label: string; text: string } => {
      const r = byCode.get(code)!;
      expect(r.suggestQty, `${code} 不应有建议量`).toBeNull();
      expect(r.noSuggestReason, `${code} 应给出无建议原因`).not.toBeNull();
      return r.noSuggestReason!;
    };
    expect(reason("R-COVER").code).toBe("cover_ok");
    expect(reason("R-NODEMAND").code).toBe("no_demand");
    expect(reason("R-NOHISTORY").code).toBe("insufficient_history");
    expect(reason("R-LEADUNKNOWN").code).toBe("lead_unknown");
    expect(reason("R-LEADUNKNOWN").text).toContain("供应参数");
    expect(reason("R-NOTTRIGGERED").code).toBe("not_triggered");

    const supp = byCode.get("R-SUPPRESS")!;
    expect(supp.suppressReason).not.toBeNull();
    expect(supp.heldQty).not.toBeNull();
    expect(supp.noSuggestReason!.code).toBe("ref_gap_suppressed");
    expect(supp.noSuggestReason!.label).toBe("已抑制");
    // 原因同时进可解释链，不需要点开 tooltip 也能在计算链里看到
    expect(supp.planExplain.some((e) => e.startsWith("未给出建议："))).toBe(true);
  });

  it("B7 预测误差随行下发：有 6 个月历史即可滚动回测，无历史则为 null 不硬凑", async () => {
    const cover = await rowOf("R-COVER");
    expect(cover.forecastAccuracy.samples).toBe(3); // 6 期序列、起测需 3 期历史 → 3 个回测点
    expect(cover.forecastAccuracy.reliable).toBe(true);
    expect(typeof cover.forecastAccuracy.wape).toBe("number");
    expect(cover.forecastAccuracy.bias).not.toBeNull();

    const noHistory = await rowOf("R-NOHISTORY");
    expect(noHistory.forecastAccuracy).toMatchObject({ samples: 0, wape: null, bias: null, fva: null, reliable: false });
  });

  it("W5 放弃状态由服务端下发：谁、何时、什么原因；换会话仍可见", async () => {
    expect((await rowOf("R-SUPPRESS")).declinedToday).toBeNull();
    await declineReplenishSuggestion(pmc, { skuId: sku["R-SUPPRESS"], reason: "海外仓已有货", reasonCode: "reference_stock_sufficient" }, db);
    const r = await rowOf("R-SUPPRESS");
    expect(r.declinedToday).toMatchObject({ by: "计划员", reason: "海外仓已有货", reasonCode: "reference_stock_sufficient" });
    expect(r.declinedToday!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 只对被放弃的那个 SKU 打标
    expect((await rowOf("R-COVER")).declinedToday).toBeNull();
  });
});
