import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getCountTask } from "@/server/modules/inventory/count";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // Read-only hints require current identity, like BH details.
    const { id } = await ctx.params;
    return NextResponse.json(await getCountTask(parseId(id), undefined, user));
  } catch (e) {
    return errorResponse(e);
  }
}
