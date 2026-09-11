import { z } from "zod";
import { shanghaiDay } from "@/server/core/business-day";
import { ApiError } from "../master/common";

export const promiseExceptionFiltersSchema = z.object({
  q: z.string().trim().max(120).default(""),
  basis: z.enum(["", "original", "current"]).default(""),
  status: z.enum(["", "late_full", "overdue_short"]).default(""),
  sort: z.enum(["", "docNo", "lineId", "supplierName", "skuCode", "promisedDate", "revisionCount", "daysLate", "shortQty"]).default(""),
  order: z.enum(["asc", "desc"]).default("desc"),
}).strict();
export const promiseExceptionQuerySchema = promiseExceptionFiltersSchema.extend({
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(200).default(30),
});
export type PromiseExceptionQuery = z.infer<typeof promiseExceptionQuerySchema>;
export const promiseExportQuerySchema = promiseExceptionFiltersSchema.extend({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !value.startsWith("0000") && shanghaiDay(value) === value, "截止日必须是真实日期"),
  windowDays: z.number().int().min(30).max(1095),
});

/** The list and export accept the same filters. Pagination is never an export parameter. */
export function parsePromiseExceptionSearch(sp: URLSearchParams, mode: "list" | "export") {
  const allowed = mode === "list" ? Object.keys(promiseExceptionQuerySchema.shape) : Object.keys(promiseExportQuerySchema.shape);
  const values: Record<string, string | number> = {};
  for (const [key, value] of sp) {
    if (!allowed.includes(key) || sp.getAll(key).length !== 1) throw new ApiError(400, "承诺查询参数未知或重复");
    if (["page", "pageSize", "windowDays"].includes(key)) {
      if (!/^[1-9]\d*$/.test(value)) throw new ApiError(400, "承诺查询页码、每页条数和窗口须为正整数");
      values[key] = Number(value);
    } else values[key] = value;
  }
  return mode === "list" ? promiseExceptionQuerySchema.parse(values) : promiseExportQuerySchema.parse(values);
}
