import { NextRequest, NextResponse } from "next/server";
import { errorResponse, ApiError } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getBhCreateResult } from "@/server/modules/outsource/bh-create-request";

export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const params = req.nextUrl.searchParams;
    if (params.getAll("requestKey").length !== 1 || [...params.keys()].some(k => k !== "requestKey")) throw new ApiError(400, "请提供唯一的原创建请求编号");
    return NextResponse.json(await getBhCreateResult(user, params.get("requestKey")!), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
