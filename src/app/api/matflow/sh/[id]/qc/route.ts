import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createQc } from "@/server/modules/matflow/sh";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const body = (await readJson(req)) as Record<string, unknown>;
    // shId 以路径为准（body 中同名字段忽略）
    return NextResponse.json(await createQc(user, { ...body, shId: parseId(id) }), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
