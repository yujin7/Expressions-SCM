import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { submitDocSchema } from "@/server/modules/outsource/schemas";
import { submitTl } from "@/server/modules/matflow/tl";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const { version } = submitDocSchema.parse(await readJson(req));
    return NextResponse.json(await submitTl(user, parseId(id), version));
  } catch (e) {
    return errorResponse(e);
  }
}
