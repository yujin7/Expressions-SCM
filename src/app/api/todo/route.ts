import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { createWorkItem, listWorkItems, type WorkItemView } from "@/server/modules/todo/service";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";

/** D61 待办列表：view=mine|all；status=active|open,in_progress,done,cancelled；ownerRole；assigneeId；overdue=1 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const view: WorkItemView = searchParams.get("view") === "all" ? "all" : "mine";
    const assigneeId = Number(searchParams.get("assigneeId"));
    return NextResponse.json(await listWorkItems({
      view,
      q,
      status: searchParams.get("status") || undefined,
      ownerRole: searchParams.get("ownerRole") || undefined,
      assigneeId: Number.isInteger(assigneeId) && assigneeId > 0 ? assigneeId : undefined,
      sourceKind: searchParams.get("sourceKind") || undefined,
      overdueOnly: searchParams.get("overdue") === "1",
      page,
      pageSize,
    }, user));
  } catch (error) {
    return errorResponse(error, { path: "/api/todo", method: "GET" });
  }
}

/** 新建待办（全员可建；写守卫回查 DB） */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const result = await createWorkItem(await readJson(req), user);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return errorResponse(error, { path: "/api/todo", method: "POST" });
  }
}
