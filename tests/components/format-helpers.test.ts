/**
 * components/format 共享显示格式：驾驶舱 OTIF 曾把 0–1 比例直接拼 "%"（0.83 → "0.83%"，审计 #1）。
 * 比例→百分数只能走 ratioToPct / pctFromRatio；null 保持 "—"（不可评 ≠ 0%）。
 */
import { describe, expect, it } from "vitest";
import { formatCount, formatPct, formatYuan, pctFromRatio, ratioToPct } from "@/components/format";

describe("format：比例与金额显示", () => {
  it("ratioToPct / pctFromRatio：0.8333 → 83.3%；null/非数 → —", () => {
    expect(ratioToPct(0.8333)).toBe("83.3");
    expect(ratioToPct("0.8333", 2)).toBe("83.33");
    expect(pctFromRatio(0.8333)).toBe("83.3%");
    expect(pctFromRatio(1)).toBe("100.0%");
    expect(pctFromRatio(null)).toBe("—");
    expect(pctFromRatio("abc")).toBe("—");
    // 回归：不能把比例原样拼 %
    expect(pctFromRatio(0.83)).not.toBe("0.83%");
  });

  it("formatPct：已是百分数的值原样拼后缀；formatYuan / formatCount 空值一律 —", () => {
    expect(formatPct(12.3)).toBe("12.3%");
    expect(formatPct("83.3")).toBe("83.3%");
    expect(formatPct(null)).toBe("—");
    expect(formatYuan("12345.6")).toBe("¥1.2万");
    expect(formatYuan("999")).toBe("¥999");
    expect(formatYuan(null)).toBe("—");
    expect(formatCount("12345")).toBe("12,345");
    expect(formatCount(undefined)).toBe("—");
  });
});
