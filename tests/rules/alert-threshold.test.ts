/** D57 库存预警阈值（rules/alert-threshold.ts） */
import { describe, expect, it } from "vitest";
import { alertDays, coverStatus, coverStatusWithSupply, leadBasisText, leadCompareText } from "@/server/rules/alert-threshold";

const defaults = { production: 30, logistics: 15 };

describe("alertDays", () => {
  it("三段齐全：加工 + 在途 + 缓冲，basis 标 sku_params", () => {
    const r = alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5 });
    expect(r.days).toBe(32);
    expect(r.usedDefault).toBe(false);
    expect(r.basis).toEqual([
      { part: "production", value: 20, source: "sku_params", field: "normal_lead_days" },
      { part: "logistics", value: 7, source: "sku_params", field: "logistics_lead_days" },
      { part: "buffer", value: 5, source: "param", field: null },
    ]);
  });
  it("缺加工周期 → 采购周期顶上；再缺 → 全局缺省并标 usedDefault", () => {
    const viaPurchase = alertDays({ normalLeadDays: null, purchaseLeadDays: 12, logisticsLeadDays: 3, defaults, bufferDays: 5 });
    expect(viaPurchase.days).toBe(20);
    expect(viaPurchase.basis[0]).toMatchObject({ source: "sku_params", field: "purchase_lead_days" });
    const viaDefault = alertDays({ defaults, bufferDays: 5 });
    expect(viaDefault.days).toBe(50); // 30 + 15 + 5
    expect(viaDefault.usedDefault).toBe(true);
    expect(viaDefault.basis.filter((b) => b.source === "default").map((b) => b.part)).toEqual(["production", "logistics"]);
  });
  it("0 是合法显式值（本地在途 0 天）；负数视为缺省", () => {
    expect(alertDays({ normalLeadDays: 10, logisticsLeadDays: 0, defaults, bufferDays: 5 }).days).toBe(15);
    const neg = alertDays({ normalLeadDays: -1, logisticsLeadDays: 0, defaults, bufferDays: 5 });
    expect(neg.days).toBe(35);
    expect(neg.basis[0].source).toBe("default");
  });
});

describe("coverStatus", () => {
  it("红 < alert；黄 ≤ target（未越界）；绿其余", () => {
    expect(coverStatus(10, 50, 60)).toBe("alert");
    expect(coverStatus(50, 50, 60)).toBe("watch");
    expect(coverStatus(60, 50, 60)).toBe("watch");
    expect(coverStatus(61, 50, 60)).toBe("ok");
  });
  it("无销速（null/Infinity）→ ok；无目标线 → 无黄区", () => {
    expect(coverStatus(null, 50, 60)).toBe("ok");
    expect(coverStatus(Number.POSITIVE_INFINITY, 50, 60)).toBe("ok");
    expect(coverStatus(55, 50, null)).toBe("ok");
  });
});

describe("alertDays：学习交期只观察不生效（审计 #6）", () => {
  it("样本 ≥ 3 且 P90 超档案 > 容差 → basis 追加 learned 段（observeOnly），days 不变", () => {
    const r = alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5, learned: { p50: 22, p90: 30, samples: 12, onTimeRate: 0.6 }, learnedToleranceDays: 3 });
    expect(r.days).toBe(32); // 阈值未变
    expect(r.learned).toEqual({ archiveDays: 20, p50: 22, p90: 30, samples: 12, onTimeRate: 0.6, delta: 10, toleranceDays: 3, observeOnly: true, applied: false });
    expect(r.basis.at(-1)).toEqual({ part: "learned", value: 10, source: "learned", field: null, observeOnly: true });
    expect(r.basis.filter((b) => !b.observeOnly).reduce((a, b) => a + b.value, 0)).toBe(r.days);
    expect(r.usedDefault).toBe(false); // learned 不算缺省
  });
  it("样本不足 / 超出不过容差 / 无 P90 / 未传 → 不记观察项", () => {
    expect(alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5, learned: { p50: 22, p90: 30, samples: 2, onTimeRate: null } }).learned).toBeNull();
    expect(alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5, learned: { p50: 22, p90: 23, samples: 9, onTimeRate: null } }).learned).toBeNull();
    expect(alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5, learned: { p50: 22, p90: 23.5, samples: 9, onTimeRate: null }, learnedToleranceDays: 3 }).learned?.delta).toBe(3.5); // 严格大于容差才记
    expect(alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5, learned: { p50: 22, p90: null, samples: 9, onTimeRate: null } }).learned).toBeNull();
    expect(alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5, learned: null }).learned).toBeNull();
    expect(alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5 }).learned).toBeNull();
  });
  it("档案缺省时比较基准是缺省加工周期；容差可为 0；P90 低于档案不记", () => {
    const r = alertDays({ defaults, bufferDays: 5, learned: { p50: 30, p90: 40.5, samples: 3, onTimeRate: 0.9 }, learnedToleranceDays: 0 });
    expect(r.days).toBe(50);
    expect(r.learned).toMatchObject({ archiveDays: 30, delta: 10.5, toleranceDays: 0 });
    expect(alertDays({ normalLeadDays: 20, defaults, bufferDays: 5, learned: { p50: 10, p90: 15, samples: 30, onTimeRate: 1 } }).learned).toBeNull();
  });
});

describe("alertDays：历史观察交期是第二条只观察来源（B4）", () => {
  const learned = { p50: 22, p90: 30, samples: 12, onTimeRate: 0.6 };
  const observedHistory = { p50: 24, p90: 26, samples: 41, onTimeRate: 0.72, firstReceiptDate: "2023-05-02", lastReceiptDate: "2024-11-18" };

  it("两条观察线并列而不合并：days 仍只由 加工+在途+缓冲 决定", () => {
    const r = alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5, learned, observedHistory, learnedToleranceDays: 3 });
    expect(r.days).toBe(32);
    expect(r.basis.filter((b) => !b.observeOnly).reduce((a, b) => a + b.value, 0)).toBe(r.days);
    expect(r.learned?.p90).toBe(30);
    expect(r.observed).toMatchObject({ archiveDays: 20, p50: 24, p90: 26, samples: 41, onTimeRate: 0.72, delta: 6, toleranceDays: 3, authority: "observation_only", observeOnly: true, applied: false });
    expect(r.observed?.firstReceiptDate).toBe("2023-05-02");
    expect(r.basis.at(-1)).toEqual({ part: "observed", value: 6, source: "observed", field: null, observeOnly: true });
    expect(r.usedDefault).toBe(false);
  });

  it("只有历史观察也照样出观察项，且阈值一模一样", () => {
    const base = alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5 });
    const withObserved = alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5, observedHistory });
    expect(withObserved.days).toBe(base.days);
    expect(withObserved.learned).toBeNull();
    expect(withObserved.observed?.samples).toBe(41);
  });

  it("样本不足 / 不过容差 / 无 P90 / 未传 → 不记观察项", () => {
    const few = { ...observedHistory, samples: 2 };
    expect(alertDays({ normalLeadDays: 20, defaults, bufferDays: 5, observedHistory: few }).observed).toBeNull();
    expect(alertDays({ normalLeadDays: 20, defaults, bufferDays: 5, observedHistory: { ...observedHistory, p90: 22 } }).observed).toBeNull();
    expect(alertDays({ normalLeadDays: 20, defaults, bufferDays: 5, observedHistory: { ...observedHistory, p90: null } }).observed).toBeNull();
    expect(alertDays({ normalLeadDays: 20, defaults, bufferDays: 5, observedHistory: null }).observed).toBeNull();
    expect(alertDays({ normalLeadDays: 20, defaults, bufferDays: 5 }).observed).toBeNull();
    // 独立的最小样本门槛：放宽后同一批样本就能出观察项
    expect(alertDays({ normalLeadDays: 20, defaults, bufferDays: 5, observedHistory: few, observedMinSamples: 2 }).observed?.samples).toBe(2);
  });

  it("leadBasisText / leadCompareText 给出三来源并列文案", () => {
    const r = alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5, learned, observedHistory });
    expect(leadCompareText(r)).toBe("档案 20 / 系统学习 30(n=12) / 历史观察 26(n=41，只观察)");
    expect(leadBasisText(r)).toBe("加工 20 + 在途 7 + 缓冲 5；档案 20 / 系统学习 30(n=12) / 历史观察 26(n=41，只观察)");
    // 无观察项命中时只剩阈值分段
    const plain = alertDays({ normalLeadDays: 20, logisticsLeadDays: 7, defaults, bufferDays: 5 });
    expect(leadCompareText(plain)).toBeNull();
    expect(leadBasisText(plain)).toBe("加工 20 + 在途 7 + 缓冲 5");
    // 缺省周期仍要标注
    expect(leadBasisText(alertDays({ defaults, bufferDays: 5 }))).toBe("加工 30(缺省) + 在途 15(缺省) + 缓冲 5");
  });
});

describe("coverStatusWithSupply（审计 #1：阈值内确认到货 → 降为 watch）", () => {
  const today = "2026-09-04";
  const arrival = { date: "2026-09-20", qty: 300, source: "po", ref: "PO-1" };
  it("在库 alert 且在库 > 0、到货日在阈值天数内 → watch + basis", () => {
    const r = coverStatusWithSupply({ status: "alert", onHand: 100, nextArrival: arrival, today, alertDaysValue: 35 });
    expect(r.status).toBe("watch");
    expect(r.downgraded).toBe(true);
    expect(r.basis).toContain("PO-1");
    expect(r.basis).toContain("16 天内");
    expect(r.basis).toContain("阈值 35 天");
  });
  it("在库 = 0 不降级（物理事实）；到货日超出阈值 / 逾期 / 无到货 / 数量 0 → 不降", () => {
    expect(coverStatusWithSupply({ status: "alert", onHand: 0, nextArrival: arrival, today, alertDaysValue: 35 })).toEqual({ status: "alert", downgraded: false, basis: null });
    expect(coverStatusWithSupply({ status: "alert", onHand: 100, nextArrival: { ...arrival, date: "2026-10-20" }, today, alertDaysValue: 35 }).status).toBe("alert");
    expect(coverStatusWithSupply({ status: "alert", onHand: 100, nextArrival: { ...arrival, date: "2026-09-01" }, today, alertDaysValue: 35 }).status).toBe("alert");
    expect(coverStatusWithSupply({ status: "alert", onHand: 100, nextArrival: null, today, alertDaysValue: 35 }).status).toBe("alert");
    expect(coverStatusWithSupply({ status: "alert", onHand: 100, nextArrival: { ...arrival, qty: 0 }, today, alertDaysValue: 35 }).status).toBe("alert");
  });
  it("边界：到货日 = today 与 = today + alertDays 都算阈值内；非 alert 状态原样返回", () => {
    expect(coverStatusWithSupply({ status: "alert", onHand: 1, nextArrival: { ...arrival, date: today }, today, alertDaysValue: 35 }).status).toBe("watch");
    expect(coverStatusWithSupply({ status: "alert", onHand: 1, nextArrival: { ...arrival, date: "2026-10-09" }, today, alertDaysValue: 35 }).status).toBe("watch");
    expect(coverStatusWithSupply({ status: "alert", onHand: 1, nextArrival: { ...arrival, date: "2026-10-10" }, today, alertDaysValue: 35 }).status).toBe("alert");
    expect(coverStatusWithSupply({ status: "watch", onHand: 1, nextArrival: arrival, today, alertDaysValue: 35 })).toEqual({ status: "watch", downgraded: false, basis: null });
    expect(coverStatusWithSupply({ status: "ok", onHand: 0, nextArrival: arrival, today, alertDaysValue: 35 }).status).toBe("ok");
  });
});
