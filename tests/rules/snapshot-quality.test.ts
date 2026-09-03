/** D65 快照相邻日跳变（rules/snapshot-quality.ts） */
import { describe, expect, it } from "vitest";
import { compareAdjacentSnapshots } from "@/server/rules/snapshot-quality";

describe("compareAdjacentSnapshots", () => {
  it("行数差、ΣQty 变动 %、新增/消失、负数与 flags", () => {
    const prev = [
      { skuId: 1, qty: "100" }, { skuId: 2, qty: "200" }, { skuId: 3, qty: "300" }, { skuId: 4, qty: "400" },
      { skuId: 5, qty: "500" }, { skuId: 6, qty: "600" }, { skuId: 7, qty: "700" }, { skuId: 8, qty: "800" },
      { skuId: 9, qty: "900" }, { skuId: 10, qty: "1000" },
    ]; // Σ5500，10 SKU
    const next = [
      { skuId: 1, qty: "100" }, { skuId: 2, qty: "200" }, { skuId: 3, qty: "300" }, { skuId: 4, qty: "400" },
      { skuId: 5, qty: "500" }, { skuId: 6, qty: "600" }, { skuId: 7, qty: "700" }, { skuId: 8, qty: "-5" },
      { skuId: 11, qty: "50" }, // 新增；9、10 消失（20%）
    ]; // Σ2845
    const r = compareAdjacentSnapshots(prev, next);
    expect(r.rowsDelta).toBe(-1);
    expect(r.prevQty).toBe("5500.0000");
    expect(r.nextQty).toBe("2845.0000");
    expect(r.qtyDeltaPct).toBe(-48.27);
    expect(r.added).toBe(1);
    expect(r.vanished).toBe(2);
    expect(r.vanishedPct).toBe(20);
    expect(r.negatives).toBe(1);
    expect(r.flags).toEqual(["qty_jump", "vanished", "negatives"]);
  });
  it("同 SKU 多行（批次维）先汇总；阈值内不出 flag", () => {
    const prev = [{ skuId: 1, qty: "60" }, { skuId: 1, qty: "40" }, { skuId: 2, qty: "100" }];
    const next = [{ skuId: 1, qty: "110" }, { skuId: 2, qty: "95" }];
    const r = compareAdjacentSnapshots(prev, next, { qtyJumpPct: 30, vanishedPct: 10 });
    expect(r.rowsDelta).toBe(-1);
    expect(r.added).toBe(0);
    expect(r.vanished).toBe(0);
    expect(r.qtyDeltaPct).toBe(2.5);
    expect(r.flags).toEqual([]);
  });
  it("上批为空：比例为 null，只标 empty_prev", () => {
    const r = compareAdjacentSnapshots([], [{ skuId: 1, qty: 10 }]);
    expect(r.qtyDeltaPct).toBeNull();
    expect(r.vanishedPct).toBeNull();
    expect(r.added).toBe(1);
    expect(r.flags).toEqual(["empty_prev"]);
  });
  it("参数化阈值生效", () => {
    const prev = [{ skuId: 1, qty: 100 }, { skuId: 2, qty: 100 }];
    const next = [{ skuId: 1, qty: 150 }];
    expect(compareAdjacentSnapshots(prev, next, { qtyJumpPct: 30, vanishedPct: 60 }).flags).toEqual([]);
    expect(compareAdjacentSnapshots(prev, next, { qtyJumpPct: 20, vanishedPct: 40 }).flags).toEqual(["qty_jump", "vanished"]);
  });
});
