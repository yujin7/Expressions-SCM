import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { CLOSED_LOOP_MEMO_MS, getClosedLoop } from "@/server/modules/report/closed-loop";

/** 建议闭环追踪（只读）：补货建议/NPD 首单 → BH 草稿 → 审批执行状态 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { page, pageSize } = parseListQuery(req.url);
    // 请求级记忆（红队审计 A8）：闭环页每次加载都要跑两段流水回放，60s 内复用同一份结果
    const data = await getClosedLoop({ page, pageSize }, undefined, { memoMs: CLOSED_LOOP_MEMO_MS });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
