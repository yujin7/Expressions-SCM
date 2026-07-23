// TODO(W3): route through approval engine —— 生效应由审批动作触发，此处为 W1 直连实现
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { activateBom } from "@/server/modules/master/bom";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWrite("bom");
    const { id } = await ctx.params;
    return NextResponse.json(await activateBom(parseId(id)));
  } catch (e) {
    return errorResponse(e);
  }
}
