import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { assignWorkItem, getWorkItem, setWorkItemStatus, workItemPatchSchema } from "@/server/modules/todo/service";
import { ApiError, errorResponse, guardRead, parseId, readJson } from "@/server/modules/master/common";

/** 与 listWorkItems 同一可见性谓词：本人相关 ∪ 本角色 ∪ admin；范围外一律 404（不暴露存在性，D62） */
function canView(user: { id: number; roles: string[] }, item: { assigneeId: number; assignerId: number; ownerRole: string | null; createdBy?: number | null }): boolean {
  if (user.roles.includes("admin")) return true;
  if (item.assigneeId === user.id || item.assignerId === user.id || item.createdBy === user.id) return true;
  return !!item.ownerRole && user.roles.includes(item.ownerRole);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const item = await getWorkItem(parseId((await ctx.params).id));
    if (!canView(user, item as never)) throw new ApiError(404, "待办不存在");
    return NextResponse.json(item);
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
