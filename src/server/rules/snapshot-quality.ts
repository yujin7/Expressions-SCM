/**
 * D65 快照相邻日跳变（纯函数，唯一权威）——不把 RPA/导入数据当 100% 准确。
 *
 * 同仓相邻两批快照（prev → next）对比：行数差、ΣQty 变动 %、SKU 新增/消失数、负数行数；
 * flags：qty_jump（|ΣQty 变动| > qtyJumpPct，默认 30）、vanished（消失 SKU 占上批 SKU 数 > vanishedPct，默认 10）、
 * negatives（本批存在负数量）、empty_prev（上批为空，比例无意义只出行数）。
 * 同一 skuId 多行（批次维）先按 SKU 汇总；数量 decimal 字符串。
 */
import { type Dec, dAdd, dCmp, dDeviationPct } from "@/server/core/decimal";

export interface SnapshotRow {
  skuId: number;
  qty: Dec;
}

export interface SnapshotQualityOptions {
  qtyJumpPct?: number;
  vanishedPct?: number;
}

export type SnapshotFlag = "qty_jump" | "vanished" | "negatives" | "empty_prev";

export interface SnapshotQualityResult {
  prevRows: number;
  nextRows: number;
  rowsDelta: number;
  prevQty: string;
  nextQty: string;
  /** ΣQty 变动 %（2dp）；上批 ΣQty 为 0 → null */
  qtyDeltaPct: number | null;
  added: number;
  vanished: number;
  /** 消失 SKU 占上批 SKU 数 %（2dp）；上批无 SKU → null */
  vanishedPct: number | null;
  negatives: number;
  flags: SnapshotFlag[];
}

function aggregate(rows: SnapshotRow[]): { bySku: Map<number, string>; total: string; negatives: number } {
  const bySku = new Map<number, string>();
  let total = "0.0000";
  let negatives = 0;
  for (const r of rows ?? []) {
    if (dCmp(r.qty, 0) < 0) negatives += 1;
    bySku.set(r.skuId, dAdd(bySku.get(r.skuId) ?? "0", r.qty, 4));
    total = dAdd(total, r.qty, 4);
  }
  return { bySku, total, negatives };
}

export function compareAdjacentSnapshots(
  prev: SnapshotRow[],
  next: SnapshotRow[],
  opts: SnapshotQualityOptions = {},
): SnapshotQualityResult {
  const qtyJumpPct = opts.qtyJumpPct ?? 30;
  const vanishedPctLimit = opts.vanishedPct ?? 10;
  const a = aggregate(prev);
  const b = aggregate(next);
  let added = 0;
  let vanished = 0;
  for (const id of b.bySku.keys()) if (!a.bySku.has(id)) added += 1;
  for (const id of a.bySku.keys()) if (!b.bySku.has(id)) vanished += 1;

  const qtyDeltaPct = dCmp(a.total, 0) !== 0 ? Number(dDeviationPct(a.total, b.total)) : null;
  const vanishedPct = a.bySku.size > 0 ? Math.round((vanished / a.bySku.size) * 10000) / 100 : null;

  const flags: SnapshotFlag[] = [];
  if ((prev?.length ?? 0) === 0) flags.push("empty_prev");
  if (qtyDeltaPct != null && Math.abs(qtyDeltaPct) > qtyJumpPct) flags.push("qty_jump");
  if (vanishedPct != null && vanishedPct > vanishedPctLimit) flags.push("vanished");
  if (b.negatives > 0) flags.push("negatives");

  return {
    prevRows: prev?.length ?? 0,
    nextRows: next?.length ?? 0,
    rowsDelta: (next?.length ?? 0) - (prev?.length ?? 0),
    prevQty: a.total,
    nextQty: b.total,
    qtyDeltaPct,
    added,
    vanished,
    vanishedPct,
    negatives: b.negatives,
    flags,
  };
}
