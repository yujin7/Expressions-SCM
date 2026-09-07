/**
 * 架构护栏：配置阈值/容差/漂移这类**非金额**字段，不得叫 `SENSITIVE_FIELDS` 里的名字。
 *
 * 事故形状（2026-09-05 实测确认，当时线上活着）：
 * `maskSensitive` 按字段名深剥——这正是它能当唯一收口的原因，但也意味着它分不清
 * 「价格偏差」和「偏差阈值」：**同名就等于同权限**。
 *
 * `report/transfer-routes` 的响应整体过 `maskSensitive`，它的 `params.deviationPct`
 * 却是费用偏差的**提醒阈值**（一个配置百分数，不含任何价格信息）。于是 ops/仓管拿到的
 * params 里这个键被整个删掉，页面渲染成「偏差 > undefined% 提醒不阻断」——
 * 天天在做调拨的人看到坏掉的说明文字，而剥掉它什么都没保护到。
 * 同类还有 leadtime-learning 的交期容差、release preflight 的行数/数量漂移。
 *
 * 本门是**行为**检查而不是文本扫描：同一个模块里既有真金额（unitFee/amount，该剥）
 * 又有阈值（不该剥），静态扫名字分不出来，只有「过一遍 maskSensitive 看还在不在」作数。
 */
import { describe, expect, it } from "vitest";
import { maskSensitive } from "@/server/core/dto";
import { SENSITIVE_FIELDS } from "@/server/core/constants";

/** 必须对**所有**角色可见的配置字段：名字 → 它是什么 */
const MUST_SURVIVE_MASKING: Record<string, string> = {
  deviationThresholdPct: "调拨费用偏差的提醒阈值（report/transfer-routes）",
  leadDeviationTolerancePct: "交期学习的建议容差（report/leadtime-learning）",
  driftPct: "放行前置的行数/数量漂移（release/engine/preflight）",
  qtyDeviationX: "数量异常的中位数倍数阈值",
  minSamples: "样本下限",
  windowDays: "统计窗口天数",
  monthlySalesBlock: "驾驶舱月销售卡片容器：权限状态必须保留，内部金额仍脱敏",
};

describe("敏感名碰撞", () => {
  it("monthly-sales block survives while its sensitive amount is still stripped", () => {
    const input = { monthlySalesBlock: { state: "ready", data: { salesAmount: "12345.00", yearMonth: "2026-09" } } };
    expect(maskSensitive(input, ["warehouse"])).toEqual({ monthlySalesBlock: { state: "ready", data: { yearMonth: "2026-09" } } });
    expect(maskSensitive(input, ["admin"])).toEqual(input);
  });
  it("配置阈值类字段不在 SENSITIVE_FIELDS 里（在里面就等于被判成金额）", () => {
    const collided = Object.keys(MUST_SURVIVE_MASKING).filter((f) => (SENSITIVE_FIELDS as readonly string[]).includes(f));
    expect(collided, "这些是配置阈值，不是金额").toEqual([]);
  });

  it("这些字段对每个角色都要活着穿过 maskSensitive（回归：曾渲染成「偏差 > undefined%」）", () => {
    const payload = Object.fromEntries(Object.keys(MUST_SURVIVE_MASKING).map((f) => [f, 20]));
    for (const roles of [["ops"], ["warehouse"], ["quality"], ["pmc"], ["finance"], ["admin"]]) {
      const masked = maskSensitive({ params: payload }, roles) as { params: Record<string, number> };
      for (const [field, what] of Object.entries(MUST_SURVIVE_MASKING)) {
        expect(masked.params[field], `${roles[0]} 看不到「${what}」`).toBe(20);
      }
    }
  });

  it("真正的价格偏差仍然被剥掉——别把这个洞补成「不脱敏」", () => {
    expect(SENSITIVE_FIELDS).toContain("deviationPct");
    const masked = maskSensitive({ row: { deviationPct: "12.5", oldPrice: "10", newPrice: "11.25", docNo: "PC-1" } }, ["ops"]);
    expect(masked.row).toEqual({ docNo: "PC-1" });
  });

  it("调拨线路里真正的金额仍然被剥（阈值可见 ≠ 费用可见）", () => {
    const lane = { medianUnitFee: "5.0000", avgUnitFee: "4.8", amount: "1200.00", deviationThresholdPct: 20, samples: 9 };
    expect(maskSensitive({ lane }, ["ops"]).lane).toEqual({ deviationThresholdPct: 20, samples: 9 });
    expect(maskSensitive({ lane }, ["finance"]).lane).toEqual(lane);
  });
});
