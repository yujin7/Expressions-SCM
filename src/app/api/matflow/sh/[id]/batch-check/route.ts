import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { optionalIntegerQuery } from "@/server/core/query-number";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { checkBatchAfterPoReceipt } from "@/server/modules/outsource/auto-chain";

/** Independent PMC recovery; never submits or posts the receipt again. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const shId = optionalIntegerQuery(new URLSearchParams({ id }), "id", { label: "收货单ID" })!;
    return NextResponse.json(await checkBatchAfterPoReceipt(user, shId));
  } catch (error) { return errorResponse(error); }
}
