import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { getJobStagingSummary } from "@/server/modules/import-review/service";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json({ summary: await getJobStagingSummary(parseId(id)) });
  } catch (e) {
    return errorResponse(e);
  }
}
