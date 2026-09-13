import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { getWorkItem, getWorkItemMutationResult, isWorkItemVisible, patchWorkItem, resolveTodoVisibility, workItemPatchSchema } from "@/server/modules/todo/service";
import { ApiError, errorResponse, parseId, readJson } from "@/server/modules/master/common";


export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const params = req.nextUrl.searchParams;
    if (params.size) {
      if (params.size !== 2 || params.get("mode") !== "mutation-result" || params.getAll("mode").length !== 1 || params.getAll("requestId").length !== 1)
        throw new ApiError(400, "操作回执查询参数不正确");
      return NextResponse.json(await getWorkItemMutationResult(parseId((await ctx.params).id), params.get("requestId")!, user), { headers: { "Cache-Control": "private, no-store" } });
    }
    const item = await getWorkItem(parseId((await ctx.params).id));
    if (!isWorkItemVisible(item as never, user, resolveTodoVisibility(user))) throw new ApiError(404, "待办不存在");
    return NextResponse.json(item);
  } catch (error) {
    return errorResponse(error, { path: "/api/todo/[id]", method: "GET" });
  }
}

/** Public writes require the original request and observed version; internal wrappers retain their owning contract. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const id = parseId((await ctx.params).id);
    const patch = workItemPatchSchema.parse(await readJson(req));
    if (!patch.requestId || patch.expectedVersion === undefined) throw new ApiError(400, "请刷新待办后重试；操作必须包含原请求编号与任务版本");
    const item = await patchWorkItem(id, patch, user);
    return NextResponse.json(item);
  } catch (error) {
    return errorResponse(error, { path: "/api/todo/[id]", method: "PATCH" });
  }
}
