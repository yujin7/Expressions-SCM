export interface DemandAggregateInput {
  rowCount: number;
  mappedRows: number;
  demandQty: number;
  doneQty: number;
}

export interface ChannelAggregateInput {
  name: string;
  demandQty: number;
  doneQty: number;
}

export function achievementRate(doneQty: number, demandQty: number): number | null {
  return demandQty > 0 ? Math.round((doneQty / demandQty) * 1000) / 10 : null;
}

export function buildDemandSummary(
  totals: DemandAggregateInput,
  byChannel: ChannelAggregateInput[],
) {
  return {
    kind: "demand" as const,
    ...totals,
    achievementRate: achievementRate(totals.doneQty, totals.demandQty),
    byChannel: byChannel.map((row) => ({
      ...row,
      achievementRate: achievementRate(row.doneQty, row.demandQty),
    })),
  };
}

export function buildStockCoverageSummary(
  rows: { skuId: number | null; fileQty: number }[],
  systemQtyBySku: Record<number, number>,
  agreementTolerance = 0.5,
) {
  const comparable = rows.filter((row) => row.skuId != null);
  const agreeRows = comparable.filter((row) => {
    const systemQty = systemQtyBySku[row.skuId as number] ?? 0;
    return Math.abs(systemQty - row.fileQty) < agreementTolerance;
  }).length;
  return {
    kind: "stock_summary" as const,
    rowCount: rows.length,
    comparableRows: comparable.length,
    agreeRows,
    diffRows: comparable.length - agreeRows,
    unmappedRows: rows.length - comparable.length,
  };
}

