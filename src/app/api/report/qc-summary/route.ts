import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getQcSummary } from "@/server/modules/report/qc-summary";

/** E5-07 质检聚合透视：按 (供应商 × 月) 汇总正常/返工/让步/报废（只读） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    const supplierId = Number(sp.get("supplierId")) || undefined;
    const months = Number(sp.get("months")) || undefined;
    return NextResponse.json(await getQcSummary({ supplierId, months }));
  } catch (e) {
    return errorResponse(e);
  }
}
