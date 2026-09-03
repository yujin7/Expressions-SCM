/** D57 库存预警阈值（rules/alert-threshold.ts） */
import { describe, expect, it } from "vitest";
import { alertDays, coverStatus } from "@/server/rules/alert-threshold";

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
