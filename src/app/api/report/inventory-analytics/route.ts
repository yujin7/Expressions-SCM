import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getInventoryAnalytics } from "@/server/modules/report/inventory-analytics";
import { loadJiandaoyunSupportingObservations } from "@/server/modules/report/jiandaoyun-supporting-observation";

/** E7-04 库存分析三视图（只读；健康散点 × 库存账龄 × 周转指标） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const raw = Number(searchParams.get("windowDays"));
    const windowDays = Number.isFinite(raw) && raw > 0 ? raw : undefined;
    const db = await getDbAsync();
    const [data, supportingObservations] = await Promise.all([
      getInventoryAnalytics({ q, windowDays, page, pageSize }, db),
      loadJiandaoyunSupportingObservations(db),
    ]);
    return NextResponse.json({
      ...data,
      supportingObservations: supportingObservations.filter((observation) =>
        observation.stream === "inventory-count-observation"
        || observation.stream === "warehouse-observation"
        || observation.stream === "warehouse-transfer-observation"),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
