import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { getJobStagingSummary } from "@/server/modules/import-review/service";
import { guardFreshWrite } from "@/server/modules/outsource/common";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json({ summary: await getJobStagingSummary(user, parseId(id)) });
  } catch (e) {
    return errorResponse(e);
  }
}
