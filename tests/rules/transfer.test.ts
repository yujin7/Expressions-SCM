/** E3-04 仓间调拨建议纯规则测试（贪心分配 / 自留缓冲 / 紧迫度优先） */
import { describe, expect, it } from "vitest";
import { planTransfers } from "@/server/rules/transfer";

const P = { targetDays: 45, alertDays: 30 };

describe("planTransfers", () => {
  it("单盈余单缺口：按缺口补到目标覆盖", () => {
    // 盈余仓：在库 1000，日均 1 → 可让出 1000 − 1×30 = 970
    // 缺口仓：在库 100，日均 10（可销 10 天）→ 需 10×45 − 100 = 350
    const lines = planTransfers({
      surplus: [{ warehouseId: 1, onHand: 1000, daily: 1 }],
      deficit: [{ warehouseId: 2, onHand: 100, daily: 10 }],
      ...P,
    });
    expect(lines).toEqual([{ fromWarehouseId: 1, toWarehouseId: 2, qty: 350 }]);
  });

  it("盈余不足：按可让出量封顶，不掏空盈余仓自留缓冲", () => {
    // 盈余仓：在库 400，日均 5 → 自留 5×30=150，可让出 250（< 缺口需求 350）
    const lines = planTransfers({
      surplus: [{ warehouseId: 1, onHand: 400, daily: 5 }],
      deficit: [{ warehouseId: 2, onHand: 100, daily: 10 }],
      ...P,
    });
    expect(lines).toEqual([{ fromWarehouseId: 1, toWarehouseId: 2, qty: 250 }]);
    // 让出后盈余仓剩 400 − 250 = 150 = 自留缓冲（alertDays×daily），未被掏空
    expect(400 - lines[0].qty).toBe(P.alertDays * 5);
  });

  it("多缺口：可销天数最短的仓先补，盈余耗尽后不再产出", () => {
    // 可让出：1000 − 2×30 = 940
    // 缺口 A（wh 3）：在库 300，日均 10 → 可销 30…（不算缺口判定，此处只测分配顺序）需 150
    // 缺口 B（wh 2）：在库 20，日均 10 → 可销 2 天（更急）需 430
    const lines = planTransfers({
      surplus: [{ warehouseId: 1, onHand: 1000, daily: 2 }],
      deficit: [
        { warehouseId: 3, onHand: 300, daily: 10 },
        { warehouseId: 2, onHand: 20, daily: 10 },
      ],
      ...P,
    });
    expect(lines.map((l) => l.toWarehouseId)).toEqual([2, 3]);
    expect(lines[0].qty).toBe(430);
    expect(lines[1].qty).toBe(150);
  });

  it("多缺口 + 盈余不足：最急的先吃满，剩余给次急，耗尽即停", () => {
    // 可让出：500 − 0 = 500（呆滞仓 daily=0 自留为 0）
    const lines = planTransfers({
      surplus: [{ warehouseId: 1, onHand: 500, daily: 0 }],
      deficit: [
        { warehouseId: 2, onHand: 0, daily: 10 }, // 可销 0 天，需 450
        { warehouseId: 3, onHand: 50, daily: 10 }, // 可销 5 天，需 400
      ],
      ...P,
    });
    expect(lines).toEqual([
      { fromWarehouseId: 1, toWarehouseId: 2, qty: 450 },
      { fromWarehouseId: 1, toWarehouseId: 3, qty: 50 },
    ]);
    expect(lines.reduce((s, l) => s + l.qty, 0)).toBe(500); // 不超发
  });

  it("多盈余：按可让出量降序先掏大仓（少开单据），跨仓凑齐一个缺口", () => {
    const lines = planTransfers({
      surplus: [
        { warehouseId: 1, onHand: 100, daily: 0 },
        { warehouseId: 4, onHand: 300, daily: 0 },
      ],
      deficit: [{ warehouseId: 2, onHand: 0, daily: 10 }], // 需 450
      ...P,
    });
    expect(lines).toEqual([
      { fromWarehouseId: 4, toWarehouseId: 2, qty: 300 },
      { fromWarehouseId: 1, toWarehouseId: 2, qty: 100 },
    ]);
  });

  it("W4 效期优先：临期批次的盈余仓先被掏空；无效期信息的仓排最后", () => {
    // 两个呆滞盈余仓：wh4 可让出 300（无效期信息）、wh1 可让出 100（最近 20 天到期）
    // 旧规则按可让出量降序会先掏 wh4；效期优先后 wh1（临期）先出，剩余再由 wh4 补齐
    const lines = planTransfers({
      surplus: [
        { warehouseId: 1, onHand: 100, daily: 0, minDaysLeft: 20 },
        { warehouseId: 4, onHand: 300, daily: 0 },
      ],
      deficit: [{ warehouseId: 2, onHand: 0, daily: 10 }], // 需 450
      ...P,
    });
    expect(lines).toEqual([
      { fromWarehouseId: 1, toWarehouseId: 2, qty: 100 },
      { fromWarehouseId: 4, toWarehouseId: 2, qty: 300 },
    ]);
    // 同为临期时仍按可让出量降序（少开单据）
    const both = planTransfers({
      surplus: [
        { warehouseId: 1, onHand: 100, daily: 0, minDaysLeft: 20 },
        { warehouseId: 4, onHand: 300, daily: 0, minDaysLeft: 10 },
      ],
      deficit: [{ warehouseId: 2, onHand: 0, daily: 10 }],
      ...P,
    });
    expect(both.map((l) => l.fromWarehouseId)).toEqual([4, 1]); // 10 天 < 20 天
    // minDaysLeft 全缺省 → 与旧行为完全一致（可让出量降序）
    const legacy = planTransfers({
      surplus: [
        { warehouseId: 1, onHand: 100, daily: 0, minDaysLeft: null },
        { warehouseId: 4, onHand: 300, daily: 0 },
      ],
      deficit: [{ warehouseId: 2, onHand: 0, daily: 10 }],
      ...P,
    });
    expect(legacy.map((l) => l.fromWarehouseId)).toEqual([4, 1]);
  });

  it("无盈余 / 无缺口 → 空结果", () => {
    expect(planTransfers({ surplus: [], deficit: [{ warehouseId: 2, onHand: 0, daily: 10 }], ...P })).toEqual([]);
    expect(planTransfers({ surplus: [{ warehouseId: 1, onHand: 999, daily: 0 }], deficit: [], ...P })).toEqual([]);
  });

  it("盈余仓在库 ≤ 自留缓冲 → 无可让出量，不产出", () => {
    const lines = planTransfers({
      surplus: [{ warehouseId: 1, onHand: 150, daily: 5 }], // 自留 150，可让出 0
      deficit: [{ warehouseId: 2, onHand: 0, daily: 10 }],
      ...P,
    });
    expect(lines).toEqual([]);
  });

  it("qty 向下取整；不足 1 个基础单位不产出", () => {
    // 可让出 0.9；缺口需求充足 → floor(0.9)=0 → 不产出
    expect(
      planTransfers({
        surplus: [{ warehouseId: 1, onHand: 0.9, daily: 0 }],
        deficit: [{ warehouseId: 2, onHand: 0, daily: 10 }],
        ...P,
      }),
    ).toEqual([]);
    // 缺口需求 4.5（日均 0.1×45），盈余充足 → 取整为 4
    const l2 = planTransfers({
      surplus: [{ warehouseId: 1, onHand: 100, daily: 0 }],
      deficit: [{ warehouseId: 2, onHand: 0, daily: 0.1 }],
      ...P,
    });
    expect(l2).toEqual([{ fromWarehouseId: 1, toWarehouseId: 2, qty: 4 }]);
  });

  it("缺口仓已达目标覆盖（need=0）不产出；同仓不自调", () => {
    expect(
      planTransfers({
        surplus: [{ warehouseId: 1, onHand: 1000, daily: 0 }],
        deficit: [{ warehouseId: 2, onHand: 500, daily: 10 }], // 500 > 10×45
        ...P,
      }),
    ).toEqual([]);
    expect(
      planTransfers({
        surplus: [{ warehouseId: 1, onHand: 1000, daily: 0 }],
        deficit: [{ warehouseId: 1, onHand: 0, daily: 10 }],
        ...P,
      }),
    ).toEqual([]);
  });
});
