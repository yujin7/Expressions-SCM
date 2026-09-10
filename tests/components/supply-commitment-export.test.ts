import { describe, expect, it } from "vitest";

import { buildPromiseReliabilityExport } from "@/components/supply-commitment-export";
import type { PromiseReliability } from "@/server/modules/report/supply-commitment";

const fixture: PromiseReliability = {
  state: "ready",
  authority: "scm_internal_baseline",
  asOf: "2026-08-10",
  windowDays: 180,
  windowFrom: "2026-02-12",
  grain: "采购行（收货来源可核对）",
  promiseVersionState: "immutable_history",
  rate: 50,
  originalRate: 0,
  totals: {
    effectiveLines: 3,
    promisedLines: 2,
    eligibleLines: 2,
    onTimeInFull: 1,
    lateFull: 0,
    overdueShort: 1,
    undated: 1,
    future: 0,
    outsideWindow: 0,
    ambiguous: 0,
    controlMismatch: 0,
  },
  originalTotals: {
    eligibleLines: 1,
    onTimeInFull: 0,
    lateFull: 0,
    overdueShort: 1,
    historyTrusted: 1,
    historyBackfilled: 0,
    historyMissing: 0,
    future: 0,
    outsideWindow: 0,
    ambiguous: 0,
    controlMismatch: 0,
  },
  coverage: { promisePct: 66.67, calculablePct: 100, historyPct: 100 },
  exceptions: [{
    lineId: 7,
    poId: 3,
    docNo: "=PO-001",
    supplierCode: "SUP001",
    supplierName: "供应商甲",
    skuId: 9,
    skuCode: "YL001",
    skuName: "原料甲",
    baseUom: "kg",
    basis: "original",
    promisedDate: "2026-08-01",
    originalPromisedDate: "2026-08-01",
    currentPromisedDate: "2026-08-04",
    promiseHistoryState: "trusted",
    revisionCount: 1,
    status: "overdue_short",
    orderedQty: 10,
    receivedByPromise: 3,
    receivedAsOf: 3,
    shortQty: 7,
    daysLate: 9,
    fulfilledDate: null,
  }],
  gate: null,
  historyGate: null,
  limitations: ["测试限制"],
  externalEdges: [
    { source: "JIANDAOYUN", state: "awaiting_uat", purpose: "历史流程佐证" },
    { source: "JST", state: "awaiting_uat", purpose: "仓配入库佐证" },
    { source: "YONYOU", state: "awaiting_uat", purpose: "ERP 财务佐证" },
  ],
};

describe("供给承诺可信度导出", () => {
  it("保留口径、覆盖、例外行和三条外部对照门禁", () => {
    const output = buildPromiseReliabilityExport(fixture);
    expect(output.filename).toBe("供给承诺可信度-2026-08-10.csv");
    expect(output.headers).toContain("可计算覆盖率");
    expect(output.headers).toContain("原始承诺可信度");
    expect(output.rows).toHaveLength(1);
    expect(output.rows[0]).toContain("原始承诺");
    expect(output.rows[0]).toContain("逾期未齐");
    expect(output.rows[0]).toContain("=PO-001");
    expect(output.rows[0].at(-1)).toContain("JIANDAOYUN:awaiting_uat");
    expect(output.rows[0].at(-1)).toContain("JST:awaiting_uat");
    expect(output.rows[0].at(-1)).toContain("YONYOU:awaiting_uat");
  });
});
