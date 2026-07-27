import { NextRequest, NextResponse } from "next/server";

import { errorResponse, guardRead } from "@/server/modules/master/common";
import { getProcessMining } from "@/server/modules/report/process-mining";

/** E3-07：审计事件只读流程挖掘；service 再做管理角色隔离。 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const search = new URL(req.url).searchParams;
    return NextResponse.json(await getProcessMining(user, {
      windowDays: search.get("windowDays") ?? undefined,
      entity: search.get("entity") ?? undefined,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
