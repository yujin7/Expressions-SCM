import { describe, expect, it } from "vitest";
import { canSeePrices, maskSensitive, requireRole } from "@/server/core/dto";

/** 构造一份含嵌套敏感字段的结算单样例（每次调用返回全新对象） */
function sampleDoc() {
  return {
    docNo: "JS202601001",
    settleAmount: "1234.56",
    supplierId: 3,
    lines: [
      {
        skuId: 1,
        qty: "10.0000",
        price: "3.50",
        feeRateCurrent: "0.80",
        deductAmount: "1.00",
        note: "首行",
      },
      {
        skuId: 2,
        qty: "5.0000",
        price: "2.00",
        nested: { settleAmount: "9.99", deductionTotal: "2.00", memo: "ok" },
      },
    ],
    summary: { amount: "100.00", manualAdj: "-1.00", count: 2 },
  };
}

describe("canSeePrices", () => {
  it("采购/PMC/财务/管理员可见", () => {
    expect(canSeePrices(["purchasing"])).toBe(true);
    expect(canSeePrices(["pmc"])).toBe(true);
    expect(canSeePrices(["finance"])).toBe(true);
    expect(canSeePrices(["admin"])).toBe(true);
    expect(canSeePrices(["ops", "finance"])).toBe(true);
  });

  it("运营/仓管/空角色不可见", () => {
    expect(canSeePrices(["ops"])).toBe(false);
    expect(canSeePrices(["warehouse"])).toBe(false);
    expect(canSeePrices(["ops", "warehouse"])).toBe(false);
    expect(canSeePrices([])).toBe(false);
  });
});

describe("maskSensitive（R9 脱敏收口）", () => {
  for (const role of ["ops", "warehouse"] as const) {
    it(`${role}：递归剥离数组/嵌套对象中的敏感字段`, () => {
      const masked = maskSensitive(sampleDoc(), [role]);

      // 顶层
      expect("settleAmount" in masked).toBe(false);
      expect(masked.docNo).toBe("JS202601001");
      expect(masked.supplierId).toBe(3);

      // 数组行
      expect("price" in masked.lines[0]).toBe(false);
      expect("feeRateCurrent" in masked.lines[0]).toBe(false);
      expect("deductAmount" in masked.lines[0]).toBe(false);
      expect(masked.lines[0].qty).toBe("10.0000");
      expect(masked.lines[0].note).toBe("首行");

      // 深层嵌套对象
      expect("price" in masked.lines[1]).toBe(false);
      expect("settleAmount" in masked.lines[1].nested!).toBe(false);
      expect("deductionTotal" in masked.lines[1].nested!).toBe(false);
      expect(masked.lines[1].nested!.memo).toBe("ok");

      // summary
      expect("amount" in masked.summary).toBe(false);
      expect("manualAdj" in masked.summary).toBe(false);
      expect(masked.summary.count).toBe(2);
    });
  }

  for (const role of ["purchasing", "finance", "admin", "pmc"] as const) {
    it(`${role}：敏感字段完整保留`, () => {
      const masked = maskSensitive(sampleDoc(), [role]);
      expect(masked).toEqual(sampleDoc());
      expect(masked.settleAmount).toBe("1234.56");
      expect(masked.lines[0].price).toBe("3.50");
      expect(masked.lines[1].nested!.settleAmount).toBe("9.99");
    });
  }

  it("不修改入参对象（深比较）", () => {
    const input = sampleDoc();
    const masked = maskSensitive(input, ["ops"]);
    expect(input).toEqual(sampleDoc()); // 原对象未被动过
    expect(masked).not.toBe(input); // 返回的是新对象
    expect(masked.lines).not.toBe(input.lines);
  });

  it("处理原始值与 null/Date 叶子", () => {
    expect(maskSensitive("abc", ["ops"])).toBe("abc");
    expect(maskSensitive(null, ["ops"])).toBeNull();
    const d = new Date("2026-01-01T00:00:00Z");
    const out = maskSensitive({ createdAt: d, price: "1.00" }, ["warehouse"]);
    expect(out.createdAt).toEqual(d);
    expect("price" in out).toBe(false);
  });
});

describe("requireRole", () => {
  it("拥有任一所需角色即通过", () => {
    expect(() => requireRole({ roles: ["purchasing"] }, "purchasing", "pmc")).not.toThrow();
  });

  it("admin 恒通过", () => {
    expect(() => requireRole({ roles: ["admin"] }, "finance")).not.toThrow();
  });

  it("无所需角色抛错", () => {
    expect(() => requireRole({ roles: ["ops"] }, "finance")).toThrow(/无权限/);
  });
});
