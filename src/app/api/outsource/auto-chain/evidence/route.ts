import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { ApiError, errorResponse, parseId } from "@/server/modules/master/common";
import { getKitFactoryEvidence } from "@/server/modules/outsource/kit-factory-evidence";

export async function GET(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    requireAnyRole(user, "pmc");
    const params = req.nextUrl.searchParams;
    if (params.size !== 1 || !params.has("woId")) throw new ApiError(400, "请仅提供一个工单ID");
    const data = await getKitFactoryEvidence(user, parseId(params.get("woId")!));
    return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
