import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { cancelCtCreateRequest } from "@/server/modules/matflow/ct-create-request";

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await cancelCtCreateRequest(user, await readJson(req)), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
