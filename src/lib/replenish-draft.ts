/**
 * 补货建议 → BH 备货申请草稿的**提交明细**（零依赖纯模块，客户端/测试同源）。
 *
 * 为什么单独成模块：确认弹窗与提交此前各写一套取数——
 * 弹窗渲染 `suggestQty ?? 0`，提交发 `suggestQty ?? heldQty`。
 * 于是「被抑制」行（suggestQty=null、heldQty=1200）在弹窗上显示 **0 件**，
 * 点确定却真的下了 1200 件的草稿：用户看到的数和实际提交的数不是一个数。
 * 现在两处都消费本函数——**要显示的就是要提交的**，结构上不可能再分叉。
 */

export interface ReplenishDraftSourceRow {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  /** 引擎建议量（decimal 字符串）；被抑制时为 null */
  suggestQty: string | null;
  /** 被抑制时保留的原始建议量（人工核实后可放行） */
  heldQty: string | null;
}

export interface ReplenishDraftItem {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  /** 实际会提交的数量（decimal 字符串） */
  qty: string;
  /** true = 该数量来自 heldQty（被抑制后人工放行），界面必须标「放行保留量」 */
  fromHeld: boolean;
}

/** 放行保留量的界面标签——弹窗与任何复用处共用同一措辞 */
export const HELD_QTY_LABEL = "放行保留量";

/**
 * 选中行 → 提交明细。`suggestQty ?? heldQty`，两者皆空的行不成单（服务端会拒 null 数量），
 * 顺序保持选中顺序（分批提交时「前 200 项」的含义才稳定）。
 */
export function replenishDraftItems(rows: readonly ReplenishDraftSourceRow[]): ReplenishDraftItem[] {
  const out: ReplenishDraftItem[] = [];
  for (const r of rows) {
    const qty = r.suggestQty ?? r.heldQty;
    if (qty == null) continue;
    out.push({
      skuId: r.skuId,
      code: r.code,
      name: r.name,
      baseUom: r.baseUom,
      qty,
      fromHeld: r.suggestQty == null,
    });
  }
  return out;
}
