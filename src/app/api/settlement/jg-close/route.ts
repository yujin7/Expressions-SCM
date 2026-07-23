import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { closeJgFromRoute } from "@/server/modules/settlement/js";

/** JG 收货关闭（in_progress → completed）：JS 的前置门（《01》§3 收货关闭/短关后可开） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // PMC 角色由 service 校验
    return NextResponse.json(await closeJgFromRoute(user, await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
