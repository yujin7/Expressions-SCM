import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { confirmSkuSourceStatus, getSkuSourceStatus } from "@/server/modules/master/sku-source-status";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await guardFreshWrite();
    const { id } = await ctx.params;
    if (req.nextUrl.searchParams.getAll("before").length > 1) throw new ApiError(400, "历史游标不可重复");
    const before = req.nextUrl.searchParams.get("before");
    return NextResponse.json(await getSkuSourceStatus(parseId(id), actor, undefined, before === null ? undefined : parseId(before)), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return errorResponse(e); }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await guardFreshWrite();
    const { id } = await ctx.params;
    const result = await confirmSkuSourceStatus(parseId(id), await readJson(req), actor);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (e) { return errorResponse(e); }
}
