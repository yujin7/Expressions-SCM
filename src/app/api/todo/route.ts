import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { createWorkItem, getWorkItemCreationResult, listWorkItems, workItemCreateSchema, type WorkItemView } from "@/server/modules/todo/service";
import { ApiError, errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import { z } from "zod";

/** D61 待办列表：view=mine|all；status=active|open,in_progress,done,cancelled；ownerRole；assigneeId；overdue=1 */
export async function GET(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const params = new URL(req.url).searchParams;
    if (params.has("mode")) {
      if (params.get("mode") !== "create-result" || params.getAll("mode").length !== 1 || params.getAll("requestId").length !== 1 || [...params.keys()].some(k => !["mode", "requestId"].includes(k))) throw new ApiError(400, "待办创建回执参数无效");
      return NextResponse.json(await getWorkItemCreationResult(params.get("requestId")!, user), { headers: { "Cache-Control": "private, no-store" } });
    }
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
      sortBy: searchParams.get("sortBy") || undefined,
      sortOrder: searchParams.get("sortOrder") || undefined,
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
    const body = z.record(z.unknown()).parse(await readJson(req));
    // 只有 admin 可声明 alert/review 来源；其他人一律 manual，防止伪造「系统触发」完成率或预占告警指纹（审阅 must-fix）
    const input = user.roles.includes("admin") || !body.sourceKind || body.sourceKind === "manual" ? body : { ...body, sourceKind: "manual", sourceRef: null };
    const manual = !input.sourceKind || input.sourceKind === "manual";
    if (manual) workItemCreateSchema.extend({ requestId: z.string().uuid("缺少原创建请求编号，请刷新页面；不要重复提交") }).strict().parse(input);
    const result = await createWorkItem(input as never, user);
    return NextResponse.json(manual ? { requestId: String(input.requestId).toLowerCase(), itemId: result.item.id, created: result.created } : result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return errorResponse(error, { path: "/api/todo", method: "POST" });
  }
}
