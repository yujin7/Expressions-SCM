import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getClosedLoop } from "@/server/modules/report/closed-loop";

/** 建议闭环追踪（只读）：补货建议/NPD 首单 → BH 草稿 → 审批执行状态 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { page, pageSize } = parseListQuery(req.url);
    const data = await getClosedLoop({ page, pageSize });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
