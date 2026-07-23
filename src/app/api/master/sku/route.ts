import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { createSku, listSkus } from "@/server/modules/master/sku";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(await listSkus(q, page, pageSize, searchParams.get("type")));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    await guardWrite("sku");
    return NextResponse.json(await createSku(await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
