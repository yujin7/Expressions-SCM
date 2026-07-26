import { describe, it, expect } from "vitest";
import { fifoAging, turnover, AGING_BUCKETS } from "@/server/rules/inventory-metrics";

/** 取某桶数量的小工具 */
const q = (r: ReturnType<typeof fifoAging>, key: string): number =>
  r.buckets.find((b) => b.key === key)?.qty ?? -1;

const TODAY = "2026-07-25";

describe("fifoAging——FIFO 回溯账龄", () => {
  it("正常分桶：倒序消耗，各桶落位 + 加权平均库龄", () => {
    // 在库 100；倒序消耗：7-20(5天,40) → 5-26(60天,30) → 2-25(150天,30，只取 30/50)
    const r = fifoAging(
      [
        { date: "2026-07-20", qty: 40 }, // 5 天 → d30
        { date: "2026-05-26", qty: 30 }, // 60 天 → d60
        { date: "2026-02-25", qty: 50 }, // 150 天 → d180（只取 30）
        { date: "2025-01-01", qty: 999 }, // 已卖光，不参与
      ],
      100,
      TODAY,
    );
    expect(q(r, "d30")).toBe(40);
    expect(q(r, "d60")).toBe(30);
    expect(q(r, "d90")).toBe(0);
    expect(q(r, "d180")).toBe(30);
    expect(q(r, "d180p")).toBe(0);
    expect(r.unknownOriginQty).toBe(0);
    // 加权 = (40×5 + 30×60 + 30×150) / 100 = (200+1800+4500)/100 = 65
    expect(r.weightedAvgAgeDays).toBeCloseTo(65, 6);
    // 桶顺序恒定，便于图表轴稳定
    expect(r.buckets.map((b) => b.key)).toEqual([...AGING_BUCKETS]);
  });

  it("在库小于最近一笔入库：只取部分，全部落最新桶", () => {
    const r = fifoAging(
      [
        { date: "2026-07-10", qty: 500 }, // 15 天
        { date: "2025-01-01", qty: 800 },
      ],
      120,
      TODAY,
    );
    expect(q(r, "d30")).toBe(120);
    expect(q(r, "d180p")).toBe(0);
    expect(r.weightedAvgAgeDays).toBeCloseTo(15, 6);
    expect(r.unknownOriginQty).toBe(0);
    // 桶合计必须等于在库
    expect(r.buckets.reduce((a, b) => a + b.qty, 0)).toBe(120);
  });

  it("在库超过历史入库合计：差额记为「来源不明」，计入最老桶且显式可见（不静默丢弃）", () => {
    const r = fifoAging([{ date: "2026-07-15", qty: 30 }], 100, TODAY); // 10 天
    expect(r.unknownOriginQty).toBe(70);
    expect(q(r, "d30")).toBe(30);
    expect(q(r, "d180p")).toBe(70); // 保守：不明来源按最老货算
    expect(r.buckets.reduce((a, b) => a + b.qty, 0)).toBe(100);
    // 加权平均库龄只按有日期来源的 30 件算，不给不明来源编年龄
    expect(r.weightedAvgAgeDays).toBeCloseTo(10, 6);
  });

  it("完全无入库记录：全部来源不明，加权库龄 = null", () => {
    const r = fifoAging([], 50, TODAY);
    expect(r.unknownOriginQty).toBe(50);
    expect(q(r, "d180p")).toBe(50);
    expect(r.weightedAvgAgeDays).toBeNull();
  });

  it("onHand<=0（含负库存）：五个空桶、avg=null", () => {
    for (const on of [0, -25]) {
      const r = fifoAging([{ date: "2026-07-01", qty: 100 }], on, TODAY);
      expect(r.buckets.map((b) => b.qty)).toEqual([0, 0, 0, 0, 0]);
      expect(r.weightedAvgAgeDays).toBeNull();
      expect(r.unknownOriginQty).toBe(0);
    }
  });

  it("桶边界：30/60/90/180 天归左桶，181 天进 >180", () => {
    const mk = (date: string) => fifoAging([{ date, qty: 10 }], 10, TODAY);
    expect(q(mk("2026-06-25"), "d30")).toBe(10); // 30 天
    expect(q(mk("2026-06-24"), "d60")).toBe(10); // 31 天
    expect(q(mk("2026-05-26"), "d60")).toBe(10); // 60 天
    expect(q(mk("2026-04-26"), "d90")).toBe(10); // 90 天
    expect(q(mk("2026-01-26"), "d180")).toBe(10); // 180 天
    expect(q(mk("2026-01-25"), "d180p")).toBe(10); // 181 天
  });

  it("未来日期不产生负库龄（脏数据兜底 → 0 天）", () => {
    const r = fifoAging([{ date: "2026-08-30", qty: 10 }], 10, TODAY);
    expect(q(r, "d30")).toBe(10);
    expect(r.weightedAvgAgeDays).toBe(0);
  });
});

describe("turnover——周转次数与 DIO", () => {
  it("年化换算：90 天窗口出库量 = 平均库存 → turns≈4.06（365/90）", () => {
    const r = turnover(500, 500, 90);
    expect(r.turns).toBeCloseTo(365 / 90, 6); // 4.0555…
    expect(r.dio).toBeCloseTo(90, 6); // 卖完这批正好 90 天
  });

  it("一般算例：窗口 90 天出库 300、平均在库 200", () => {
    const r = turnover(300, 200, 90);
    expect(r.turns).toBeCloseTo((300 / 200) * (365 / 90), 6);
    expect(r.dio).toBeCloseTo(365 / ((300 / 200) * (365 / 90)), 6);
    expect(r.dio).toBeCloseTo(60, 6);
  });

  it("0 除保护：平均在库<=0 → 双 null", () => {
    expect(turnover(100, 0, 90)).toEqual({ turns: null, dio: null });
    expect(turnover(100, -5, 90)).toEqual({ turns: null, dio: null });
  });

  it("0 除保护：窗口天数<=0 → 双 null", () => {
    expect(turnover(100, 100, 0)).toEqual({ turns: null, dio: null });
  });

  it("窗口零出库：turns=0，dio=null（不编造无穷天数）", () => {
    const r = turnover(0, 800, 90);
    expect(r.turns).toBe(0);
    expect(r.dio).toBeNull();
  });

  it("负出库量（脏数据）按 0 处理，不产生负周转", () => {
    expect(turnover(-50, 100, 90).turns).toBe(0);
  });

  it("365 天窗口 = 不做年化缩放", () => {
    expect(turnover(1200, 300, 365).turns).toBeCloseTo(4, 6);
  });
});
