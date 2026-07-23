/**
 * RED TEAM — dto.maskSensitive 脱敏收口攻击。
 * 约定：断言【正确】行为；用例失败 = 漏洞证实。
 */
import { describe, expect, it } from "vitest";
import { maskSensitive } from "@/server/core/dto";

const NO_ROLE: string[] = ["warehouse"]; // 不可见价格
const PURCH = ["purchasing"]; // 可见价格

describe("redteam/dto maskSensitive", () => {
  it("数组套数组里的敏感键要被剥离", () => {
    const data = { rows: [[{ price: "9.99", name: "x" }], [{ price: "1", deductAmount: "2" }]] };
    const masked = maskSensitive(data, NO_ROLE) as any;
    expect(masked.rows[0][0]).not.toHaveProperty("price");
    expect(masked.rows[0][0].name).toBe("x");
    expect(masked.rows[1][0]).not.toHaveProperty("price");
    expect(masked.rows[1][0]).not.toHaveProperty("deductAmount");
  });

  it("可见角色保留敏感字段", () => {
    const data = { rows: [[{ price: "9.99" }]] };
    const masked = maskSensitive(data, PURCH) as any;
    expect(masked.rows[0][0].price).toBe("9.99");
  });

  it("不可变：绝不修改入参", () => {
    const data = { price: "5", nested: { deductAmount: "3" } };
    const copy = JSON.parse(JSON.stringify(data));
    maskSensitive(data, NO_ROLE);
    expect(data).toEqual(copy);
  });

  it("[BUG?] Date 值必须原样保留（不被拆成 {} 或误删）", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    const data = { createdAt: d, price: "5" };
    const masked = maskSensitive(data, NO_ROLE) as any;
    expect(masked.createdAt instanceof Date).toBe(true);
    expect(masked.createdAt.getTime()).toBe(d.getTime());
    expect(masked).not.toHaveProperty("price");
  });

  it("[BUG?] Map 值：叶子对象按类实例保留，Map 内敏感键不会被递归剥离——特征化(潜在泄露)", () => {
    const m = new Map<string, unknown>([["price", "999"]]);
    const data = { payload: m };
    const masked = maskSensitive(data, NO_ROLE) as any;
    // deepStrip 只认 Object.prototype/null 原型；Map 原型 → 按叶子原样返回（同一引用）
    // 若 Map 中藏敏感价格，脱敏收口会漏过它 → 记录当前(危险)行为
    expect(masked.payload instanceof Map).toBe(true);
    expect(masked.payload.get("price")).toBe("999"); // 泄露：仍可读到价格
  });

  it("[SECURITY] __proto__ 键不得污染 Object.prototype", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "price": "5"}');
    maskSensitive(evil, NO_ROLE);
    expect(({} as any).polluted).toBeUndefined();
    // 冒烟：全局 Object.prototype 干净
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("[SECURITY] constructor/prototype 嵌套键在数组里也不逃逸", () => {
    const evil: any = [{ constructor: { prototype: { x: 1 } }, price: "1" }];
    const masked = maskSensitive(evil, NO_ROLE) as any;
    expect(masked[0]).not.toHaveProperty("price");
    expect(({} as any).x).toBeUndefined();
  });

  it("嵌套对象位于数组套数组内的敏感键（题面点名场景）", () => {
    const data = [[{ a: { price: "1", keep: "y" } }]];
    const masked = maskSensitive(data, NO_ROLE) as any;
    expect(masked[0][0].a).not.toHaveProperty("price");
    expect(masked[0][0].a.keep).toBe("y");
  });

  it("null / 原始值不炸", () => {
    expect(maskSensitive(null, NO_ROLE)).toBeNull();
    expect(maskSensitive(42 as any, NO_ROLE)).toBe(42);
    expect(maskSensitive("s" as any, NO_ROLE)).toBe("s");
  });
});
