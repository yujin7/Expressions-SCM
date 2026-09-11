import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { appendWorkItemNote, listWorkItemHistory } from "@/server/modules/todo/history";
import { ApiError, errorResponse, parseId, readJson } from "@/server/modules/master/common";

type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, ctx: Context) {
  try {
    const actor = await getFreshSessionUser();
    const params = new URL(req.url).searchParams;
    if ([...params.keys()].some(k => k !== "before") || params.getAll("before").length > 1) throw new ApiError(400, "历史记录查询参数无效");
    return NextResponse.json(await listWorkItemHistory(parseId((await ctx.params).id), params.has("before") ? { before: params.get("before") } : {}, actor));
  } catch (error) { return errorResponse(error, { path: "/api/todo/[id]/history", method: "GET" }); }
}
export async function POST(req: NextRequest, ctx: Context) {
  try {
    const actor = await getFreshSessionUser();
    const result = await appendWorkItemNote(parseId((await ctx.params).id), await readJson(req) as never, actor);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) { return errorResponse(error, { path: "/api/todo/[id]/history", method: "POST" }); }
}
