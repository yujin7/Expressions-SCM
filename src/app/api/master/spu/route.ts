import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { createSpu, listSpus } from "@/server/modules/master/spu";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listSpus(q, page, pageSize));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    await guardWrite("spu");
    return NextResponse.json(await createSpu(await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
