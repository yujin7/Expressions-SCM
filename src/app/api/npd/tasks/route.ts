import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { updateNpdTask } from "@/server/modules/npd/service";

/** NPD 任务状态推进（pmc/ops，新鲜会话回查） */
export async function PATCH(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await updateNpdTask(user, await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
