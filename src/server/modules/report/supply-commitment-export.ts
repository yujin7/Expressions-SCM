import { z } from "zod";
import { shanghaiDay } from "@/server/core/business-day";
import { ApiError } from "../master/common";
import { buildPromiseReliabilityExport } from "@/components/supply-commitment-export";
import type { ExportKindDef } from "./export";

const paramsSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !value.startsWith("0000") && shanghaiDay(value) === value, "截止日必须是真实日期"),
  windowDays: z.number().int().min(30).max(1095),
}).strict();

/** Same facts/calculator as the preview; only the output cap differs. Never export the preview array. */
export const supplyCommitmentExport: ExportKindDef = {
  nameCn: "采购承诺例外证据",
  paramsFromSearch(sp) {
    for (const key of sp.keys()) {
      if (!["asOf", "windowDays"].includes(key) || sp.getAll(key).length !== 1) throw new ApiError(400, "承诺导出参数未知或重复");
    }
    return paramsSchema.parse({ asOf: sp.get("asOf"), windowDays: Number(sp.get("windowDays")) });
  },
  async produce(_user, params, cap, db) {
    const query = paramsSchema.parse(params);
    const { loadPromiseReliability } = await import("./supply-commitment");
    const data = await loadPromiseReliability({ ...query, limit: cap }, db);
    const file = buildPromiseReliabilityExport(data);
    return {
      columns: file.headers.map((title, index) => ({ key: `c${index}`, title })),
      rows: file.rows.map(row => Object.fromEntries(row.map((value, index) => [`c${index}`, value]))),
      // Empty evidence is one explicitly labelled explanation row, not a fabricated exception.
      total: Math.max(1, data.exceptionTotal),
    };
  },
};
