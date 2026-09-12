import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { optionalIntegerQuery } from "@/server/core/query-number";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { refreshInboundMaterialReview } from "@/server/modules/outsource/leftover";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const receiptId = optionalIntegerQuery(new URLSearchParams({ id }), "id", { label: "收货单ID" })!;
    await refreshInboundMaterialReview(user, receiptId);
    return NextResponse.json({ status: "checked" });
  } catch (e) {
    return errorResponse(e);
  }
}
