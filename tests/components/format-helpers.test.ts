/**
 * components/format 共享显示格式：驾驶舱 OTIF 曾把 0–1 比例直接拼 "%"（0.83 → "0.83%"，审计 #1）。
 *
 * 比例→百分数**只在服务端**换算（`report/cockpit.ts` 的 `otifRatePctOf` / `ratePctNumOf`，
 * 0.83 → "83.0%" 的回归钉在 `tests/report/cockpit.test.ts`），客户端不再有第二套换算：
 * 此前 format.ts 里那对 `ratioToPct` / `pctFromRatio` 自称「所有比例→百分数只能走这里」
 * 却零生产调用，三套换算里自称权威的那套是死的（2026-09-04 清理审计 #2，已删除）。
 * 这里只钉展示层：null 保持 "—"（不可评 ≠ 0%），以及 formatPct 的两种小数位契约。
 */
import { describe, expect, it } from "vitest";
import { formatAsOf, formatCount, formatPct, formatYuan } from "@/components/format";

describe("format：百分数与金额显示", () => {
  it("source instants use Shanghai while business dates remain dates, without guessing missing timezones", () => {
    expect(formatAsOf("2026-09-07T18:23:00Z")).toBe("2026-09-08 02:23");
    expect(formatAsOf("2026-09-08T00:00:00+08:00")).toBe("2026-09-08 00:00");
    expect(formatAsOf("2026-09-07")).toBe("2026-09-07");
    for (const value of [undefined, null, "", "2026-02-30", "2026-02-30T12:00:00Z", "bad", "2026-09-07 18:23"]) expect(formatAsOf(value)).toBe("—");
  });
  it("formatPct：缺省原样拼后缀；给 digits 则补齐固定小数位（趋势层图表统一 1 位）", () => {
    expect(formatPct(12.3)).toBe("12.3%");
    expect(formatPct("83.3")).toBe("83.3%");
    expect(formatPct(null)).toBe("—");
    expect(formatPct("")).toBe("—");
    // ratePctNumOf 折回 number 后 "83.0" 会变成 83：图表列必须显式给 digits 才不掉小数位
    expect(formatPct(83, 1)).toBe("83.0%");
    expect(formatPct(83.333, 1)).toBe("83.3%");
    expect(formatPct(null, 1)).toBe("—");
    expect(formatPct("abc", 1)).toBe("—");
  });

  it("客户端不得再出现比例→百分数换算：0.83 只能由服务端换算后下发", () => {
    // 传进来的若真是 0–1 比例，展示层不会替它乘 100——这正是本层拒绝承担的职责
    expect(formatPct(0.83, 1)).toBe("0.8%");
    expect(formatPct(0.83)).toBe("0.83%");
  });

  it("formatYuan / formatCount 空值一律 —", () => {
    expect(formatYuan("12345.6")).toBe("¥1.2万");
    expect(formatYuan("999")).toBe("¥999");
    expect(formatYuan(null)).toBe("—");
    expect(formatCount("12345")).toBe("12,345");
    expect(formatCount(undefined)).toBe("—");
  });
});
