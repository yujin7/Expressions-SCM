import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getRiskWorklist } from "@/server/modules/report/risk";

/** F 项：风险库存处置工作台（只读；效期×注记×销速三源融合） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const action = searchParams.get("action") ?? undefined;
    const data = await getRiskWorklist({ q, action, page, pageSize });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
