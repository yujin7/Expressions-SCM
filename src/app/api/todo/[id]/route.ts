import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { getWorkItem, isWorkItemVisible, patchWorkItem, resolveTodoVisibility, workItemPatchSchema } from "@/server/modules/todo/service";
import { ApiError, errorResponse, guardRead, parseId, readJson } from "@/server/modules/master/common";


export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const item = await getWorkItem(parseId((await ctx.params).id));
    if (!isWorkItemVisible(item as never, user, resolveTodoVisibility(user))) throw new ApiError(404, "待办不存在");
    return NextResponse.json(item);
  } catch (error) {
    return errorResponse(error, { path: "/api/todo/[id]", method: "GET" });
  }
}

/** PATCH {status?} / {assigneeId?} / note?；service 锁行后按读取同范围授权，原子提交全部字段。 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const id = parseId((await ctx.params).id);
    const patch = workItemPatchSchema.parse(await readJson(req));
    const item = await patchWorkItem(id, patch, user);
    return NextResponse.json(item);
  } catch (error) {
    return errorResponse(error, { path: "/api/todo/[id]", method: "PATCH" });
  }
}
