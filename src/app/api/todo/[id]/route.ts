import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { assignWorkItem, getWorkItem, setWorkItemStatus, workItemPatchSchema } from "@/server/modules/todo/service";
import { errorResponse, guardRead, parseId, readJson } from "@/server/modules/master/common";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    return NextResponse.json(await getWorkItem(parseId((await ctx.params).id)));
  } catch (error) {
    return errorResponse(error, { path: "/api/todo/[id]", method: "GET" });
  }
}

/** PATCH {status?} / {assigneeId?} / note?；权限在 service 内按 assignee/assigner/creator/admin/同责任角色判定 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const id = parseId((await ctx.params).id);
    const patch = workItemPatchSchema.parse(await readJson(req));
    let item = patch.assigneeId !== undefined
      ? await assignWorkItem(id, patch.assigneeId, user, undefined, { note: patch.note ?? null })
      : await getWorkItem(id);
    if (patch.status !== undefined) {
      item = await setWorkItemStatus(id, patch.status, user, undefined, { note: patch.note ?? null });
    }
    return NextResponse.json(item);
  } catch (error) {
    return errorResponse(error, { path: "/api/todo/[id]", method: "PATCH" });
  }
}
