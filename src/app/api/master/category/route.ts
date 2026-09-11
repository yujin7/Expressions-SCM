import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import {  guardRead, guardWrite } from "@/server/modules/master/common";
import { createCategory, listCategories } from "@/server/modules/master/category";
import { parseSelectedValues } from "@/server/core/selected-options";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(await listCategories(q, page, pageSize, parseSelectedValues(searchParams)));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardWrite("category");
    // 审计已随写入落在同一事务内（master/category.ts）
    const result = await createCategory(await readJson(req), user);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
