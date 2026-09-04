/**
 * BH 草稿确认弹窗：**看到的数就是提交的数**（`@/lib/replenish-draft`）。
 *
 * 事故形态：弹窗渲染 `suggestQty ?? 0`，提交发 `suggestQty ?? heldQty`。
 * 「被抑制」行（suggestQty=null、heldQty=1200）在弹窗上写着 **0 支**，
 * 点确定却真的下了一张 1200 支的草稿——用户按 0 做的决定，系统按 1200 执行。
 * 现在两处都消费本函数，结构上不可能再分叉；来自 heldQty 的量必须标「放行保留量」。
 */
import { describe, expect, it } from "vitest";
import { HELD_QTY_LABEL, replenishDraftItems, type ReplenishDraftSourceRow } from "@/lib/replenish-draft";

const row = (p: Partial<ReplenishDraftSourceRow> & { skuId: number; code: string }): ReplenishDraftSourceRow => ({
  name: `品${p.code}`, baseUom: "支", suggestQty: null, heldQty: null, ...p,
});

describe("replenishDraftItems：弹窗展示与提交载荷同源", () => {
  it("正常建议：取 suggestQty，不标放行", () => {
    expect(replenishDraftItems([row({ skuId: 1, code: "A", suggestQty: "300.0000" })])).toEqual([
      { skuId: 1, code: "A", name: "品A", baseUom: "支", qty: "300.0000", fromHeld: false },
    ]);
  });

  it("被抑制行：展示的是**将要提交的** heldQty，并标放行保留量（此前展示 0、提交 1200）", () => {
    const [item] = replenishDraftItems([row({ skuId: 2, code: "B", suggestQty: null, heldQty: "1200.0000" })]);
    expect(item.qty).toBe("1200.0000");
    expect(item.fromHeld).toBe(true);
    expect(HELD_QTY_LABEL).toBe("放行保留量");
  });

  it("两者皆空的行不成单（提交会发 null 被服务端拒，不该出现在弹窗里）", () => {
    expect(replenishDraftItems([row({ skuId: 3, code: "C" })])).toEqual([]);
  });

  it("顺序保持选中顺序——「只生成前 200 项」的含义才是稳定的", () => {
    const items = replenishDraftItems([
      row({ skuId: 9, code: "Z", suggestQty: "1" }),
      row({ skuId: 3, code: "C" }), // 被剔除
      row({ skuId: 1, code: "A", heldQty: "2" }),
    ]);
    expect(items.map((i) => i.skuId)).toEqual([9, 1]);
    expect(items.map((i) => i.qty)).toEqual(["1", "2"]);
  });
});
