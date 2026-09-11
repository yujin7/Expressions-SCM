import { buildPromiseReliabilityExport } from "@/components/supply-commitment-export";
import type { ExportKindDef } from "./export";
import { parsePromiseExceptionSearch, promiseExportQuerySchema } from "./promise-exception-query";

/** Same facts/calculator as the preview; only the output cap differs. Never export the preview array. */
export const supplyCommitmentExport: ExportKindDef = {
  nameCn: "采购承诺例外证据",
  paramsFromSearch(sp) {
    return parsePromiseExceptionSearch(sp, "export");
  },
  async produce(_user, params, cap, db) {
    const { asOf, windowDays, ...exceptionQuery } = promiseExportQuerySchema.parse(params);
    const { loadPromiseReliability } = await import("./supply-commitment");
    const data = await loadPromiseReliability({ asOf, windowDays, exceptionQuery, limit: cap }, db);
    const file = buildPromiseReliabilityExport(data);
    return {
      columns: file.headers.map((title, index) => ({ key: `c${index}`, title })),
      rows: file.rows.map(row => Object.fromEntries(row.map((value, index) => [`c${index}`, value]))),
      // Empty evidence is one explicitly labelled explanation row, not a fabricated exception.
      total: Math.max(1, data.exceptionView.total),
    };
  },
};
