import { NextRequest, NextResponse } from "next/server";
import { buildProductExternalDecisionEvidenceBrief } from "@/components/product-external-decision-evidence";
import { getDbAsync } from "@/db";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { loadDataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import { getInventoryAnalytics } from "@/server/modules/report/inventory-analytics";
import { loadJiandaoyunSupportingObservations } from "@/server/modules/report/jiandaoyun-supporting-observation";

/** E7-04 库存分析三视图（只读；健康散点 × 库存账龄 × 周转指标） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const raw = Number(searchParams.get("windowDays"));
    const windowDays = Number.isFinite(raw) && raw > 0 ? raw : undefined;
    const includeExternalEvidence = searchParams.get("includeExternalEvidence") !== "0";
    const db = await getDbAsync();
    const [data, supportingObservations, dataSources] = await Promise.all([
      getInventoryAnalytics({ q, windowDays, page, pageSize }, db),
      includeExternalEvidence ? loadJiandaoyunSupportingObservations(db) : Promise.resolve([]),
      includeExternalEvidence ? loadDataSourceReadiness(db) : Promise.resolve(null),
    ]);
    return NextResponse.json({
      ...data,
      supportingObservations: supportingObservations.filter((observation) =>
        observation.stream === "inventory-count-observation"
        || observation.stream === "warehouse-observation"
        || observation.stream === "warehouse-transfer-observation"),
      externalDecisionEvidence: dataSources
        ? buildProductExternalDecisionEvidenceBrief("unified-inventory", dataSources)
        : null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
