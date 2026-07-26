/**
 * 采购量规整留痕测试（netreq.suggestQtyDetailed）。
 *
 * 背景：计划引擎算出"补 37 件"，但 MOQ=500、箱规=24——37 这个数根本下不了单。
 * 采购员每张单手动改数，改完的数字和引擎算的对不上，追溯时说不清是谁改的、为什么改。
 */
import { describe, expect, it } from "vitest";
import {
  describeAdjustments,
  hasBlockingIssue,
  suggestQty,
  suggestQtyDetailed,
  type LotSizingInput,
} from "@/server/rules/netreq";

/** 直接给净需求（在库/在途均为 0），聚焦规整逻辑本身 */
const net = (grossReq: string, extra: Partial<LotSizingInput> = {}): LotSizingInput => ({
  grossReq,
  onHand: "0",
  inTransit: "0",
  ...extra,
});

describe("suggestQtyDetailed — 规整顺序", () => {
  it("MOQ 与箱规同时生效：先抬 MOQ 再取箱规倍数", () => {
    const d = suggestQtyDetailed(net("37", { moq: "500", orderMultiple: "24" }));
    expect(d.qty).toBe("504.0000"); // 500 → ceil(500/24)=21 箱 → 504
    expect(d.adjustments.map((a) => a.type)).toEqual(["moq", "multiple"]);
    expect(d.overshoot).toBe("467.0000");
  });

  it("**结果同时满足 ≥MOQ 与箱规倍数**（反序运算会破坏其中之一）", () => {
    const d = suggestQtyDetailed(net("37", { moq: "500", orderMultiple: "24" }));
    const qty = Number(d.qty);
    expect(qty).toBeGreaterThanOrEqual(500);
    expect(qty % 24).toBe(0);
  });

  it("恰好整箱且已达 MOQ 时不做任何调整", () => {
    const d = suggestQtyDetailed(net("600", { moq: "500", orderMultiple: "24" }));
    expect(d.qty).toBe("600.0000");
    expect(d.overshoot).toBe("0.0000");
    expect(d.adjustments.map((a) => a.type)).toEqual(["none"]);
  });

  it("差一件也要进一箱", () => {
    expect(suggestQtyDetailed(net("601", { orderMultiple: "24" })).qty).toBe("624.0000");
  });
});

describe("suggestQtyDetailed — 不制造需求", () => {
  it("**净需求为 0 时绝不因为 MOQ 就凭空造出订单**", () => {
    const d = suggestQtyDetailed(net("0", { moq: "500", orderMultiple: "24" }));
    expect(d.qty).toBe("0.0000");
    expect(d.adjustments).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it("库存与在途已覆盖毛需求 → 不下单", () => {
    const d = suggestQtyDetailed({ grossReq: "100", onHand: "60", inTransit: "50", moq: "500" });
    expect(d.qty).toBe("0.0000");
  });
});

describe("suggestQtyDetailed — 超买显性化", () => {
  it("**MOQ 造成的超买折算成天数**（呆滞库存头号成因）", () => {
    const d = suggestQtyDetailed(net("30", { moq: "500", dailyDemand: "1" }));
    expect(d.qty).toBe("500.0000");
    expect(d.overshoot).toBe("470.0000");
    expect(d.overshootDays).toBe("470.0000");
    const w = d.warnings.find((x) => x.message.includes("额外"))!;
    expect(w.message).toContain("最小起订量");
    expect(w.message).toContain("470 天");
  });

  it("超买在阈值内时不打扰", () => {
    const d = suggestQtyDetailed(net("480", { moq: "500", dailyDemand: "1" }));
    expect(d.overshootDays).toBe("20.0000");
    expect(d.warnings).toEqual([]);
  });

  it("阈值可调", () => {
    const d = suggestQtyDetailed(net("480", { moq: "500", dailyDemand: "1", overshootWarnDays: 10 }));
    expect(d.warnings.some((w) => w.message.includes("额外 20 天"))).toBe(true);
  });

  it("未提供日均则不假装能折算", () => {
    expect(suggestQtyDetailed(net("30", { moq: "500" })).overshootDays).toBeNull();
  });
});

describe("suggestQtyDetailed — 单次上限", () => {
  it("**策略自相矛盾（上限 < MOQ）时不擅自选一边，打阻塞级警告交人工**", () => {
    const d = suggestQtyDetailed(net("37", { moq: "500", maxOrder: "100" }));
    expect(d.qty).toBe("500.0000"); // 不下调——低于 MOQ 的单根本下不出去
    expect(hasBlockingIssue(d)).toBe(true);
    expect(d.warnings.find((w) => w.level === "blocking")!.message).toContain("策略冲突");
  });

  it("正常上限下调时保持箱规倍数，并明说还缺多少", () => {
    const d = suggestQtyDetailed(net("1000", { orderMultiple: "24", maxOrder: "600" }));
    expect(d.qty).toBe("600.0000"); // floor(600/24)=25 箱
    expect(Number(d.qty) % 24).toBe(0);
    expect(d.warnings.some((w) => w.message.includes("仍缺 400"))).toBe(true);
  });

  it("上限不是箱规倍数时向下取整到倍数", () => {
    const d = suggestQtyDetailed(net("1000", { orderMultiple: "24", maxOrder: "610" }));
    expect(d.qty).toBe("600.0000"); // 610 → 600，不能超限
  });

  it("上限不足一个箱规 → 阻塞，不产出下不出去的单", () => {
    const d = suggestQtyDetailed(net("100", { orderMultiple: "50", maxOrder: "30" }));
    expect(hasBlockingIssue(d)).toBe(true);
    expect(d.warnings.find((w) => w.level === "blocking")!.message).toContain("不足一个箱规");
  });
});

describe("suggestQtyDetailed — 健壮性与留痕", () => {
  it("0 / 负数 / 脏字符串的策略字段按「未设置」处理，不当成硬约束", () => {
    const d = suggestQtyDetailed(net("37", { moq: "0", orderMultiple: "-5", maxOrder: "abc" }));
    expect(d.qty).toBe("37.0000");
    expect(hasBlockingIssue(d)).toBe(false);
  });

  it("每一步调整都留痕，from/to 可串成完整链条", () => {
    const d = suggestQtyDetailed(net("37", { moq: "500", orderMultiple: "24" }));
    expect(d.adjustments[0].from).toBe("37.0000");
    expect(d.adjustments[0].to).toBe("500.0000");
    expect(d.adjustments[1].from).toBe("500.0000");
    expect(d.adjustments[1].to).toBe("504.0000");
    expect(d.adjustments[1].note).toContain("21");
    expect(describeAdjustments(d)).toContain("→");
  });

  it("小数箱规不产生浮点毛刺", () => {
    const d = suggestQtyDetailed(net("0.3", { orderMultiple: "0.1" }));
    expect(d.qty).toBe("0.3000"); // 不是 0.30000000000000004
    expect(d.adjustments[0].type).toBe("none");
  });
});

describe("suggestQty 薄封装", () => {
  it("**与 detailed 同源**——只有一套规整规则，不会分叉", () => {
    const cases: LotSizingInput[] = [
      net("37", { moq: "500", orderMultiple: "24" }),
      net("0", { moq: "500" }),
      net("601", { orderMultiple: "24" }),
      { grossReq: "100", onHand: "60", inTransit: "50" },
    ];
    for (const c of cases) {
      expect(suggestQty(c)).toBe(suggestQtyDetailed(c).qty);
    }
  });
});
