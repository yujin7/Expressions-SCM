/**
 * E3-04 仓间调拨建议（只读报表层）——「先挪自己的货，再花钱买新的」。
 *
 * 解决的问题：既有补货/风险报表只看**全网总量**，某 SKU 在 A 仓积压 90 天、B 仓已断货时，
 * 总量口径一声不吭。本页把视角下沉到**逐仓**，把 A 的富余摊给最急的 B。
 *
 * 逐仓需求的代理口径（关键，须与 UI 说明一致）：
 * - 系统当前**没有逐仓需求信号**：sales_monthly 只到渠道维度，渠道↔仓库映射尚未建立。
 * - 故以 stock_ledger 的**逐仓出库流水**作真实需求代理：近 horizonDays 天（默认 90）
 *   每个 (warehouseId, skuId) 的 qtyDelta < 0 行合计取绝对值 = 该仓出库量。
 *   （方向判定与 report/sku-timeline.ts 一致：qtyDelta 正负即入/出库。）
 * - 该仓日均 = 出库合计 ÷ horizonDays；该仓可销天数 = 该仓在库 ÷ 该仓日均。
 * - 已知偏差（渠道↔仓库映射建立后可更精确）：出库流水含调拨出库、盘亏、委外发料等
 *   非终端销售出库，故日均是**发货强度**而非纯销量；作为「这个仓真的在发货」的证据够用。
 *
 * 盈余/缺口判定：
 * - 盈余仓：可销天数 > cover_target_days×2，或该仓近 horizonDays 无出库但有库存（呆滞）；
 * - 缺口仓：可销天数 < cover_alert_days 且该仓**有出库历史**（证明确实在此仓发货，
 *   否则新仓/零出库仓会被误判为断货而无谓调入）。
 * - 分配 = rules/transfer.ts planTransfers（贪心，含盈余仓自留缓冲）。
 *
 * 仓库范围——仅**记账仓**（accounting_mode='realtime' 且 active）：
 * - 快照仓（保税/E/云）无实时账，余额靠外部日快照、且**根本没有 stock_ledger 流水**，
 *   既算不出该仓日均也无法做实物调拨承接，故整体排除并在 summary/UI 列名说明；
 * - 委外仓（加工厂垫料，允许负余额）与在途虚拟仓不是可自由调配的自有库位，一并排除。
 *
 * W4 效期意识（2026-09）：此前本文件对批次/效期**零感知**——会把新鲜货从 A 挪到 B，而 A 仓那批 90 天到期的
 * 原地等报废。现按 (warehouseId, skuId) 关联 batch_stocks（效期参考层，与临期风险页同源）：
 * - **已过期数量绝不参与调拨**：先从该仓在库中扣除（expiredHeld 单列在行上），过期货是安全边界不是库存；
 * - 盈余仓按**最近效期优先**让出（rules/transfer 的 minDaysLeft 通道），同档再按可让出量降序；
 * - 每条建议用 rules/fefo.allocateFefo 推出这批调拨量**实际会动到哪些批次**，取其最近到期日作为
 *   行上的 minDaysLeft 与理由，expiryDriven 标记「这是一次避免报废的调拨」。
 * 口径诚实：batch_stocks 是盘点参考层（非账本），与 stock_balances 可能不同源；因此扣减已过期时以在库为上限，
 * 且行上的效期结论只作解释与排序，不改变调拨量的计算方式。
 * 盘点期间收口：batch_stocks 唯一键含 stocktake_date，逐仓只取该仓最新一期
 * （core/stock-view.latestStocktakeRows，与 quality 召回范围、风险工作台、R15 临期检查同源）。
 *
 * 只读：不写库、不开单、不落审计。DB 调拨单仍走 inventory/stock-doc 正常审批流程。
 * 无金额字段，免脱敏。
 *
 * D57（2026-09）：缺口线不再读 cover_alert_days，改消费 rules/alert-threshold（唯一阈值权威）：
 * alertDays(sku) = 加工周期 + 在途周期 + 缓冲，逐 SKU 计算并在行上给出 basis（取值来源），
 * 任一段落到全局缺省时 usedDefault=true（界面标「按默认周期」）。skuIds 过滤供预警行深链
 * `/report/transfer-suggest?skuIds=`；结果另按线路 (from,to) 分组只读汇总（TR-11，不合并成单）。
 */
import { and, eq, gt, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { coverDays, daysLeftOf, latestStocktakeRows, loadLatestStocktakeDates } from "@/server/core/stock-view";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { getNumParam } from "@/server/core/params";
import { todayShanghai } from "@/server/modules/master/common";
import { alertDays, type LeadBasis } from "@/server/rules/alert-threshold";
import { allocateFefo, type BatchLot } from "@/server/rules/fefo";
import { planTransfers } from "@/server/rules/transfer";
import { dAdd } from "@/server/core/decimal";
import { num, r1 } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 排除出建议范围的仓库类型（非自有可调配库位） */
const EXCLUDED_KINDS = ["outsource", "transit", "snapshot"] as const;

/** 临期阈值缺省（天）——与 replenish/expiry.ts 同值，逐 SKU 可由 skus.near_expiry_days 覆盖 */
const DEFAULT_NEAR_EXPIRY_DAYS = 90;

export interface TransferSuggestRow {
  skuId: number;
  code: string;
  name: string;
  baseUom: string;
  fromWarehouse: string;
  fromWarehouseId: number;
  toWarehouse: string;
  toWarehouseId: number;
  /** 建议调拨量（基础单位，向下取整） */
  qty: number;
  /** 调出仓调拨前可销天数；无出库（呆滞积压）= null */
  fromCoverBefore: number | null;
  /** 调入仓调拨前可销天数 */
  toCoverBefore: number;
  /** 调入仓收到本 SKU 全部建议量后的可销天数 */
  toCoverAfter: number;
  reason: string;
  /** D57 该 SKU 的预警阈值（加工+在途+缓冲） */
  alertDays: number;
  /** 阈值各段取值与来源；任一段 source==='default' 时行上标「按默认周期」 */
  basis: LeadBasis[];
  usedDefault: boolean;
  /* ── W4 效期 ── */
  /** 本次调拨按 FEFO 会动到的批次里最近的剩余天数；无效期数据 = null */
  minDaysLeft: number | null;
  /** 调出仓压着临期批次（minDaysLeft ≤ 该 SKU 临期阈值）——挪走即避免报废 */
  expiryDriven: boolean;
  /** 调出仓该 SKU 的已过期数量（已从可调拨量中扣除，绝不建议调拨） */
  expiredHeld: number;
  /** 本次调拨按 FEFO 命中的批次（到期日 → 数量），供界面解释 */
  fefoLots: { batchNo: string | null; expiryDate: string | null; qty: string }[];
}

export interface TransferSuggestLane {
  fromWarehouseId: number;
  toWarehouseId: number;
  fromWarehouse: string;
  toWarehouse: string;
  lineCount: number;
  skuCount: number;
  totalQty: number;
}

export interface TransferSuggestResult {
  rows: TransferSuggestRow[];
  total: number;
  /** 全部（未分页）建议按线路 (from,to) 分组的只读汇总（TR-11） */
  lanes: TransferSuggestLane[];
  summary: {
    skuCount: number;
    lineCount: number;
    totalQty: number;
    horizonDays: number;
    /** 因无实时账被排除的快照仓名称（UI 说明用） */
    excludedSnapshotWarehouses: string[];
    /** D57 阈值缺省（加工 / 在途 / 缓冲），供界面解释 */
    thresholdDefaults: { production: number; logistics: number; buffer: number };
    /** 使用了全局缺省周期的行数 */
    usedDefaultCount: number;
    /** 请求方传入的 SKU 过滤（深链） */
    skuIdsFilter: number[] | null;
    /* ── W4 效期 ── */
    /** 临期驱动的建议条数 */
    expiryDrivenCount: number;
    /** 被排除在调拨之外的已过期数量合计（基础单位） */
    expiredHeldTotal: number;
    /** 效期判定基准日（Asia/Shanghai） */
    expiryToday: string;
  };
}

export async function getTransferSuggestions(
  query: { q?: string; page?: number; pageSize?: number; horizonDays?: number; skuIds?: number[] },
  dbArg?: AnyDb,
): Promise<TransferSuggestResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();
  const horizonDays = Math.min(365, Math.max(7, Math.floor(query.horizonDays ?? 90)));
  const skuIdsFilter = query.skuIds && query.skuIds.length > 0
    ? [...new Set(query.skuIds.filter((id) => Number.isInteger(id) && id > 0))]
    : null;
  const [targetDays, defaultProduction, defaultLogistics, bufferDays] = await Promise.all([
    getNumParam("cover_target_days", 45, dbArg),
    getNumParam("default_production_lead_days", 30, dbArg),
    getNumParam("default_logistics_lead_days", 15, dbArg),
    getNumParam("alert_buffer_days", 5, dbArg),
  ]);
  const thresholdDefaults = { production: defaultProduction, logistics: defaultLogistics, buffer: bufferDays };
  const today = todayShanghai();
  /** 盈余线 = 目标覆盖 ×2（压了两个补货周期的货才算「多到该挪」） */
  const surplusDays = targetDays * 2;

  const empty: TransferSuggestResult = {
    rows: [],
    total: 0,
    lanes: [],
    summary: {
      skuCount: 0, lineCount: 0, totalQty: 0, horizonDays, excludedSnapshotWarehouses: [],
      thresholdDefaults, usedDefaultCount: 0, skuIdsFilter,
      expiryDrivenCount: 0, expiredHeldTotal: 0, expiryToday: today,
    },
  };

  /* ── 仓库范围：记账仓（realtime + active，排除委外/在途/快照）── */
  const whRows: { id: number; name: string; kind: string; accountingMode: string }[] = await db
    .select({
      id: schema.warehouses.id,
      name: schema.warehouses.name,
      kind: schema.warehouses.kind,
      accountingMode: schema.warehouses.accountingMode,
    })
    .from(schema.warehouses)
    .where(eq(schema.warehouses.active, true));
  const excludedSnapshotWarehouses = whRows
    .filter((w) => w.accountingMode === "snapshot" || w.kind === "snapshot")
    .map((w) => w.name);
  const ledgerWh = whRows.filter(
    (w) => w.accountingMode === "realtime" && !(EXCLUDED_KINDS as readonly string[]).includes(w.kind),
  );
  const whNameById = new Map(ledgerWh.map((w) => [w.id, w.name]));
  const whIds = ledgerWh.map((w) => w.id);
  if (whIds.length < 2) return { ...empty, summary: { ...empty.summary, excludedSnapshotWarehouses } };

  /* ── 逐仓在库：Σ stock_balances（含批次汇总）── */
  const sb = schema.stockBalances;
  const balConds = [inArray(sb.warehouseId, whIds)];
  if (skuIdsFilter) balConds.push(inArray(sb.skuId, skuIdsFilter));
  const balRows: { skuId: number; warehouseId: number; qty: string | null }[] = await db
    .select({ skuId: sb.skuId, warehouseId: sb.warehouseId, qty: sql<string | null>`sum(${sb.qty})` })
    .from(sb)
    .where(and(...balConds))
    .groupBy(sb.skuId, sb.warehouseId);

  /* ── 逐仓出库：近 horizonDays 天 qtyDelta<0 合计（取绝对值）── */
  const sl = schema.stockLedger;
  const since = new Date(Date.now() - horizonDays * 86_400_000);
  const outConds = [inArray(sl.warehouseId, whIds), lt(sl.qtyDelta, "0"), gte(sl.occurredAt, since)];
  if (skuIdsFilter) outConds.push(inArray(sl.skuId, skuIdsFilter));
  const outRows: { skuId: number; warehouseId: number; out: string | null }[] = await db
    .select({ skuId: sl.skuId, warehouseId: sl.warehouseId, out: sql<string | null>`sum(-${sl.qtyDelta})` })
    .from(sl)
    .where(and(...outConds))
    .groupBy(sl.skuId, sl.warehouseId);

  /* ── W4 批次效期（batch_stocks，效期参考层；与临期风险页同源）──
     **逐仓只取最新盘点期**（core/stock-view.latestStocktakeRows）：batch_stocks 唯一键含 stocktake_date，
     同一批实物在每期盘点各有一行。此前把多期直加，已过期量按期数翻倍后 ≥ 该仓在库，
     `n.expired = min(expired, onHand)` 就把整仓可调拨量清成 0——一个仓的富余凭空消失。 */
  const bs = schema.batchStocks;
  const lotConds = [inArray(bs.warehouseId, whIds), gt(bs.qty, "0"), isNotNull(bs.expiryDate)];
  if (skuIdsFilter) lotConds.push(inArray(bs.skuId, skuIdsFilter));
  const lotRowsAllPeriods: { skuId: number; warehouseId: number; stocktakeDate: string; batchNo: string | null; expiryDate: string; qty: string }[] = await db
    .select({ skuId: bs.skuId, warehouseId: bs.warehouseId, stocktakeDate: bs.stocktakeDate, batchNo: bs.batchNo, expiryDate: bs.expiryDate, qty: bs.qty })
    .from(bs)
    .where(and(...lotConds));
  // 本查询可以是 SKU 子集（`?skuIds=` 深链）：最新盘点期必须整表取，否则该仓最新期里没有这批 SKU 时会退到旧期
  const lotRows = latestStocktakeRows(lotRowsAllPeriods, await loadLatestStocktakeDates(db));
  /** (skuId|warehouseId) → 批次（含已过期，allocateFefo 会按 today 排除并计数） */
  const lotsByKey = new Map<string, BatchLot[]>();
  const expiredByKey = new Map<string, number>();
  const minDaysLeftByKey = new Map<string, number>();
  let lotSeq = 0;
  for (const r of lotRows) {
    const key = `${r.skuId}|${r.warehouseId}`;
    lotSeq += 1;
    // batch_stocks 无稳定批次主键语义（同 SKU 同仓同期仍可多行）；用行序号作 FEFO 稳定排序键
    (lotsByKey.get(key) ?? lotsByKey.set(key, []).get(key)!).push({ batchId: lotSeq, batchNo: r.batchNo ?? "", expiryDate: r.expiryDate, qty: r.qty });
    const daysLeft = daysLeftOf(today, r.expiryDate);
    if (daysLeft <= 0) expiredByKey.set(key, (expiredByKey.get(key) ?? 0) + num(r.qty));
    else minDaysLeftByKey.set(key, Math.min(minDaysLeftByKey.get(key) ?? daysLeft, daysLeft));
  }

  /* ── 装配逐 SKU 的逐仓视图 ── */
  type Node = { warehouseId: number; onHand: number; daily: number; minDaysLeft: number | null; expired: number };
  const bySku = new Map<number, Map<number, Node>>();
  const touch = (skuId: number, warehouseId: number): Node => {
    let m = bySku.get(skuId);
    if (!m) { m = new Map(); bySku.set(skuId, m); }
    let n = m.get(warehouseId);
    if (!n) { n = { warehouseId, onHand: 0, daily: 0, minDaysLeft: null, expired: 0 }; m.set(warehouseId, n); }
    return n;
  };
  for (const r of balRows) touch(r.skuId, r.warehouseId).onHand = num(r.qty);
  for (const r of outRows) touch(r.skuId, r.warehouseId).daily = num(r.out) / horizonDays;
  /* 已过期数量从可调拨在库中扣除（以在库为上限——批次参考层与账本可能不同源，宁可少扣不可扣成负数）；
     未过期批次的最短剩余天数进节点，供 rules/transfer 做「最近效期先让出」排序。 */
  for (const [key, expired] of expiredByKey) {
    const [skuIdStr, whIdStr] = key.split("|");
    const n = bySku.get(Number(skuIdStr))?.get(Number(whIdStr));
    if (!n) continue; // 该仓无账面余额（参考层有行）——不凭批次参考层凭空造在库
    n.expired = Math.min(expired, n.onHand);
    n.onHand = Math.max(0, n.onHand - n.expired);
  }
  for (const [key, days] of minDaysLeftByKey) {
    const [skuIdStr, whIdStr] = key.split("|");
    const n = bySku.get(Number(skuIdStr))?.get(Number(whIdStr));
    if (n) n.minDaysLeft = days;
  }
  if (bySku.size === 0) return { ...empty, summary: { ...empty.summary, excludedSnapshotWarehouses } };

  /* ── SKU 主档（active）+ D57 周期参数（sku_params）── */
  const skuRows: { id: number; code: string; name: string; baseUom: string; nearExpiryDays: number | null }[] = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name, baseUom: schema.skus.baseUom, nearExpiryDays: schema.skus.nearExpiryDays })
    .from(schema.skus)
    .where(and(eq(schema.skus.active, true), inArray(schema.skus.id, [...bySku.keys()])));
  const paramRows: { skuId: number; normalLeadDays: number | null; logisticsLeadDays: number | null; purchaseLeadDays: number | null }[] =
    skuRows.length === 0 ? [] : await db
      .select({
        skuId: schema.skuParams.skuId,
        normalLeadDays: schema.skuParams.normalLeadDays,
        logisticsLeadDays: schema.skuParams.logisticsLeadDays,
        purchaseLeadDays: schema.skuParams.purchaseLeadDays,
      })
      .from(schema.skuParams)
      .where(inArray(schema.skuParams.skuId, skuRows.map((s) => s.id)));
  const paramBySku = new Map(paramRows.map((p) => [p.skuId, p]));

  /* ── 逐 SKU 识别盈余/缺口 → 贪心分配 ── */
  const all: TransferSuggestRow[] = [];
  for (const sku of skuRows) {
    const sp = paramBySku.get(sku.id);
    const threshold = alertDays({
      normalLeadDays: sp?.normalLeadDays,
      logisticsLeadDays: sp?.logisticsLeadDays,
      purchaseLeadDays: sp?.purchaseLeadDays,
      defaults: { production: defaultProduction, logistics: defaultLogistics },
      bufferDays,
    });
    const alertDaysValue = threshold.days;
    const nodes = [...(bySku.get(sku.id)?.values() ?? [])];
    const surplus: Node[] = [];
    const deficit: Node[] = [];
    for (const n of nodes) {
      const cover = coverDays(n.onHand, n.daily);
      if (cover == null) {
        if (n.onHand > 0) surplus.push(n); // 无出库但有库存 = 呆滞积压，整仓可让
      } else if (cover > surplusDays) {
        surplus.push(n);
      } else if (cover < alertDaysValue) {
        deficit.push(n); // daily>0 即「有出库历史」，证明确实在此仓发货
      }
    }
    if (surplus.length === 0 || deficit.length === 0) continue;
    const lines = planTransfers({
      surplus: surplus.map((n) => ({ warehouseId: n.warehouseId, onHand: n.onHand, daily: n.daily, minDaysLeft: n.minDaysLeft })),
      deficit: deficit.map((n) => ({ warehouseId: n.warehouseId, onHand: n.onHand, daily: n.daily })),
      targetDays,
      alertDays: alertDaysValue,
    });
    if (lines.length === 0) continue;

    const nodeById = new Map(nodes.map((n) => [n.warehouseId, n]));
    // 调入仓「补货后可销」按该 SKU 全部建议量累计（同一缺口仓可能由多个盈余仓凑齐）
    const inQtyByWh = new Map<number, number>();
    for (const l of lines) inQtyByWh.set(l.toWarehouseId, (inQtyByWh.get(l.toWarehouseId) ?? 0) + l.qty);

    const nearExpiryDays = sku.nearExpiryDays ?? DEFAULT_NEAR_EXPIRY_DAYS;
    for (const l of lines) {
      const from = nodeById.get(l.fromWarehouseId)!;
      const to = nodeById.get(l.toWarehouseId)!;
      const fromCover = from.daily > 0 ? from.onHand / from.daily : null;
      const toCoverBefore = to.daily > 0 ? to.onHand / to.daily : 0;
      const toCoverAfter = to.daily > 0 ? (to.onHand + (inQtyByWh.get(l.toWarehouseId) ?? 0)) / to.daily : 0;
      const fromDesc =
        fromCover == null
          ? `调出仓近 ${horizonDays} 天无出库、在库 ${r1(from.onHand)}（呆滞积压）`
          : `调出仓可销 ${r1(fromCover)} 天（>盈余线 ${surplusDays} 天）`;
      /* W4：这批量按先到期先出会动到哪些批次——已过期批次由 allocateFefo 按 today 排除，绝不进建议。
         批次参考层可能覆盖不全（allocated < qty），此时只解释已覆盖的部分，不假装知道其余批次的效期。 */
      const lots = lotsByKey.get(`${sku.id}|${l.fromWarehouseId}`) ?? [];
      const fefo = lots.length ? allocateFefo(lots, String(l.qty), today) : null;
      const fefoLots = (fefo?.allocations ?? []).map((a) => ({ batchNo: a.batchNo || null, expiryDate: a.expiryDate, qty: a.qty }));
      const allocatedDaysLeft = fefoLots.length && fefoLots[0].expiryDate ? daysLeftOf(today, fefoLots[0].expiryDate) : null;
      const minDaysLeft = allocatedDaysLeft ?? from.minDaysLeft;
      const expiryDriven = minDaysLeft != null && minDaysLeft <= nearExpiryDays;
      const expiryDesc = expiryDriven
        ? `；调出仓压着临期批次（最近 ${minDaysLeft} 天到期 ≤ 临期阈值 ${nearExpiryDays} 天），先挪先卖以免报废`
        : minDaysLeft != null
          ? `；调出仓最近效期剩 ${minDaysLeft} 天`
          : "";
      const expiredDesc = from.expired > 0
        ? `；调出仓另有 ${r1(from.expired)} 已过期，不计入可调拨量`
        : "";
      all.push({
        skuId: sku.id,
        code: sku.code,
        name: sku.name,
        baseUom: sku.baseUom,
        fromWarehouse: whNameById.get(l.fromWarehouseId) ?? `#${l.fromWarehouseId}`,
        fromWarehouseId: l.fromWarehouseId,
        toWarehouse: whNameById.get(l.toWarehouseId) ?? `#${l.toWarehouseId}`,
        toWarehouseId: l.toWarehouseId,
        qty: l.qty,
        fromCoverBefore: fromCover == null ? null : r1(fromCover),
        toCoverBefore: r1(toCoverBefore),
        toCoverAfter: r1(toCoverAfter),
        reason: `${fromDesc}；调入仓可销 ${r1(toCoverBefore)} 天（<预警阈值 ${alertDaysValue} 天${threshold.usedDefault ? "，按默认周期" : ""}），补至约 ${r1(toCoverAfter)} 天${expiryDesc}${expiredDesc}`,
        alertDays: alertDaysValue,
        basis: threshold.basis,
        usedDefault: threshold.usedDefault,
        minDaysLeft,
        expiryDriven,
        expiredHeld: r1(from.expired),
        fefoLots,
      });
    }
  }

  /* ── 搜索/排序（缺口最急优先）/分页 ── */
  let filtered = all;
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  filtered.sort((a, b) => a.toCoverBefore - b.toCoverBefore || b.qty - a.qty || a.code.localeCompare(b.code));

  /* ── 按线路 (from,to) 分组只读汇总（TR-11：零散建议合并视角，不成单）── */
  const laneMap = new Map<string, TransferSuggestLane & { skus: Set<number> }>();
  for (const r of filtered) {
    const k = `${r.fromWarehouseId}>${r.toWarehouseId}`;
    const l = laneMap.get(k) ?? {
      fromWarehouseId: r.fromWarehouseId, toWarehouseId: r.toWarehouseId,
      fromWarehouse: r.fromWarehouse, toWarehouse: r.toWarehouse,
      lineCount: 0, skuCount: 0, totalQty: 0, skus: new Set<number>(),
    };
    l.lineCount += 1;
    l.totalQty = Math.round((l.totalQty + r.qty) * 10000) / 10000;
    l.skus.add(r.skuId);
    laneMap.set(k, l);
  }
  const lanes: TransferSuggestLane[] = [...laneMap.values()]
    .map(({ skus, ...l }) => ({ ...l, skuCount: skus.size }))
    .sort((a, b) => b.lineCount - a.lineCount || b.totalQty - a.totalQty);

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    lanes,
    summary: {
      skuCount: new Set(filtered.map((r) => r.skuId)).size,
      lineCount: filtered.length,
      totalQty: Math.round(filtered.reduce((s, r) => s + r.qty, 0) * 10000) / 10000,
      horizonDays,
      excludedSnapshotWarehouses,
      thresholdDefaults,
      usedDefaultCount: filtered.filter((r) => r.usedDefault).length,
      skuIdsFilter,
      expiryDrivenCount: filtered.filter((r) => r.expiryDriven).length,
      /* expiredHeld 是 (SKU, 调出仓) 的一个事实，却复制在该仓的**每一条**建议行上：
         一个调出仓供三个缺口仓，直接求和就把同一批过期货算三遍。先按 (skuId, fromWarehouseId) 去重再合计。 */
      expiredHeldTotal: Number(
        [...new Map(filtered.map((r) => [`${r.skuId}|${r.fromWarehouseId}`, r.expiredHeld])).values()]
          .reduce((acc, v) => dAdd(acc, String(v), 4), "0"),
      ),
      expiryToday: today,
    },
  };
}
