import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { listTodoAssignees } from "@/server/modules/todo/assignees";

/** 待办责任人选择器：在职用户 id/name/roles（不含账号、绑定等敏感字段） */
export async function GET(req: NextRequest) {
  try {
    await getFreshSessionUser();
    return NextResponse.json(await listTodoAssignees(req.nextUrl.searchParams), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error, { path: "/api/todo/assignees", method: "GET" });
  }
}
