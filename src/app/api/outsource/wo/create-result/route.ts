import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getWoCreateResult } from "@/server/modules/outsource/wo";

export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await getWoCreateResult(user, req.nextUrl.searchParams.get("requestKey") ?? ""), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) { return errorResponse(e); }
}
