/**
 * RED TEAM — decimal.ts 定点工具边界攻击。
 * 约定：每个用例断言【正确】行为；用例失败 = 漏洞证实（CONFIRMED）。
 */
import { describe, expect, it } from "vitest";
import {
  dAdd, dCeilToMultiple, dDiv, dMoney, dMul, dNeg, dQty,
} from "@/server/core/decimal";

describe("redteam/decimal", () => {
  // ── 1. dCeilToMultiple 负数输入 ───────────────────────────────
  it("[BUG?] dCeilToMultiple(-4, 2)：-4 已是 2 的整数倍，应原样返回 -4", () => {
    expect(dCeilToMultiple("-4", "2")).toBe("-4.0000");
  });

  it("[BUG?] dCeilToMultiple(-3, 2)：ceil(-3/2)=-1 → -2（不应返回 0）", () => {
    expect(dCeilToMultiple("-3", "2")).toBe("-2.0000");
  });

  it("[BUG?] dCeilToMultiple(-5, 2)：ceil(-5/2)=-2 → -4", () => {
    expect(dCeilToMultiple("-5", "2")).toBe("-4.0000");
  });

  it("对照：正数精确倍数不变（4,2 → 4）", () => {
    expect(dCeilToMultiple("4", "2")).toBe("4.0000");
    expect(dCeilToMultiple("5", "2")).toBe("6.0000");
  });

  // ── 2. dDiv / dMul 截断 vs 半进位（注释声称"半进位舍入"） ──────
  it("[BUG?] dDiv(2,3,scale=6) 声称半进位应得 0.666667（实际截断为 0.666666）", () => {
    expect(dDiv("2", "3", 6)).toBe("0.666667");
  });

  it("[BUG?] dMul(0.111111, 0.111111, scale=6) 半进位应得 0.012346（实际截断 0.012345）", () => {
    // 0.111111^2 = 0.012345654321 → 半进位到 6 位 = 0.012346
    expect(dMul("0.111111", "0.111111", 6)).toBe("0.012346");
  });

  it("dDiv 负数与正数对称（同为截断，量值一致）", () => {
    const p = dDiv("2", "3", 6);
    const n = dDiv("-2", "3", 6);
    expect(n).toBe("-" + p);
  });

  // ── 3. 负数半进位对称性（fromUnits 用 abs+drop/2） ─────────────
  it("dMoney(±0.005) 对称：0.005→0.01, -0.005→-0.01（half away from zero）", () => {
    expect(dMoney("0.005")).toBe("0.01");
    expect(dMoney("-0.005")).toBe("-0.01");
  });

  it("toUnits 第 7 位半进位对称：±0.0000005 → ±0.000001", () => {
    expect(dQty(dAdd("0.0000005", "0", 6))).toBe("0.0000");
    expect(dAdd("0.0000005", "0", 6)).toBe("0.000001");
    expect(dAdd("-0.0000005", "0", 6)).toBe("-0.000001");
  });

  it("toUnits 超 scale 尾数只看首位：0.00000049999 → 0（<0.5ulp 舍去，正确）", () => {
    expect(dAdd("0.00000049999", "0", 6)).toBe("0.000000");
  });

  it("负零规范化：dNeg(0)、-0.0000004 舍入到 0 均无负号", () => {
    expect(dNeg("0", 2)).toBe("0.00");
    expect(dAdd("-0.0000004", "0", 6)).toBe("0.000000");
    expect(dMoney("-0.001")).toBe("0.00");
  });

  // ── 4. number 输入的科学计数法陷阱 ──────────────────────────────
  it("[BUG?] number 输入 1e-7 / 1e21 会变成科学计数法字符串——应可用或明确拒绝（当前 throw invalid decimal）", () => {
    // 特征化：两者都抛错（拒绝而非算错）——若抛错则视为"安全拒绝"，本用例断言不静默算错
    expect(() => dAdd(0.0000001, "1")).toThrow(/invalid decimal/);
    expect(() => dAdd(1e21, "1")).toThrow(/invalid decimal/);
  });

  it("[REFUTED overflow] 大数不溢出：14 位整数 + 精度链（BigInt 精确）", () => {
    expect(dAdd("99999999999999", "0.0001", 4)).toBe("99999999999999.0001");
    // 真值 9999999.9999^2 = 99999999998000.00000001 → 落 scale4 = ...8000.0000（无溢出，正确）
    expect(dMul("9999999.9999", "9999999.9999", 4)).toBe("99999999998000.0000");
  });

  // ── 5. 双重舍入链（scale6 中间 → scale2 落库） ────────────────
  it("[INFO→已修] 双重舍入：m4 修复后 dMul 全程半进位，0.00499999 经 scale6→分 为 0.01（两步舍入固有特性，记录在案）", () => {
    // 真值 0.004999995 → scale6 半进位 0.005000 → 到分 0.01；单步直舍则为 0.00。
    // 采纳理由：统一半进位契约（CLAUDE.md）优先于单步最优；金额链路误差 ≤1 分且方向一致。
    expect(dMul("0.0099999", "0.4999999", 2)).toBe("0.01");
  });
});
