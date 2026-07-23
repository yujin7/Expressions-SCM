import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { createWarehouse, listWarehouses } from "@/server/modules/master/warehouse";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listWarehouses(q, page, pageSize));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    await guardWrite("warehouse");
    return NextResponse.json(await createWarehouse(await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
