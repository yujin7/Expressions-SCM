import { NextRequest, NextResponse } from "next/server";
import { buildProductExternalDecisionEvidenceBrief } from "@/components/product-external-decision-evidence";
import { getDbAsync } from "@/db";
import { ApiError, errorResponse, guardRead } from "@/server/modules/master/common";
import { loadDataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import { getInboundCalendar } from "@/server/modules/report/inbound-calendar";
import { loadJiandaoyunSupportingObservations } from "@/server/modules/report/jiandaoyun-supporting-observation";
import { loadPromiseReliability } from "@/server/modules/report/supply-commitment";
import { parsePromiseExceptionSearch, promiseExceptionQuerySchema } from "@/server/modules/report/promise-exception-query";

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
    for (const key of ["from", "to"]) {
      if (sp.getAll(key).length > 1) throw new ApiError(400, "到货日期参数重复");
    }
    const exceptionParams = new URLSearchParams(sp);
    exceptionParams.delete("from"); exceptionParams.delete("to");
    const exceptionQuery = promiseExceptionQuerySchema.parse(parsePromiseExceptionSearch(exceptionParams, "list"));
    const db = await getDbAsync();
    const [data, promiseReliability, supportingObservations, dataSources] = await Promise.all([
      getInboundCalendar({ from, to }, db),
      loadPromiseReliability({ exceptionQuery }, db),
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
