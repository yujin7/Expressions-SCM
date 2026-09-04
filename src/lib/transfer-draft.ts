/**
 * 调拨建议 → DB 调拨单草稿的**载荷装配**（TR-11 交接）——零依赖纯模块，客户端/服务端/测试同源。
 *
 * 为什么单独成模块：`/report/transfer-suggest` 是只读报表层（`report/transfer-suggest.ts`
 * 明写「不写库、不开单、不落审计」），装配逻辑放那儿会把写路径拖进报表；放客户端又没法直测。
 * 这里只做纯装配，**不写库**：调用方仍走既有 `POST /api/inventory/stock-doc`
 * → `inventory/stock-doc.createStockDoc`（草稿态，审批/过账一律走原流程）。
 *
 * 口径纪律：
 * - 一张 DB 单只有一个 (源仓, 转入仓)——建议行必须按**线路**分组，一条线路一张草稿；
 *   跨线路合单会把 `stock_doc_lines.to_warehouse_id` 混装，过账时把货发错仓。
 * - 建议量已是基础单位整数（`rules/transfer.planTransfers` 的 `Math.floor`），
 *   这里只做 `qty <= 0` 剔除与字符串化，不做任何再取整/再分配——建议怎么算的，草稿就是多少。
 * - 同一线路里同一 SKU 只会出现一次（建议行键是 (sku, from, to)），仍做去重合并防御。
 */

import type { TransferType } from "./transfer-types";

/** 装配所需的建议行字段（`TransferSuggestRow` 的子集，故意不 import 服务端类型） */
export interface TransferDraftSourceRow {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  fromWarehouseId: number;
  fromWarehouse: string;
  toWarehouseId: number;
  toWarehouse: string;
  qty: number;
}

export interface TransferDraftLine {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  /** 基础单位数量（decimal 字符串，scale=4——与 stockDocLineSchema 同契约） */
  qty: string;
}

export interface TransferDraftLane {
  /** `${fromWarehouseId}>${toWarehouseId}` */
  key: string;
  fromWarehouseId: number;
  fromWarehouse: string;
  toWarehouseId: number;
  toWarehouse: string;
  lines: TransferDraftLine[];
  /** 该线路合计（基础单位，整数建议量求和，不跨单位混装展示） */
  totalQty: number;
}

/** 基础单位量 → decimal(14,4) 字符串（建议量恒为整数，此处只做格式化，不改数值） */
function qtyStr(n: number): string {
  return n.toFixed(4);
}

/**
 * 把选中的建议行按线路 (from,to) 分组成「一张草稿的内容」。
 * 排序：条数多的线路在前（与服务端 `lanes` 汇总同序），线路内按 SKU 编码。
 */
export function groupTransferDraftLanes(rows: readonly TransferDraftSourceRow[]): TransferDraftLane[] {
  const byLane = new Map<string, TransferDraftLane & { bySku: Map<number, TransferDraftLine> }>();
  for (const r of rows) {
    if (!(r.qty > 0)) continue; // 0/负/NaN 的建议不成单
    const key = `${r.fromWarehouseId}>${r.toWarehouseId}`;
    const lane = byLane.get(key) ?? {
      key,
      fromWarehouseId: r.fromWarehouseId,
      fromWarehouse: r.fromWarehouse,
      toWarehouseId: r.toWarehouseId,
      toWarehouse: r.toWarehouse,
      lines: [],
      totalQty: 0,
      bySku: new Map<number, TransferDraftLine>(),
    };
    const prev = lane.bySku.get(r.skuId);
    if (prev) {
      prev.qty = qtyStr(Number(prev.qty) + r.qty); // 防御：同线路同 SKU 不应重复，重复则合并
    } else {
      lane.bySku.set(r.skuId, { skuId: r.skuId, code: r.code, name: r.name, baseUom: r.baseUom, qty: qtyStr(r.qty) });
    }
    lane.totalQty += r.qty;
    byLane.set(key, lane);
  }
  return [...byLane.values()]
    .map(({ bySku, ...lane }) => ({
      ...lane,
      lines: [...bySku.values()].sort((a, b) => a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => b.lines.length - a.lines.length || b.totalQty - a.totalQty || a.key.localeCompare(b.key));
}

/** `createStockDocSchema`（subtype=transfer）的入参形状——这里只装配，不校验（服务端 zod 是唯一权威） */
export interface TransferDraftPayload {
  subtype: "transfer";
  warehouseId: number;
  toWarehouseId: number;
  transferType: TransferType;
  reason?: string;
  remark: string;
  lines: { skuId: number; qty: string }[];
}

/** 草稿备注上限（`createStockDocSchema.remark` max 500，留足余量） */
const REMARK_MAX = 200;

/**
 * 线路 → 建单载荷。备注默认写明出处（「来源：调拨建议页」+ 条数），
 * 让单据本身留下「这张 DB 是从建议来的」这条线索——审计 `after` 只有 docNo/subtype/lineCount。
 */
export function transferDraftPayload(
  lane: TransferDraftLane,
  opts: { transferType: TransferType; reason?: string; remark?: string },
): TransferDraftPayload {
  const provenance = `来源：调拨建议页（先挪后买）${lane.lines.length} 条建议`;
  const extra = (opts.remark ?? "").trim();
  const remark = (extra ? `${provenance}；${extra}` : provenance).slice(0, REMARK_MAX);
  const reason = (opts.reason ?? "").trim();
  return {
    subtype: "transfer",
    warehouseId: lane.fromWarehouseId,
    toWarehouseId: lane.toWarehouseId,
    transferType: opts.transferType,
    ...(reason ? { reason } : {}),
    remark,
    lines: lane.lines.map((l) => ({ skuId: l.skuId, qty: l.qty })),
  };
}
