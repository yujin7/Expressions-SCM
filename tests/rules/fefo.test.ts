/** E2-12 FEFO 出库批次分配纯规则测试（数量走 decimal 字符串） */
import { describe, expect, it } from "vitest";
import { allocateFefo, type BatchLot } from "@/server/rules/fefo";

const lot = (batchId: number, expiryDate: string | null, qty: string): BatchLot => ({
  batchId,
  batchNo: `L${batchId}`,
  expiryDate,
  qty,
});

describe("allocateFefo", () => {
  it("先到期先出：按到期日升序消耗，不按入库顺序", () => {
    // 故意让 batchId 顺序与到期日顺序相反——验证排的是效期不是入库序
    const lots = [lot(1, "2027-12-01", "100"), lot(2, "2026-09-01", "100"), lot(3, "2027-01-01", "100")];
    const r = allocateFefo(lots, "150");
    expect(r.allocations.map((a) => a.batchId)).toEqual([2, 3]); // 最早到期的 2，再 3
    expect(r.allocations[0].qty).toBe("100.0000");
    expect(r.allocations[1].qty).toBe("50.0000");
    expect(r.shortBy).toBe("0.0000");
    expect(r.allocated).toBe("150.0000");
  });

  it("无效期批次排在最后，但绝不丢弃（否则成死库存）", () => {
    const lots = [lot(1, null, "100"), lot(2, "2026-12-01", "30")];
    const r = allocateFefo(lots, "80");
    expect(r.allocations.map((a) => a.batchId)).toEqual([2, 1]); // 有效期的先出
    expect(r.allocations[1].qty).toBe("50.0000"); // 无效期批次仍被取用
    expect(r.note).toContain("无效期批次");
  });

  it("同到期日按 batchId 升序——结果稳定可复现", () => {
    const lots = [lot(9, "2026-10-01", "10"), lot(3, "2026-10-01", "10"), lot(7, "2026-10-01", "10")];
    const r = allocateFefo(lots, "25");
    expect(r.allocations.map((a) => a.batchId)).toEqual([3, 7, 9]);
  });

  it("库存不足：给出部分分配 + 明确缺口，绝不静默截断", () => {
    const lots = [lot(1, "2026-10-01", "40"), lot(2, "2026-11-01", "30")];
    const r = allocateFefo(lots, "100");
    expect(r.allocated).toBe("70.0000");
    expect(r.shortBy).toBe("30.0000");
    expect(r.allocations.length).toBe(2);
    expect(r.note).toContain("尚缺 30");
  });

  it("**小数量不产生浮点毛刺**（分配结果会成为过账数量）", () => {
    const lots = [lot(1, "2026-10-01", "0.1"), lot(2, "2026-11-01", "0.2")];
    const r = allocateFefo(lots, "0.3");
    expect(r.allocated).toBe("0.3000"); // 不是 0.30000000000000004
    expect(r.shortBy).toBe("0.0000");
    expect(r.allocations.map((a) => a.qty)).toEqual(["0.1000", "0.2000"]);
  });

  it("已过期批次仍参与分配但被标注（引擎不擅自拦截业务）", () => {
    const lots = [lot(1, "2026-01-01", "50"), lot(2, "2027-01-01", "50")];
    const r = allocateFefo(lots, "30", "2026-07-25");
    expect(r.allocations[0].batchId).toBe(1); // 过期的最早到期，仍先出
    expect(r.expiredLots).toBe(1);
    expect(r.note).toContain("已过期");
  });

  it("不传 today 时不做过期标注", () => {
    const r = allocateFefo([lot(1, "2020-01-01", "50")], "10");
    expect(r.expiredLots).toBe(0);
    expect(r.note).not.toContain("已过期");
  });

  it("需求为 0 或负 → 空分配、无缺口", () => {
    expect(allocateFefo([lot(1, "2026-10-01", "50")], "0").allocations).toEqual([]);
    expect(allocateFefo([lot(1, "2026-10-01", "50")], "-5").shortBy).toBe("0.0000");
  });

  it("忽略 qty<=0 的批次行（已发完的批次不应出现在分配里）", () => {
    const lots = [lot(1, "2026-09-01", "0"), lot(2, "2026-10-01", "-5"), lot(3, "2026-11-01", "20")];
    const r = allocateFefo(lots, "15");
    expect(r.allocations.map((a) => a.batchId)).toEqual([3]);
  });

  it("**非法 decimal 字符串不抛错，按不可用跳过**（脏数据不得炸掉整次分配）", () => {
    const lots = [lot(1, "2026-09-01", "abc"), lot(2, "2026-10-01", "20")];
    let r!: ReturnType<typeof allocateFefo>;
    expect(() => { r = allocateFefo(lots, "15"); }).not.toThrow();
    expect(r.allocations.map((a) => a.batchId)).toEqual([2]);
    expect(() => allocateFefo(lots, "not-a-number")).not.toThrow();
    expect(allocateFefo(lots, "not-a-number").allocations).toEqual([]);
  });

  it("无可用批次 → 全额缺口（调用方须回落到无批次库存或报缺）", () => {
    const r = allocateFefo([], "100");
    expect(r.allocations).toEqual([]);
    expect(r.shortBy).toBe("100.0000");
    expect(r.allocated).toBe("0.0000");
  });

  it("单批次刚好满足：不产生多余分配行", () => {
    const r = allocateFefo([lot(1, "2026-10-01", "100"), lot(2, "2026-11-01", "100")], "100");
    expect(r.allocations.length).toBe(1);
    expect(r.shortBy).toBe("0.0000");
  });

  it("不修改入参数组（纯函数不得有副作用）", () => {
    const lots = [lot(2, "2026-11-01", "10"), lot(1, "2026-10-01", "10")];
    const snapshot = lots.map((l) => l.batchId);
    allocateFefo(lots, "15");
    expect(lots.map((l) => l.batchId)).toEqual(snapshot); // 原数组顺序未被排序改动
  });
});
