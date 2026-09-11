import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, guardRead, guardWrite, parseId, readJson } from "@/server/modules/master/common";
import { closeSupplierLifecycleCase, followUpSupplierLifecycleCase, getSupplierLifecycleDetail } from "@/server/modules/master/supplier-lifecycle";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { optionalIntegerQuery } from "@/server/core/query-number";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    requireAnyRole(user, "purchasing", "pmc", "finance");
    const { id } = await ctx.params;
    const cursor = optionalIntegerQuery(req.nextUrl.searchParams, "beforeAuditId", { label: "记录游标" });
    return NextResponse.json(await getSupplierLifecycleDetail(parseId(id), cursor));
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("supplier");
    const { id } = await ctx.params;
    const input = await readJson<Record<string, unknown>>(req);
    if (input?.operation !== undefined && !["follow_up", "close"].includes(String(input.operation))) {
      throw new ApiError(400, "不支持的工作项操作");
    }
    return NextResponse.json(
      input?.operation === "follow_up"
        ? await followUpSupplierLifecycleCase(user, parseId(id), input)
        : await closeSupplierLifecycleCase(user, parseId(id), input),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
