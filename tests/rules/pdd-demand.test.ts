import { describe, expect, it } from "vitest";

import { isPddDemandEligible } from "@/server/rules/pdd-demand";

describe("拼多多需求订单资格口径", () => {
  it("接受有支付时间或明确已支付状态", () => {
    expect(isPddDemandEligible({ paymentTime: "2026-09-01 10:00:00", orderStatus: "待付款" })).toBe(true);
    expect(isPddDemandEligible({ paymentTime: "", orderStatus: "待发货" })).toBe(true);
    expect(isPddDemandEligible({ orderStatus: "已发货，待收货" })).toBe(true);
  });

  it("拒绝未付款、已取消和退款成功", () => {
    expect(isPddDemandEligible({ paymentTime: "", orderStatus: "待付款" })).toBe(false);
    expect(isPddDemandEligible({ paymentTime: "2026-09-01 10:00:00", orderStatus: "已取消" })).toBe(false);
    expect(isPddDemandEligible({ paymentTime: "2026-09-01 10:00:00", orderStatus: "已发货", afterSalesStatus: "退款成功" })).toBe(false);
  });
});
