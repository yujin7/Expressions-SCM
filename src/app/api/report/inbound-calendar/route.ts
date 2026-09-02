import { NextRequest, NextResponse } from "next/server";
import { buildProductExternalDecisionEvidenceBrief } from "@/components/product-external-decision-evidence";
import { getDbAsync } from "@/db";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { loadDataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import { getInboundCalendar } from "@/server/modules/report/inbound-calendar";
import { loadJiandaoyunSupportingObservations } from "@/server/modules/report/jiandaoyun-supporting-observation";
import { loadPromiseReliability } from "@/server/modules/report/supply-commitment";

/**
 * E4-03 到货日历：未结供给（core/supply）按预计到货日分桶（只读，不开单）。
 * 不透出 warehouseId 入参——三个供给源都没有收货仓维度，服务层对该参数直接报 400。
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const from = sp.get("from")?.trim() || undefined;
    const to = sp.get("to")?.trim() || undefined;
    const db = await getDbAsync();
    const [data, promiseReliability, supportingObservations, dataSources] = await Promise.all([
      getInboundCalendar({ from, to }, db),
      loadPromiseReliability({}, db),
      loadJiandaoyunSupportingObservations(db),
      loadDataSourceReadiness(db),
    ]);
    return NextResponse.json({
      ...data,
      promiseReliability,
      supportingObservations: supportingObservations.filter((observation) =>
        observation.stream === "purchase-demand-observation"),
      externalDecisionEvidence: buildProductExternalDecisionEvidenceBrief("supply-commitment", dataSources),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
