import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getQcSummary } from "@/server/modules/report/qc-summary";
import { optionalIntegerQuery } from "@/server/core/query-number";

/** E5-07 质检聚合透视：按 (供应商 × 月) 汇总正常/返工/让步/报废（只读） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const supplierId = optionalIntegerQuery(sp, "supplierId", { label: "供应商 ID" });
    const months = optionalIntegerQuery(sp, "months", { label: "质检月份数", max: 36 });
    return NextResponse.json(await getQcSummary({ supplierId, months }));
  } catch (e) {
    return errorResponse(e);
  }
}
