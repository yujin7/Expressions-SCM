import { NextRequest, NextResponse } from "next/server";
import { getTodoProgressBlock, getTodoStats, type StatsGroupBy } from "@/server/modules/todo/stats";
import { errorResponse, guardRead } from "@/server/modules/master/common";

/**
 * D61 完成率/按时率（只读）。
 *  - ?scope=summary → 第 4 屏「待办跟进进度」数据块；
 *  - 否则 groupBy=person|role，from/to=YYYY-MM，ownerRole，assigneeId。
 * 可见性在 service 内裁剪（admin 全见，其余本人 + 本角色）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const sp = new URL(req.url).searchParams;
    if (sp.get("scope") === "summary") return NextResponse.json(await getTodoProgressBlock(user));
    const groupBy: StatsGroupBy = sp.get("groupBy") === "role" ? "role" : "person";
    const assigneeId = Number(sp.get("assigneeId"));
    return NextResponse.json(await getTodoStats({
      groupBy,
      fromMonth: sp.get("from") || undefined,
      toMonth: sp.get("to") || undefined,
      ownerRole: sp.get("ownerRole") || undefined,
      assigneeId: Number.isInteger(assigneeId) && assigneeId > 0 ? assigneeId : undefined,
    }, user));
  } catch (error) {
    return errorResponse(error, { path: "/api/todo/stats", method: "GET" });
  }
}
