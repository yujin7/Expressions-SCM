import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import { auditFromRoute, guardRead, guardWrite } from "@/server/modules/master/common";
import { createCategory, listCategories } from "@/server/modules/master/category";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listCategories(q, page, pageSize));
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
