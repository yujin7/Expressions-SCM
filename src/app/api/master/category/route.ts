import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
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
    await guardWrite("category");
    return NextResponse.json(await createCategory(await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
