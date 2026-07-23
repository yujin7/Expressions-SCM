import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { generateDocs } from "@/server/modules/outsource/wo";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite(); // 角色（pmc）在 service 内校验
    const { id } = await ctx.params;
    return NextResponse.json(await generateDocs(user, parseId(id), await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
