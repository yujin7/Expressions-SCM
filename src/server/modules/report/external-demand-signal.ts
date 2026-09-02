/**
 * 简道云外部需求信号。
 *
 * 这是一个只读、观察口径的数据产品：从每个契约最新一次成功的不可变 staging 批次
 * 计算天猫支付件数、成功退款件数和净需求信号。它绝不写 sales_monthly、库存台账、
 * 销速或补货建议；身份覆盖与数值质量不达标时，限制会随结果一起返回。
 */
import { sql, type SQL } from "drizzle-orm";

import { dAdd, dCmp, dDiv, dMul, dNeg, dQty, dSub } from "@/server/core/decimal";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

const STREAM = {
  crosswalk: "tmall-sku-crosswalk-observation",
  sales: "tmall-sku-sales-observation",
  refunds: "tmall-sku-refund-observation",
} as const;
const READ_MODEL_CACHE_KEY = "jiandaoyun-external-demand/v5";

export interface ExternalDemandDailyRow {
  date: string;
  sourceRows: number;
  validPaidRows: number;
  invalidSalesRows: number;
  invalidRefundRows: number;
  paidQty: number;
  refundQty: number;
  netQty: number;
  mappedPaidQty: number;
  mappedRefundQty: number;
  mappedNetQty: number;
}

export interface RollingDemandWindow {
  startDate: string | null;
  endDate: string | null;
  observedDays: number;
  requiredDays: 7;
  paidQty: number;
  refundQty: number;
  netQty: number;
  mappedPaidQty: number;
  mappedRefundQty: number;
  mappedNetQty: number;
  refundRatePct: number | null;
  mappedPaidCoveragePct: number | null;
}

export interface RollingDemandBrief {
  state: "ready" | "insufficient";
  gate: string;
  anchorDate: string | null;
  current: RollingDemandWindow;
  previous: RollingDemandWindow;
  change: {
    paidQtyPct: number | null;
    netQtyPct: number | null;
    refundRateDeltaPp: number | null;
    mappedPaidCoverageDeltaPp: number | null;
  };
  movement: {
    netDemand: "up" | "down" | "flat" | "unknown";
    refundRate: "up" | "down" | "flat" | "unknown";
    mappedPaidCoverage: "up" | "down" | "flat" | "unknown";
  };
}

export interface RefundDriverObservation {
  date: string;
  shopName: string;
  platformSkuId: string;
  barcode: string | null;
  skuId: number | null;
  exceptionId: number | null;
  exceptionStatus: "open" | "resolved" | "ignored" | null;
  productName: string | null;
  skuName: string | null;
  paidQty: string;
  refundQty: string;
}

export interface RefundDriverBreakdown {
  state: "ready" | "insufficient";
  authority: "observation_only";
  grain: "店铺 × 天猫平台 SKU × 双自然日窗口";
  gate: string;
  movement: "up" | "down" | "flat" | "unknown";
  totals: {
    currentRefundQty: number;
    previousRefundQty: number;
    deltaRefundQty: number | null;
    changePct: number | null;
    movementPoolQty: number | null;
  };
  eligibleDrivers: number;
  identityCoverage: {
    mappedDrivers: number;
    unmappedDrivers: number;
    mappedMovementPoolQty: number;
    mappedMovementPoolPct: number | null;
  };
  byShop: {
    shopName: string;
    currentRefundQty: number;
    previousRefundQty: number;
    netDeltaRefundQty: number;
    movementPoolQty: number;
    movementPoolSharePct: number | null;
    eligibleDrivers: number;
    unmappedDrivers: number;
  }[];
  topContributors: {
    shopName: string;
    platformSkuId: string;
    barcode: string | null;
    skuId: number | null;
    exceptionId: number | null;
    exceptionStatus: "open" | "resolved" | "ignored" | null;
    productName: string | null;
    skuName: string | null;
    currentPaidQty: number;
    currentRefundQty: number;
    currentRefundRatePct: number | null;
    previousPaidQty: number;
    previousRefundQty: number;
    previousRefundRatePct: number | null;
    deltaRefundQty: number;
    refundRateDeltaPp: number | null;
    movementPoolSharePct: number | null;
  }[];
}

export interface ExternalDemandSignal {
  state: "ready" | "insufficient";
  authority: "observation_only";
  gate: string | null;
  source: "JIANDAOYUN";
  platform: "天猫";
  sourceAsOf: string | null;
  crosswalkAsOf: string | null;
  daily: ExternalDemandDailyRow[];
  decisionBrief: RollingDemandBrief;
  refundDrivers: RefundDriverBreakdown;
  totals: {
    paidQty: number;
    refundQty: number;
    netQty: number;
    mappedPaidQty: number;
    mappedRefundQty: number;
    mappedNetQty: number;
  };
  coverage: {
    salesRows: number;
    mappedSalesRows: number;
    rowPct: number | null;
    platformIdentities: number;
    mappedIdentities: number;
    identityPct: number | null;
    paidQtyPct: number | null;
  };
  quality: {
    invalidSalesRows: number;
    invalidRefundRows: number;
    conflictingCrosswalks: number;
  };
  fulfillment: {
    state: "ready" | "insufficient";
    authority: "comparison_only";
    jstSourceAsOf: string | null;
    grain: "业务日 × SCM SKU（跨店铺、跨仓汇总）";
    gate: string;
    totals: {
      jdyMappedNetQty: number;
      jstMappedOutboundQty: number;
      comparableDemandQty: number;
      comparableOutboundQty: number;
      gapQty: number | null;
      absoluteGapQty: number | null;
    };
    coverage: {
      jdyMappedSkuDays: number;
      jstMappedSkuDays: number;
      comparableSkuDays: number;
      jdyComparablePct: number | null;
      jstComparablePct: number | null;
    };
    daily: {
      date: string;
      mappedNetDemandQty: number;
      jstOutboundQty: number;
      comparableDemandQty: number;
      comparableOutboundQty: number;
      gapQty: number | null;
      onlyJdySkuDays: number;
      onlyJstSkuDays: number;
    }[];
    topGaps: {
      date: string;
      skuId: number;
      skuCode: string | null;
      mappedNetDemandQty: number;
      jstOutboundQty: number;
      gapQty: number;
      absoluteGapQty: number;
    }[];
  };
  topUnmapped: {
    shopName: string;
    platformSkuId: string;
    barcode: string | null;
    exceptionId: number | null;
    exceptionStatus: "open" | "resolved" | "ignored" | null;
    productName: string | null;
    skuName: string | null;
    paidQty: number;
    refundQty: number;
    netQty: number;
  }[];
  limitations: string[];
}

interface LatestBatch {
  importJobId: number;
  sourceAsOf: string | null;
}

interface ExternalDemandBatches {
  crosswalkBatch: LatestBatch | null;
  salesBatch: LatestBatch | null;
  refundBatch: LatestBatch | null;
  jstOutboundBatch: LatestBatch | null;
  directIdentifierVersion: string;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function intValue(value: unknown): number {
  return Math.trunc(numberValue(value));
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const NUMERIC_TEXT = /^-?[0-9]+(?:[.][0-9]+)?$/;
const ISO_DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

type Qty = string;
const ZERO_QTY: Qty = "0.0000";

function numericQty(value: unknown): Qty | null {
  const text = textValue(value);
  if (!NUMERIC_TEXT.test(text)) return null;
  return dQty(text);
}

function qtyAdd(left: Qty, right: Qty): Qty {
  return dAdd(left, right, 4);
}

function qtySub(left: Qty, right: Qty): Qty {
  return dSub(left, right, 4);
}

function qtyNumber(value: Qty): number {
  return Number(dQty(value));
}

function qtyPercent(numerator: Qty, denominator: Qty): number | null {
  if (dCmp(denominator, 0) <= 0) return null;
  return Number(dMul(dDiv(numerator, denominator, 6), 100, 1));
}

function qtyChangePct(current: Qty, previous: Qty): number | null {
  if (dCmp(previous, 0) <= 0) return null;
  return Number(dMul(dDiv(dSub(current, previous, 6), previous, 6), 100, 1));
}

function rateDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Number(dSub(String(current), String(previous), 1));
}

function shiftIsoDay(day: string, offset: number): string | null {
  if (!ISO_DAY.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function emptyRollingWindow(): RollingDemandWindow {
  return {
    startDate: null,
    endDate: null,
    observedDays: 0,
    requiredDays: 7,
    paidQty: 0,
    refundQty: 0,
    netQty: 0,
    mappedPaidQty: 0,
    mappedRefundQty: 0,
    mappedNetQty: 0,
    refundRatePct: null,
    mappedPaidCoveragePct: null,
  };
}

function emptyRollingDemandBrief(gate: string): RollingDemandBrief {
  return {
    state: "insufficient",
    gate,
    anchorDate: null,
    current: emptyRollingWindow(),
    previous: emptyRollingWindow(),
    change: {
      paidQtyPct: null,
      netQtyPct: null,
      refundRateDeltaPp: null,
      mappedPaidCoverageDeltaPp: null,
    },
    movement: {
      netDemand: "unknown",
      refundRate: "unknown",
      mappedPaidCoverage: "unknown",
    },
  };
}

interface RollingWindowCalculation {
  result: RollingDemandWindow;
  paidQty: Qty;
  netQty: Qty;
}

function calculateRollingWindow(
  rows: readonly ExternalDemandDailyRow[],
  startDate: string,
  endDate: string,
): RollingWindowCalculation {
  const selected = rows.filter((row) =>
    row.date >= startDate && row.date <= endDate && row.validPaidRows > 0);
  let paidQty = ZERO_QTY;
  let refundQty = ZERO_QTY;
  let mappedPaidQty = ZERO_QTY;
  let mappedRefundQty = ZERO_QTY;
  for (const row of selected) {
    paidQty = qtyAdd(paidQty, dQty(String(row.paidQty)));
    refundQty = qtyAdd(refundQty, dQty(String(row.refundQty)));
    mappedPaidQty = qtyAdd(mappedPaidQty, dQty(String(row.mappedPaidQty)));
    mappedRefundQty = qtyAdd(mappedRefundQty, dQty(String(row.mappedRefundQty)));
  }
  const netQty = qtySub(paidQty, refundQty);
  const mappedNetQty = qtySub(mappedPaidQty, mappedRefundQty);
  return {
    paidQty,
    netQty,
    result: {
      startDate,
      endDate,
      observedDays: new Set(selected.map((row) => row.date)).size,
      requiredDays: 7,
      paidQty: qtyNumber(paidQty),
      refundQty: qtyNumber(refundQty),
      netQty: qtyNumber(netQty),
      mappedPaidQty: qtyNumber(mappedPaidQty),
      mappedRefundQty: qtyNumber(mappedRefundQty),
      mappedNetQty: qtyNumber(mappedNetQty),
      refundRatePct: qtyPercent(refundQty, paidQty),
      mappedPaidCoveragePct: qtyPercent(mappedPaidQty, paidQty),
    },
  };
}

function metricMovement(
  current: string | number | null,
  previous: string | number | null,
): "up" | "down" | "flat" | "unknown" {
  if (current === null || previous === null) return "unknown";
  const comparison = dCmp(String(current), String(previous));
  return comparison > 0 ? "up" : comparison < 0 ? "down" : "flat";
}

/**
 * 以最新来源日期为锚点比较两个完整的自然日窗口。缺任意一天就关闭变化判断，
 * 避免把“未到达/无记录”误解释为 0 销量。
 */
export function buildRollingDemandBrief(
  rows: readonly ExternalDemandDailyRow[],
): RollingDemandBrief {
  const anchorDate = [...new Set(rows.map((row) => row.date).filter((day) => ISO_DAY.test(day)))]
    .sort((left, right) => left.localeCompare(right)).at(-1) ?? null;
  if (!anchorDate) return emptyRollingDemandBrief("没有有效来源日期，滚动需求判断保持关闭。");

  const currentStart = shiftIsoDay(anchorDate, -6);
  const previousStart = shiftIsoDay(anchorDate, -13);
  const previousEnd = shiftIsoDay(anchorDate, -7);
  if (!currentStart || !previousStart || !previousEnd) {
    return emptyRollingDemandBrief("来源日期无法建立两个自然日窗口，滚动需求判断保持关闭。");
  }

  const current = calculateRollingWindow(rows, currentStart, anchorDate);
  const previous = calculateRollingWindow(rows, previousStart, previousEnd);
  const complete = current.result.observedDays === 7 && previous.result.observedDays === 7;
  if (!complete) {
    return {
      ...emptyRollingDemandBrief(
        `最近窗口覆盖 ${current.result.observedDays}/7 天，前一窗口覆盖 ${previous.result.observedDays}/7 天；缺失日不补零，变化判断保持关闭。`,
      ),
      anchorDate,
      current: current.result,
      previous: previous.result,
    };
  }

  const refundRateDeltaPp = rateDelta(
    current.result.refundRatePct,
    previous.result.refundRatePct,
  );
  const mappedPaidCoverageDeltaPp = rateDelta(
    current.result.mappedPaidCoveragePct,
    previous.result.mappedPaidCoveragePct,
  );
  return {
    state: "ready",
    gate: "两个自然日窗口均完整覆盖 7 天；仅用于需求观察，未通过控制总量、业务 UAT 与放行审批前不得驱动正式事实或自动决策。",
    anchorDate,
    current: current.result,
    previous: previous.result,
    change: {
      paidQtyPct: qtyChangePct(current.paidQty, previous.paidQty),
      netQtyPct: qtyChangePct(current.netQty, previous.netQty),
      refundRateDeltaPp,
      mappedPaidCoverageDeltaPp,
    },
    movement: {
      netDemand: metricMovement(current.netQty, previous.netQty),
      refundRate: metricMovement(current.result.refundRatePct, previous.result.refundRatePct),
      mappedPaidCoverage: metricMovement(
        current.result.mappedPaidCoveragePct,
        previous.result.mappedPaidCoveragePct,
      ),
    },
  };
}

function emptyRefundDriverBreakdown(gate: string): RefundDriverBreakdown {
  return {
    state: "insufficient",
    authority: "observation_only",
    grain: "店铺 × 天猫平台 SKU × 双自然日窗口",
    gate,
    movement: "unknown",
    totals: {
      currentRefundQty: 0,
      previousRefundQty: 0,
      deltaRefundQty: null,
      changePct: null,
      movementPoolQty: null,
    },
    eligibleDrivers: 0,
    identityCoverage: {
      mappedDrivers: 0,
      unmappedDrivers: 0,
      mappedMovementPoolQty: 0,
      mappedMovementPoolPct: null,
    },
    byShop: [],
    topContributors: [],
  };
}

interface RefundDriverAccumulator {
  shopName: string;
  platformSkuId: string;
  barcode: string | null;
  skuId: number | null;
  exceptionId: number | null;
  exceptionStatus: RefundDriverObservation["exceptionStatus"];
  productName: string | null;
  skuName: string | null;
  currentPaidQty: Qty;
  currentRefundQty: Qty;
  previousPaidQty: Qty;
  previousRefundQty: Qty;
}

function absoluteQty(value: Qty): Qty {
  return dCmp(value, 0) < 0 ? dNeg(value, 4) : dQty(value);
}

/**
 * 将已通过双窗口门禁的退款变化拆到店铺 × 平台 SKU。贡献占比只在同方向变化池内计算，
 * 因而不会把正负抵销后的净变化误称为单个 SKU 的“责任占比”。
 */
export function buildRefundDriverBreakdown(
  observations: readonly RefundDriverObservation[],
  brief: RollingDemandBrief,
): RefundDriverBreakdown {
  const { current, previous } = brief;
  if (brief.state !== "ready"
    || !current.startDate || !current.endDate
    || !previous.startDate || !previous.endDate) {
    return emptyRefundDriverBreakdown(
      `双窗口需求简报未开放；${brief.gate}`,
    );
  }

  const drivers = new Map<string, RefundDriverAccumulator>();
  let currentRefundQty = ZERO_QTY;
  let previousRefundQty = ZERO_QTY;
  for (const observation of observations) {
    const inCurrent = observation.date >= current.startDate && observation.date <= current.endDate;
    const inPrevious = observation.date >= previous.startDate && observation.date <= previous.endDate;
    if (!inCurrent && !inPrevious) continue;
    const key = grainKey(observation.shopName, observation.platformSkuId);
    const row = drivers.get(key) ?? {
      shopName: observation.shopName,
      platformSkuId: observation.platformSkuId,
      barcode: observation.barcode,
      skuId: observation.skuId,
      exceptionId: observation.exceptionId,
      exceptionStatus: observation.exceptionStatus,
      productName: null,
      skuName: null,
      currentPaidQty: ZERO_QTY,
      currentRefundQty: ZERO_QTY,
      previousPaidQty: ZERO_QTY,
      previousRefundQty: ZERO_QTY,
    };
    row.productName = maxText(row.productName, observation.productName);
    row.skuName = maxText(row.skuName, observation.skuName);
    if (inCurrent) {
      row.currentPaidQty = qtyAdd(row.currentPaidQty, observation.paidQty);
      row.currentRefundQty = qtyAdd(row.currentRefundQty, observation.refundQty);
      currentRefundQty = qtyAdd(currentRefundQty, observation.refundQty);
    } else {
      row.previousPaidQty = qtyAdd(row.previousPaidQty, observation.paidQty);
      row.previousRefundQty = qtyAdd(row.previousRefundQty, observation.refundQty);
      previousRefundQty = qtyAdd(previousRefundQty, observation.refundQty);
    }
    drivers.set(key, row);
  }

  if (dCmp(currentRefundQty, String(current.refundQty)) !== 0
    || dCmp(previousRefundQty, String(previous.refundQty)) !== 0) {
    return {
      ...emptyRefundDriverBreakdown(
        "退款驱动明细与日级窗口控制总量不一致；保持关闭，禁止展示归因结果。",
      ),
      totals: {
        currentRefundQty: qtyNumber(currentRefundQty),
        previousRefundQty: qtyNumber(previousRefundQty),
        deltaRefundQty: null,
        changePct: null,
        movementPoolQty: null,
      },
    };
  }

  const deltaRefundQty = qtySub(currentRefundQty, previousRefundQty);
  const movement = metricMovement(currentRefundQty, previousRefundQty);
  const candidates = [...drivers.values()].map((row) => ({
    ...row,
    deltaQty: qtySub(row.currentRefundQty, row.previousRefundQty),
  })).filter((row) => {
    const comparison = dCmp(row.deltaQty, 0);
    if (movement === "up") return comparison > 0;
    if (movement === "down") return comparison < 0;
    return comparison !== 0;
  });
  candidates.sort((left, right) => {
    if (movement === "up") return dCmp(right.deltaQty, left.deltaQty);
    if (movement === "down") return dCmp(left.deltaQty, right.deltaQty);
    return dCmp(absoluteQty(right.deltaQty), absoluteQty(left.deltaQty));
  });
  let movementPoolQty = ZERO_QTY;
  let mappedMovementPoolQty = ZERO_QTY;
  for (const row of candidates) {
    movementPoolQty = qtyAdd(movementPoolQty, absoluteQty(row.deltaQty));
    if (row.skuId !== null) {
      mappedMovementPoolQty = qtyAdd(mappedMovementPoolQty, absoluteQty(row.deltaQty));
    }
  }

  type ShopAccumulator = {
    shopName: string;
    currentRefundQty: Qty;
    previousRefundQty: Qty;
    movementPoolQty: Qty;
    eligibleDrivers: number;
    unmappedDrivers: number;
  };
  const shops = new Map<string, ShopAccumulator>();
  for (const row of drivers.values()) {
    const shop = shops.get(row.shopName) ?? {
      shopName: row.shopName,
      currentRefundQty: ZERO_QTY,
      previousRefundQty: ZERO_QTY,
      movementPoolQty: ZERO_QTY,
      eligibleDrivers: 0,
      unmappedDrivers: 0,
    };
    shop.currentRefundQty = qtyAdd(shop.currentRefundQty, row.currentRefundQty);
    shop.previousRefundQty = qtyAdd(shop.previousRefundQty, row.previousRefundQty);
    shops.set(row.shopName, shop);
  }
  for (const row of candidates) {
    const shop = shops.get(row.shopName)!;
    shop.movementPoolQty = qtyAdd(shop.movementPoolQty, absoluteQty(row.deltaQty));
    shop.eligibleDrivers++;
    if (row.skuId === null) shop.unmappedDrivers++;
  }
  const byShop = [...shops.values()].filter((shop) => shop.eligibleDrivers > 0)
    .sort((left, right) => dCmp(right.movementPoolQty, left.movementPoolQty)
      || left.shopName.localeCompare(right.shopName, "zh-CN"))
    .map((shop) => ({
      shopName: shop.shopName,
      currentRefundQty: qtyNumber(shop.currentRefundQty),
      previousRefundQty: qtyNumber(shop.previousRefundQty),
      netDeltaRefundQty: qtyNumber(qtySub(shop.currentRefundQty, shop.previousRefundQty)),
      movementPoolQty: qtyNumber(shop.movementPoolQty),
      movementPoolSharePct: qtyPercent(shop.movementPoolQty, movementPoolQty),
      eligibleDrivers: shop.eligibleDrivers,
      unmappedDrivers: shop.unmappedDrivers,
    }));

  const topContributors = candidates.slice(0, 20).map((row) => {
    const currentRate = qtyPercent(row.currentRefundQty, row.currentPaidQty);
    const previousRate = qtyPercent(row.previousRefundQty, row.previousPaidQty);
    return {
      shopName: row.shopName,
      platformSkuId: row.platformSkuId,
      barcode: row.barcode,
      skuId: row.skuId,
      exceptionId: row.exceptionId,
      exceptionStatus: row.exceptionStatus,
      productName: row.productName,
      skuName: row.skuName,
      currentPaidQty: qtyNumber(row.currentPaidQty),
      currentRefundQty: qtyNumber(row.currentRefundQty),
      currentRefundRatePct: currentRate,
      previousPaidQty: qtyNumber(row.previousPaidQty),
      previousRefundQty: qtyNumber(row.previousRefundQty),
      previousRefundRatePct: previousRate,
      deltaRefundQty: qtyNumber(row.deltaQty),
      refundRateDeltaPp: rateDelta(currentRate, previousRate),
      movementPoolSharePct: qtyPercent(absoluteQty(row.deltaQty), movementPoolQty),
    };
  });
  const movementLabel = movement === "up"
    ? "退款增加"
    : movement === "down"
      ? "退款减少"
      : "退款总量持平";
  return {
    state: "ready",
    authority: "observation_only",
    grain: "店铺 × 天猫平台 SKU × 双自然日窗口",
    gate: `${movementLabel}；仅呈现同方向变化贡献，不将正负抵销后的净变化自动归责。跨期退款、退货入库和平台口径仍需业务 UAT。`,
    movement,
    totals: {
      currentRefundQty: qtyNumber(currentRefundQty),
      previousRefundQty: qtyNumber(previousRefundQty),
      deltaRefundQty: qtyNumber(deltaRefundQty),
      changePct: qtyChangePct(currentRefundQty, previousRefundQty),
      movementPoolQty: qtyNumber(movementPoolQty),
    },
    eligibleDrivers: candidates.length,
    identityCoverage: {
      mappedDrivers: candidates.filter((row) => row.skuId !== null).length,
      unmappedDrivers: candidates.filter((row) => row.skuId === null).length,
      mappedMovementPoolQty: qtyNumber(mappedMovementPoolQty),
      mappedMovementPoolPct: qtyPercent(mappedMovementPoolQty, movementPoolQty),
    },
    byShop,
    topContributors,
  };
}

function maxText(current: string | null, candidate: unknown): string | null {
  const value = textValue(candidate);
  if (!value) return current;
  return current === null || value.localeCompare(current) > 0 ? value : current;
}

function grainKey(...parts: string[]): string {
  return parts.join("\u0000");
}

async function latestBatch(
  db: ReadDb,
  connector: "jdy" | "jst",
  stream: string,
): Promise<LatestBatch | null> {
  const result = await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = ${connector} AND ir.stream = ${stream}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
      AND coalesce(ir.request_scope->>'qualityBlocked', 'false') = 'false'
      AND (${connector} <> 'jdy' OR coalesce(ir.request_scope->>'emptySource', 'false') = 'false')
    ORDER BY ir.id DESC
    LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(result);
  const importJobId = intValue(row?.import_job_id);
  return importJobId > 0
    ? { importJobId, sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of) }
    : null;
}

async function latestExternalDemandBatches(db: ReadDb): Promise<ExternalDemandBatches> {
  const [crosswalkBatch, salesBatch, refundBatch, jstOutboundBatch, directResult] = await Promise.all([
    latestBatch(db, "jdy", STREAM.crosswalk),
    latestBatch(db, "jdy", STREAM.sales),
    latestBatch(db, "jdy", STREAM.refunds),
    latestBatch(db, "jst", "outbound-sales-daily"),
    db.execute(sql`
      SELECT count(*)::int AS n,
             coalesce(max(id), 0)::int AS max_id,
             coalesce(max(updated_at), 'epoch')::text AS updated
      FROM sku_identifiers
      WHERE kind = 'external' AND scope = 'JIANDAOYUN:TMALL'
    `),
  ]);
  const [direct] = resultRows<Record<string, unknown>>(directResult);
  const directIdentifierVersion = `direct:${intValue(direct?.n)}:${intValue(direct?.max_id)}:${String(direct?.updated ?? "")}`;
  return { crosswalkBatch, salesBatch, refundBatch, jstOutboundBatch, directIdentifierVersion };
}

function readModelBinding(batches: ExternalDemandBatches): string | null {
  if (!batches.crosswalkBatch || !batches.salesBatch || !batches.refundBatch) return null;
  return [
    `crosswalk:${batches.crosswalkBatch.importJobId}`,
    `sales:${batches.salesBatch.importJobId}`,
    `refunds:${batches.refundBatch.importJobId}`,
    `jst:${batches.jstOutboundBatch?.importJobId ?? "none"}`,
    batches.directIdentifierVersion,
  ].join("|");
}

function missingBatchSignal(batches: ExternalDemandBatches): ExternalDemandSignal {
  const missing = [
    !batches.crosswalkBatch ? "天猫 SKU 对照" : null,
    !batches.salesBatch ? "天猫日销量" : null,
    !batches.refundBatch ? "天猫退款" : null,
  ].filter((label): label is string => Boolean(label));
  return emptyExternalDemandSignal(`缺少最新成功批次：${missing.join("、")}。外部信号保持关闭。`);
}

function cachedSignal(value: unknown): ExternalDemandSignal | null {
  const parsed = jsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Partial<ExternalDemandSignal>;
  return candidate.authority === "observation_only"
    && candidate.source === "JIANDAOYUN"
    && candidate.platform === "天猫"
    && (candidate.state === "ready" || candidate.state === "insufficient")
    && Array.isArray(candidate.daily)
    && Array.isArray(candidate.topUnmapped)
    && Array.isArray(candidate.limitations)
    && candidate.decisionBrief !== null && typeof candidate.decisionBrief === "object"
    && candidate.refundDrivers !== null && typeof candidate.refundDrivers === "object"
    && Array.isArray((candidate.refundDrivers as Partial<RefundDriverBreakdown>).topContributors)
    && Array.isArray((candidate.refundDrivers as Partial<RefundDriverBreakdown>).byShop)
    && (candidate.refundDrivers as Partial<RefundDriverBreakdown>).identityCoverage !== null
    && typeof (candidate.refundDrivers as Partial<RefundDriverBreakdown>).identityCoverage === "object"
    && candidate.coverage !== null && typeof candidate.coverage === "object"
    && candidate.quality !== null && typeof candidate.quality === "object"
    && candidate.fulfillment !== null && typeof candidate.fulfillment === "object"
    ? candidate as ExternalDemandSignal
    : null;
}

/**
 * 页面只读当前来源批次精确绑定的预计算结果；没有或过期时 fail closed。
 * 重建只由连接器任务触发，避免一次用户打开报表就同步占用 10 万级 JSON 解析 CPU。
 */
export async function loadJiandaoyunExternalDemandSignal(db: ReadDb): Promise<ExternalDemandSignal> {
  const batches = await latestExternalDemandBatches(db);
  const binding = readModelBinding(batches);
  if (!binding) return missingBatchSignal(batches);
  const cacheResult = await db.execute(sql`
    SELECT payload
    FROM report_read_model_cache
    WHERE key = ${READ_MODEL_CACHE_KEY} AND source_binding = ${binding}
    LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(cacheResult);
  const cached = cachedSignal(row?.payload);
  if (cached) return cached;

  const pending = emptyExternalDemandSignal(
    "最新简道云批次已到达，但 BI 读模型尚未完成重建；保持关闭，等待连接器任务重建后自动开放。",
  );
  pending.sourceAsOf = batches.salesBatch?.sourceAsOf ?? null;
  pending.crosswalkAsOf = batches.crosswalkBatch?.sourceAsOf ?? null;
  return pending;
}

/** 重建可丢弃的观察型读模型，并以精确批次绑定原子替换缓存。 */
export async function refreshJiandaoyunExternalDemandReadModel(db: ReadDb): Promise<ExternalDemandSignal> {
  const batches = await latestExternalDemandBatches(db);
  const binding = readModelBinding(batches);
  if (!binding) return missingBatchSignal(batches);
  const result = await computeJiandaoyunExternalDemandSignal(db, batches);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${READ_MODEL_CACHE_KEY}, ${binding}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET
      source_binding = excluded.source_binding,
      payload = excluded.payload,
      built_at = excluded.built_at
  `);
  return result;
}

/**
 * SQL 口径说明：
 * - 数字必须先过正则；缺失/非法值不按 0 冒充，而是计入 quality；
 * - 对照键为 (shopName, platformSkuId)，且只有唯一系统 skuId 才算已映射；
 * - 销售与退款分别聚合后再相减，避免明细多对多连接放大数量。
 */
async function computeJiandaoyunExternalDemandSignal(
  db: ReadDb,
  batches: ExternalDemandBatches,
): Promise<ExternalDemandSignal> {
  const { crosswalkBatch, salesBatch, refundBatch, jstOutboundBatch } = batches;

  if (!crosswalkBatch || !salesBatch || !refundBatch) return missingBatchSignal(batches);

  const [crosswalkResult, salesResult, refundResult, exceptionResult, directResult] = await Promise.all([
    db.execute(sql`SELECT payload FROM staging_rows
      WHERE import_job_id = ${crosswalkBatch.importJobId}
        AND target_table = 'jdy_tmall_sku_crosswalk_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL`),
    db.execute(sql`SELECT payload FROM staging_rows
      WHERE import_job_id = ${salesBatch.importJobId}
        AND target_table = 'jdy_tmall_sku_sales_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL`),
    db.execute(sql`SELECT payload FROM staging_rows
      WHERE import_job_id = ${refundBatch.importJobId}
        AND target_table = 'jdy_tmall_sku_refund_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL`),
    db.execute(sql`SELECT id, raw_value, status FROM alias_exceptions
      WHERE alias_type = 'sku_barcode' AND scope = 'JIANDAOYUN'`),
    // 第二条身份桥（2026-09-02）：业务直接把「店铺|平台SKU」认领到系统 SKU 的外部标识。
    // 对照表只覆盖 859/2,076 个平台 SKU，另 44% 的金额根本不在对照表里，只能靠这条桥。
    db.execute(sql`SELECT value, sku_id FROM sku_identifiers
      WHERE kind = 'external' AND scope = 'JIANDAOYUN:TMALL' AND active = true`),
  ]);

  type CrosswalkAccumulator = { barcodes: Set<string>; skuIds: Set<number> };
  type SalesAccumulator = {
    date: string; shopName: string; platformSkuId: string;
    productName: string | null; skuName: string | null;
    paidQty: Qty; validPaidRows: number; sourceRows: number; invalidRows: number;
  };
  type RefundAccumulator = {
    date: string; shopName: string; platformSkuId: string;
    productName: string | null; skuName: string | null;
    refundQty: Qty; validRows: number; sourceRows: number; invalidRows: number;
  };
  const crosswalkRaw = new Map<string, CrosswalkAccumulator>();
  for (const row of resultRows<Record<string, unknown>>(crosswalkResult)) {
    const payload = objectValue(row.payload);
    const data = objectValue(payload.data);
    const identity = objectValue(payload._identity);
    const shopName = textValue(data.shopName);
    const platformSkuId = textValue(data.platformSkuId);
    if (!shopName || !platformSkuId) continue;
    const key = grainKey(shopName, platformSkuId);
    const current = crosswalkRaw.get(key) ?? { barcodes: new Set<string>(), skuIds: new Set<number>() };
    const barcode = textValue(data.barcode);
    if (barcode) current.barcodes.add(barcode);
    const skuId = intValue(identity.skuId);
    if (skuId > 0) current.skuIds.add(skuId);
    crosswalkRaw.set(key, current);
  }
  const crosswalk = new Map<string, { barcode: string | null; skuId: number | null; conflicting: boolean }>();
  let conflictingCrosswalks = 0;
  for (const [key, value] of crosswalkRaw) {
    const conflicting = value.skuIds.size > 1;
    if (conflicting) conflictingCrosswalks++;
    crosswalk.set(key, {
      barcode: value.barcodes.size === 1 ? [...value.barcodes][0] : null,
      skuId: value.skuIds.size === 1 ? [...value.skuIds][0] : null,
      conflicting,
    });
  }

  // 直接认领只在对照表给不出唯一 skuId 时生效；对照表已有明确归属或冲突的行不被覆盖
  for (const row of resultRows<Record<string, unknown>>(directResult)) {
    const value = textValue(row.value);
    const skuId = intValue(row.sku_id);
    const separator = value.indexOf("|");
    if (!value || skuId <= 0 || separator <= 0) continue;
    const key = grainKey(value.slice(0, separator), value.slice(separator + 1));
    const existing = crosswalk.get(key);
    if (!existing) crosswalk.set(key, { barcode: null, skuId, conflicting: false });
    else if (existing.skuId === null && !existing.conflicting) existing.skuId = skuId;
  }

  const sales = new Map<string, SalesAccumulator>();
  for (const row of resultRows<Record<string, unknown>>(salesResult)) {
    const data = objectValue(objectValue(row.payload).data);
    const date = textValue(data.statisticalDate).slice(0, 10);
    const shopName = textValue(data.shopName);
    const platformSkuId = textValue(data.skuId);
    const key = grainKey(date, shopName, platformSkuId);
    const current = sales.get(key) ?? {
      date, shopName, platformSkuId, productName: null, skuName: null,
      paidQty: ZERO_QTY, validPaidRows: 0, sourceRows: 0, invalidRows: 0,
    };
    const paid = numericQty(data.paidNumber);
    current.sourceRows++;
    if (paid === null) current.invalidRows++;
    else { current.paidQty = qtyAdd(current.paidQty, paid); current.validPaidRows++; }
    current.productName = maxText(current.productName, data.productName);
    current.skuName = maxText(current.skuName, data.skuName);
    sales.set(key, current);
  }
  const refunds = new Map<string, RefundAccumulator>();
  for (const row of resultRows<Record<string, unknown>>(refundResult)) {
    const data = objectValue(objectValue(row.payload).data);
    const date = textValue(data.statisticalDate).slice(0, 10);
    const shopName = textValue(data.shopName);
    const platformSkuId = textValue(data.skuId);
    const key = grainKey(date, shopName, platformSkuId);
    const current = refunds.get(key) ?? {
      date, shopName, platformSkuId, productName: null, skuName: null,
      refundQty: ZERO_QTY, validRows: 0, sourceRows: 0, invalidRows: 0,
    };
    const qty = numericQty(data.successRefundSuborderNumber);
    current.sourceRows++;
    if (qty === null) current.invalidRows++;
    else { current.refundQty = qtyAdd(current.refundQty, qty); current.validRows++; }
    current.productName = maxText(current.productName, data.productName);
    current.skuName = maxText(current.skuName, data.skuName);
    refunds.set(key, current);
  }
  const exceptions = new Map<string, { id: number; status: ExternalDemandSignal["topUnmapped"][number]["exceptionStatus"] }>();
  for (const row of resultRows<Record<string, unknown>>(exceptionResult)) {
    const rawValue = textValue(row.raw_value);
    const status = row.status === "open" || row.status === "resolved" || row.status === "ignored"
      ? row.status : null;
    if (rawValue) exceptions.set(rawValue, { id: intValue(row.id), status });
  }

  type DailyAccumulator = {
    date: string;
    sourceRows: number;
    validPaidRows: number;
    invalidSalesRows: number;
    invalidRefundRows: number;
    paidQty: Qty;
    refundQty: Qty;
    netQty: Qty;
    mappedPaidQty: Qty;
    mappedRefundQty: Qty;
    mappedNetQty: Qty;
  };
  type UnmappedAccumulator = Omit<ExternalDemandSignal["topUnmapped"][number], "paidQty" | "refundQty" | "netQty"> & {
    paidQty: Qty;
    refundQty: Qty;
    netQty: Qty;
  };
  const daily = new Map<string, DailyAccumulator>();
  const platformIdentitySet = new Set<string>();
  const mappedIdentitySet = new Set<string>();
  const demandBySkuDay = new Map<string, Qty>();
  const unmapped = new Map<string, UnmappedAccumulator>();
  const refundDriverObservations: RefundDriverObservation[] = [];
  let paidQty = ZERO_QTY;
  let refundQty = ZERO_QTY;
  let mappedPaidQty = ZERO_QTY;
  let mappedRefundQty = ZERO_QTY;
  let salesRows = 0;
  let mappedSalesRows = 0;
  let invalidSalesRows = 0;
  let invalidRefundRows = 0;
  const demandKeys = new Set([...sales.keys(), ...refunds.keys()]);
  for (const key of demandKeys) {
    const existingSale = sales.get(key);
    const existingRefund = refunds.get(key);
    const sale = existingSale ?? {
      date: existingRefund?.date ?? "",
      shopName: existingRefund?.shopName ?? "",
      platformSkuId: existingRefund?.platformSkuId ?? "",
      productName: existingRefund?.productName ?? null,
      skuName: existingRefund?.skuName ?? null,
      paidQty: ZERO_QTY,
      validPaidRows: 0,
      sourceRows: 0,
      invalidRows: 0,
    };
    const refund = existingRefund ?? {
      date: sale.date,
      shopName: sale.shopName,
      platformSkuId: sale.platformSkuId,
      productName: sale.productName,
      skuName: sale.skuName,
      refundQty: ZERO_QTY,
      validRows: 0,
      sourceRows: 0,
      invalidRows: 0,
    };
    const identityKey = grainKey(sale.shopName, sale.platformSkuId);
    const match = crosswalk.get(identityKey);
    const mapped = match?.skuId != null;
    const exception = match?.barcode ? exceptions.get(match.barcode) : null;
    salesRows += sale.sourceRows;
    invalidSalesRows += sale.invalidRows;
    invalidRefundRows += refund.invalidRows;
    paidQty = qtyAdd(paidQty, sale.paidQty);
    refundQty = qtyAdd(refundQty, refund.refundQty);
    if (sale.sourceRows > 0) platformIdentitySet.add(identityKey);
    if (mapped) {
      mappedSalesRows += sale.sourceRows;
      mappedPaidQty = qtyAdd(mappedPaidQty, sale.paidQty);
      mappedRefundQty = qtyAdd(mappedRefundQty, refund.refundQty);
      if (sale.sourceRows > 0) mappedIdentitySet.add(identityKey);
    }
    if (ISO_DAY.test(sale.date)) {
      const row = daily.get(sale.date) ?? {
        date: sale.date,
        sourceRows: 0,
        validPaidRows: 0,
        invalidSalesRows: 0,
        invalidRefundRows: 0,
        paidQty: ZERO_QTY,
        refundQty: ZERO_QTY,
        netQty: ZERO_QTY,
        mappedPaidQty: ZERO_QTY,
        mappedRefundQty: ZERO_QTY,
        mappedNetQty: ZERO_QTY,
      };
      row.sourceRows += sale.sourceRows;
      row.validPaidRows += sale.validPaidRows;
      row.invalidSalesRows += sale.invalidRows;
      row.invalidRefundRows += refund.invalidRows;
      row.paidQty = qtyAdd(row.paidQty, sale.paidQty);
      row.refundQty = qtyAdd(row.refundQty, refund.refundQty);
      row.netQty = qtySub(row.paidQty, row.refundQty);
      if (mapped) {
        row.mappedPaidQty = qtyAdd(row.mappedPaidQty, sale.paidQty);
        row.mappedRefundQty = qtyAdd(row.mappedRefundQty, refund.refundQty);
        row.mappedNetQty = qtySub(row.mappedPaidQty, row.mappedRefundQty);
      }
      daily.set(sale.date, row);
      if (mapped) {
        const demandKey = grainKey(sale.date, String(match.skuId));
        demandBySkuDay.set(
          demandKey,
          qtyAdd(demandBySkuDay.get(demandKey) ?? ZERO_QTY, qtySub(sale.paidQty, refund.refundQty)),
        );
      }
      if (sale.validPaidRows > 0 || refund.validRows > 0) {
        refundDriverObservations.push({
          date: sale.date,
          shopName: sale.shopName,
          platformSkuId: sale.platformSkuId,
          barcode: match?.barcode ?? null,
          skuId: match?.skuId ?? null,
          exceptionId: exception?.id ?? null,
          exceptionStatus: exception?.status ?? null,
          productName: maxText(sale.productName, refund.productName),
          skuName: maxText(sale.skuName, refund.skuName),
          paidQty: sale.paidQty,
          refundQty: refund.refundQty,
        });
      }
    }
    if (!mapped) {
      const current = unmapped.get(identityKey) ?? {
        shopName: sale.shopName,
        platformSkuId: sale.platformSkuId,
        barcode: match?.barcode ?? null,
        exceptionId: exception?.id ?? null,
        exceptionStatus: exception?.status ?? null,
        productName: null,
        skuName: null,
        paidQty: ZERO_QTY,
        refundQty: ZERO_QTY,
        netQty: ZERO_QTY,
      };
      current.productName = maxText(current.productName, sale.productName);
      current.skuName = maxText(current.skuName, sale.skuName);
      current.paidQty = qtyAdd(current.paidQty, sale.paidQty);
      current.refundQty = qtyAdd(current.refundQty, refund.refundQty);
      current.netQty = qtySub(current.paidQty, current.refundQty);
      unmapped.set(identityKey, current);
    }
  }
  const dailyRows = [...daily.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((row) => ({
      date: row.date,
      sourceRows: row.sourceRows,
      validPaidRows: row.validPaidRows,
      invalidSalesRows: row.invalidSalesRows,
      invalidRefundRows: row.invalidRefundRows,
      paidQty: qtyNumber(row.paidQty),
      refundQty: qtyNumber(row.refundQty),
      netQty: qtyNumber(row.netQty),
      mappedPaidQty: qtyNumber(row.mappedPaidQty),
      mappedRefundQty: qtyNumber(row.mappedRefundQty),
      mappedNetQty: qtyNumber(row.mappedNetQty),
  }));
  const decisionBrief = buildRollingDemandBrief(dailyRows);
  const refundDrivers = buildRefundDriverBreakdown(refundDriverObservations, decisionBrief);
  const platformIdentities = platformIdentitySet.size;
  const mappedIdentities = mappedIdentitySet.size;
  const topUnmappedRows = [...unmapped.values()].sort((left, right) =>
    Number(right.paidQty) - Number(left.paidQty)
    || left.shopName.localeCompare(right.shopName)
    || left.platformSkuId.localeCompare(right.platformSkuId)).slice(0, 30)
    .map((row) => ({
      ...row,
      paidQty: qtyNumber(row.paidQty),
      refundQty: qtyNumber(row.refundQty),
      netQty: qtyNumber(row.netQty),
    }));
  const qualityBlockers = invalidSalesRows + invalidRefundRows + conflictingCrosswalks;
  const fulfillment = jstOutboundBatch
    ? await loadFulfillmentComparison(db, demandBySkuDay, jstOutboundBatch)
    : emptyFulfillmentComparison("尚无聚水潭日出库成功批次，无法建立同窗履约对比。");

  return {
    state: dailyRows.length > 0 ? "ready" : "insufficient",
    authority: "observation_only",
    gate: dailyRows.length === 0
      ? "最新批次没有可用的日期与数量，外部信号保持关闭。"
      : qualityBlockers > 0
        ? `发现 ${qualityBlockers} 个数值或对照质量问题；可查看趋势，但禁止作为正式销售或补货输入。`
        : "观察口径已生成；完成身份覆盖、总量对账、业务 UAT 与放行审批前，禁止进入正式事实和自动决策。",
    source: "JIANDAOYUN",
    platform: "天猫",
    sourceAsOf: salesBatch.sourceAsOf,
    crosswalkAsOf: crosswalkBatch.sourceAsOf,
    daily: dailyRows,
    decisionBrief,
    refundDrivers,
    totals: {
      paidQty: qtyNumber(paidQty),
      refundQty: qtyNumber(refundQty),
      netQty: qtyNumber(qtySub(paidQty, refundQty)),
      mappedPaidQty: qtyNumber(mappedPaidQty),
      mappedRefundQty: qtyNumber(mappedRefundQty),
      mappedNetQty: qtyNumber(qtySub(mappedPaidQty, mappedRefundQty)),
    },
    coverage: {
      salesRows,
      mappedSalesRows,
      rowPct: percent(mappedSalesRows, salesRows),
      platformIdentities,
      mappedIdentities,
      identityPct: percent(mappedIdentities, platformIdentities),
      paidQtyPct: percent(qtyNumber(mappedPaidQty), qtyNumber(paidQty)),
    },
    quality: { invalidSalesRows, invalidRefundRows, conflictingCrosswalks },
    fulfillment,
    topUnmapped: topUnmappedRows,
    limitations: [
      "这是简道云只读观察，不是聚水潭出库事实，也不是用友财务凭证。",
      "净需求信号 = 支付件数 − 成功退款子订单数；不含取消未付款、换货、平台时间差或刷单识别。",
      "未映射平台 SKU 只能计入总体趋势，不能归属系统 SKU、品牌、BOM、库存或补货建议。",
      "只有最新成功批次参与计算；旧批次保留作证据，但不会重复累加。",
    ],
  };
}

export function emptyExternalDemandSignal(gate = "尚未取得完整的简道云外部需求证据。"): ExternalDemandSignal {
  return {
    state: "insufficient",
    authority: "observation_only",
    gate,
    source: "JIANDAOYUN",
    platform: "天猫",
    sourceAsOf: null,
    crosswalkAsOf: null,
    daily: [],
    decisionBrief: emptyRollingDemandBrief("缺少完整的销售、退款或 SKU 对照证据，滚动需求判断保持关闭。"),
    refundDrivers: emptyRefundDriverBreakdown("缺少完整的双窗口退款证据，驱动拆解保持关闭。"),
    totals: {
      paidQty: 0, refundQty: 0, netQty: 0,
      mappedPaidQty: 0, mappedRefundQty: 0, mappedNetQty: 0,
    },
    coverage: {
      salesRows: 0, mappedSalesRows: 0, rowPct: null,
      platformIdentities: 0, mappedIdentities: 0, identityPct: null, paidQtyPct: null,
    },
    quality: { invalidSalesRows: 0, invalidRefundRows: 0, conflictingCrosswalks: 0 },
    fulfillment: emptyFulfillmentComparison("简道云需求证据不完整，无法与聚水潭建立可比窗口。"),
    topUnmapped: [],
    limitations: ["缺少完整的销售、退款或 SKU 对照证据，系统不会用 0 填补。"],
  };
}

function emptyFulfillmentComparison(gate: string): ExternalDemandSignal["fulfillment"] {
  return {
    state: "insufficient",
    authority: "comparison_only",
    jstSourceAsOf: null,
    grain: "业务日 × SCM SKU（跨店铺、跨仓汇总）",
    gate,
    totals: {
      jdyMappedNetQty: 0,
      jstMappedOutboundQty: 0,
      comparableDemandQty: 0,
      comparableOutboundQty: 0,
      gapQty: null,
      absoluteGapQty: null,
    },
    coverage: {
      jdyMappedSkuDays: 0,
      jstMappedSkuDays: 0,
      comparableSkuDays: 0,
      jdyComparablePct: null,
      jstComparablePct: null,
    },
    daily: [],
    topGaps: [],
  };
}

async function loadFulfillmentComparison(
  db: ReadDb,
  demandBySkuDay: ReadonlyMap<string, Qty>,
  jstBatch: LatestBatch,
): Promise<ExternalDemandSignal["fulfillment"]> {
  const [jstResult, skuResult] = await Promise.all([
    db.execute(sql`SELECT payload FROM staging_rows
      WHERE import_job_id = ${jstBatch.importJobId}
        AND target_table = 'jst_daily_sales'
        AND status IN ('validated', 'committed')`),
    db.execute(sql`SELECT id, code FROM skus`),
  ]);
  const skuCodes = new Map<number, string>();
  for (const row of resultRows<Record<string, unknown>>(skuResult)) {
    const id = intValue(row.id);
    if (id > 0) skuCodes.set(id, textValue(row.code));
  }
  const outboundBySkuDay = new Map<string, Qty>();
  for (const row of resultRows<Record<string, unknown>>(jstResult)) {
    const payload = objectValue(row.payload);
    const identity = objectValue(payload._resolved);
    const date = textValue(payload.bizDate);
    const skuId = intValue(identity.skuId);
    const qty = numericQty(payload.qty);
    if (!ISO_DAY.test(date) || skuId <= 0 || qty === null) continue;
    const key = grainKey(date, String(skuId));
    outboundBySkuDay.set(key, qtyAdd(outboundBySkuDay.get(key) ?? ZERO_QTY, qty));
  }
  const keys = new Set([...demandBySkuDay.keys(), ...outboundBySkuDay.keys()]);
  const rows = [...keys].map((key) => {
    const [date, rawSkuId] = key.split("\u0000");
    const skuId = intValue(rawSkuId);
    return {
      date,
      skuId,
      skuCode: skuCodes.get(skuId) || null,
      demandQty: demandBySkuDay.has(key) ? qtyNumber(demandBySkuDay.get(key)!) : null,
      outboundQty: outboundBySkuDay.has(key) ? qtyNumber(outboundBySkuDay.get(key)!) : null,
    };
  }).filter((row) => row.date && row.skuId > 0)
    .sort((left, right) => left.date.localeCompare(right.date) || left.skuId - right.skuId);

  const comparable = rows.filter((row) => row.demandQty !== null && row.outboundQty !== null);
  if (comparable.length === 0) {
    const empty = emptyFulfillmentComparison(
      "简道云与聚水潭最新成功批次没有同业务日、同已映射 SCM SKU 的可比样本；缺失保持未知。",
    );
    empty.jstSourceAsOf = jstBatch.sourceAsOf;
    empty.coverage.jdyMappedSkuDays = rows.filter((row) => row.demandQty !== null).length;
    empty.coverage.jstMappedSkuDays = rows.filter((row) => row.outboundQty !== null).length;
    return empty;
  }

  const jdyRows = rows.filter((row) => row.demandQty !== null);
  const jstRows = rows.filter((row) => row.outboundQty !== null);
  const comparableDemandQty = comparable.reduce((sum, row) => sum + (row.demandQty ?? 0), 0);
  const comparableOutboundQty = comparable.reduce((sum, row) => sum + (row.outboundQty ?? 0), 0);
  const byDate = new Map<string, ExternalDemandSignal["fulfillment"]["daily"][number]>();
  for (const row of rows) {
    const current = byDate.get(row.date) ?? {
      date: row.date,
      mappedNetDemandQty: 0,
      jstOutboundQty: 0,
      comparableDemandQty: 0,
      comparableOutboundQty: 0,
      gapQty: null,
      onlyJdySkuDays: 0,
      onlyJstSkuDays: 0,
    };
    if (row.demandQty !== null) current.mappedNetDemandQty += row.demandQty;
    if (row.outboundQty !== null) current.jstOutboundQty += row.outboundQty;
    if (row.demandQty !== null && row.outboundQty !== null) {
      current.comparableDemandQty += row.demandQty;
      current.comparableOutboundQty += row.outboundQty;
    } else if (row.demandQty !== null) current.onlyJdySkuDays++;
    else current.onlyJstSkuDays++;
    byDate.set(row.date, current);
  }
  const daily = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  for (const row of daily) {
    if (row.comparableDemandQty !== 0 || row.comparableOutboundQty !== 0) {
      row.gapQty = row.comparableOutboundQty - row.comparableDemandQty;
    }
  }
  const topGaps = comparable.map((row) => {
    const gapQty = (row.outboundQty ?? 0) - (row.demandQty ?? 0);
    return {
      date: row.date,
      skuId: row.skuId,
      skuCode: row.skuCode,
      mappedNetDemandQty: row.demandQty ?? 0,
      jstOutboundQty: row.outboundQty ?? 0,
      gapQty,
      absoluteGapQty: Math.abs(gapQty),
    };
  }).sort((left, right) => right.absoluteGapQty - left.absoluteGapQty
    || left.date.localeCompare(right.date)
    || left.skuId - right.skuId).slice(0, 30);
  const gapQty = comparableOutboundQty - comparableDemandQty;

  return {
    state: "ready",
    authority: "comparison_only",
    jstSourceAsOf: jstBatch.sourceAsOf,
    grain: "业务日 × SCM SKU（跨店铺、跨仓汇总）",
    gate: "已建立同业务日、同 SCM SKU 的独立观察对比；店铺/仓身份、控制总量和业务 UAT 完成前禁止解释为漏单或改写正式事实。",
    totals: {
      jdyMappedNetQty: jdyRows.reduce((sum, row) => sum + (row.demandQty ?? 0), 0),
      jstMappedOutboundQty: jstRows.reduce((sum, row) => sum + (row.outboundQty ?? 0), 0),
      comparableDemandQty,
      comparableOutboundQty,
      gapQty,
      absoluteGapQty: Math.abs(gapQty),
    },
    coverage: {
      jdyMappedSkuDays: jdyRows.length,
      jstMappedSkuDays: jstRows.length,
      comparableSkuDays: comparable.length,
      jdyComparablePct: percent(comparable.length, jdyRows.length),
      jstComparablePct: percent(comparable.length, jstRows.length),
    },
    daily,
    topGaps,
  };
}
