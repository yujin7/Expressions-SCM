import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { submitDocSchema } from "@/server/modules/outsource/schemas";
import { submitFl } from "@/server/modules/matflow/fl";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const { version } = submitDocSchema.parse(await req.json());
    return NextResponse.json(await submitFl(user, parseId(id), version));
  } catch (e) {
    return errorResponse(e);
  }
}
