import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import {  guardWrite } from "@/server/modules/master/common";
import { updateCategory } from "@/server/modules/master/category";

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("category");
    const { id } = await ctx.params;
    // 审计已随写入落在同一事务内（master/category.ts）
    const result = await updateCategory(parseId(id), await readJson(req), user);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
