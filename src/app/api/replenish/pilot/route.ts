import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { loadReplenishPilot } from "@/server/modules/report/replenish-pilot";

/** 补货试点读模型 replenish-pilot/v1（只读；?refresh=1 强制重算） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    return NextResponse.json(await loadReplenishPilot(undefined, { refresh }));
  } catch (e) {
    return errorResponse(e);
  }
}
