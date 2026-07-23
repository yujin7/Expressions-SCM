import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { createBom, listBoms } from "@/server/modules/master/bom";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listBoms(q, page, pageSize));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    await guardWrite("bom");
    return NextResponse.json(await createBom(await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
