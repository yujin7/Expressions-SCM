import { describe, it, expect } from "vitest";
import { suggestQty } from "@/server/rules/netreq";

describe("R11 净需求建议 suggestQty()", () => {
  it("净需求为负（库存+在途覆盖毛需求）→ 建议量 0.0000", () => {
    expect(
      suggestQty({ grossReq: "100", onHand: "80", inTransit: "30" }),
    ).toBe("0.0000");
  });

  it("净需求恰好为 0 → 建议量 0.0000", () => {
    expect(
      suggestQty({ grossReq: "100", onHand: "60", inTransit: "40" }),
    ).toBe("0.0000");
  });

  it("无 MOQ/倍数：建议量 = 毛需求 − 库存 − 在途", () => {
    expect(
      suggestQty({ grossReq: "1000", onHand: "150", inTransit: "38" }),
    ).toBe("812.0000");
  });

  it("MOQ 托底：净需求 300、MOQ 500 → 500", () => {
    expect(
      suggestQty({ grossReq: "300", onHand: "0", inTransit: "0", moq: "500" }),
    ).toBe("500.0000");
  });

  it("MOQ 低于净需求时不生效：净需求 700、MOQ 500 → 700", () => {
    expect(
      suggestQty({ grossReq: "700", onHand: "0", inTransit: "0", moq: "500" }),
    ).toBe("700.0000");
  });

  it("订货倍数向上取整：净需求 812、倍数 500 → 1000", () => {
    expect(
      suggestQty({
        grossReq: "812",
        onHand: "0",
        inTransit: "0",
        orderMultiple: "500",
      }),
    ).toBe("1000.0000");
  });

  it("MOQ + 倍数组合：净需求 300 → MOQ 托到 500 → 按 400 的倍数取整到 800", () => {
    expect(
      suggestQty({
        grossReq: "300",
        onHand: "0",
        inTransit: "0",
        moq: "500",
        orderMultiple: "400",
      }),
    ).toBe("800.0000");
  });

  it("恰为倍数整数倍时不多订：净需求 1000、倍数 500 → 1000", () => {
    expect(
      suggestQty({
        grossReq: "1000",
        onHand: "0",
        inTransit: "0",
        orderMultiple: "500",
      }),
    ).toBe("1000.0000");
  });

  it("MOQ/倍数为 null 时视作未设置", () => {
    expect(
      suggestQty({
        grossReq: "812",
        onHand: "0",
        inTransit: "0",
        moq: null,
        orderMultiple: null,
      }),
    ).toBe("812.0000");
  });
});
