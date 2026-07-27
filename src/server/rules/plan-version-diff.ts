import { dCmp } from "@/server/core/decimal";

export type PlanDiffCategory =
  | "new_alert"
  | "resolved"
  | "worsened"
  | "improved"
  | "mixed"
  | "stable";

export interface PlanSnapshotLine {
  skuId: number;
  skuCode: string;
  skuName: string;
  brand: string | null;
  baseUom: string;
  suggestedQty: string;
  suppressed: boolean;
  shortageDate: string | null;
  orderByDate: string | null;
  orderWindowMissed: boolean;
  coverFull: string | null;
}

export interface PlanVersionDiffRow {
  key: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  brand: string | null;
  baseUom: string;
  category: PlanDiffCategory;
  signals: string[];
  base: PlanSnapshotLine | null;
  current: PlanSnapshotLine | null;
}

export interface PlanVersionDiffResult {
  rows: PlanVersionDiffRow[];
  summary: Record<PlanDiffCategory, number> & { total: number };
}

const CATEGORY_ORDER: Record<PlanDiffCategory, number> = {
  new_alert: 0,
  worsened: 1,
  mixed: 2,
  resolved: 3,
  improved: 4,
  stable: 5,
};

function compareDate(
  current: string | null,
  base: string | null,
  earlierSignal: string,
  laterSignal: string,
  worse: string[],
  better: string[],
): void {
  if (current == null || base == null || current === base) return;
  if (current < base) worse.push(earlierSignal);
  else better.push(laterSignal);
}

/**
 * Compare two immutable suggestion sets.
 *
 * Dates are compared as absolute business dates—not "days remaining"—so a
 * normal seven-day passage between weekly snapshots is never mislabeled as
 * deterioration. Conflicting signals are kept as `mixed` instead of forcing
 * a flattering or alarming judgment.
 */
export function diffPlanVersions(
  baseRows: PlanSnapshotLine[],
  currentRows: PlanSnapshotLine[],
): PlanVersionDiffResult {
  const baseBySku = new Map(baseRows.map((row) => [row.skuId, row]));
  const currentBySku = new Map(currentRows.map((row) => [row.skuId, row]));
  const skuIds = [...new Set([...baseBySku.keys(), ...currentBySku.keys()])];
  const rows: PlanVersionDiffRow[] = [];

  for (const skuId of skuIds) {
    const base = baseBySku.get(skuId) ?? null;
    const current = currentBySku.get(skuId) ?? null;
    const identity = current ?? base;
    if (!identity) continue;

    let category: PlanDiffCategory;
    const signals: string[] = [];
    if (!base) {
      category = "new_alert";
      signals.push("本版本首次进入建议集");
    } else if (!current) {
      category = "resolved";
      signals.push("本版本已退出建议集");
    } else {
      const worse: string[] = [];
      const better: string[] = [];
      if (current.orderWindowMissed !== base.orderWindowMissed) {
        (current.orderWindowMissed ? worse : better).push(
          current.orderWindowMissed ? "最晚下单窗口已错过" : "已退出错过下单窗口状态",
        );
      }
      if (current.suppressed !== base.suppressed) {
        (current.suppressed ? better : worse).push(
          current.suppressed ? "建议转为覆盖缺口抑制" : "抑制解除，转为可执行建议",
        );
      }
      compareDate(
        current.shortageDate,
        base.shortageDate,
        "预计短缺日提前",
        "预计短缺日后移",
        worse,
        better,
      );
      compareDate(
        current.orderByDate,
        base.orderByDate,
        "最晚下单日提前",
        "最晚下单日后移",
        worse,
        better,
      );
      const qtyCmp = dCmp(current.suggestedQty, base.suggestedQty);
      if (qtyCmp > 0) worse.push("建议量增加");
      else if (qtyCmp < 0) better.push("建议量下降");

      signals.push(...worse, ...better);
      category = worse.length > 0 && better.length > 0
        ? "mixed"
        : worse.length > 0
          ? "worsened"
          : better.length > 0
            ? "improved"
            : "stable";
    }

    rows.push({
      key: String(skuId),
      skuId,
      skuCode: identity.skuCode,
      skuName: identity.skuName,
      brand: identity.brand,
      baseUom: identity.baseUom,
      category,
      signals,
      base,
      current,
    });
  }

  rows.sort((a, b) => (
    CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    || (a.current?.shortageDate ?? a.base?.shortageDate ?? "9999-12-31")
      .localeCompare(b.current?.shortageDate ?? b.base?.shortageDate ?? "9999-12-31")
    || a.skuCode.localeCompare(b.skuCode)
  ));

  const summary: PlanVersionDiffResult["summary"] = {
    total: rows.length,
    new_alert: 0,
    resolved: 0,
    worsened: 0,
    improved: 0,
    mixed: 0,
    stable: 0,
  };
  for (const row of rows) summary[row.category] += 1;

  return { rows, summary };
}
