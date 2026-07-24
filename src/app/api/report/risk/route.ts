import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getRiskWorklist, registerRiskDisposal } from "@/server/modules/report/risk";
import { guardFreshWrite } from "@/server/modules/outsource/common";

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

/** 处置决定登记（pmc/ops/warehouse，新鲜会话回查） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await registerRiskDisposal(user, await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
