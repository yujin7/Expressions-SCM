import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { loadDataQuality, refreshDataQuality } from "@/server/modules/report/data-quality";
import { loadSalesConsistency } from "@/server/modules/report/sales-consistency";

const VIEW_ROLES = ["pmc", "finance", "warehouse", "purchasing"];

/**
 * D65 数据质量总览（来源 × 维度 + 一致性例外）。读缓存 `data-quality/v2`；`?refresh=1` 强制重算。
 * `?section=consistency` 只返回销量一致性读模型（含例外清单）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...VIEW_ROLES);
    const db = await getDbAsync();
    const url = new URL(req.url);
    const refresh = url.searchParams.get("refresh") === "1";
    const section = url.searchParams.get("section");
    const payload = section === "consistency"
      ? await loadSalesConsistency(db)
      : refresh ? await refreshDataQuality(db) : await loadDataQuality(db);
    const response = NextResponse.json(maskSensitive(payload, user.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/report/data-quality", method: "GET" });
  }
}
