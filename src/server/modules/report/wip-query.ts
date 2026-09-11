import { ApiError } from "@/server/modules/master/common";
import { optionalIntegerQuery } from "@/server/core/query-number";

/** Interactive and queued export reads must reject, not silently drop, the same invalid filters. */
export function wipQuery(params: URLSearchParams) {
  const supplierId = optionalIntegerQuery(params, "supplierId", { label: "供应商 ID" });
  const mode = params.get("mode") ?? "progress", overdue = params.get("overdueOnly");
  if (params.getAll("mode").length > 1 || !["progress", "cycles"].includes(mode)) throw new ApiError(400, "看板视图无效");
  if (params.getAll("overdueOnly").length > 1 || (overdue !== null && !["0", "1"].includes(overdue))) throw new ApiError(400, "仅逾期筛选须为0或1");
  if (mode === "cycles" && overdue === "1") throw new ApiError(400, "加工周期不支持加工单逾期筛选，请切回在制进度");
  return { supplierId, mode, overdueOnly: overdue === "1" };
}
