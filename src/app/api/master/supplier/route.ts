import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { guardRead, guardWrite } from "@/server/modules/master/common";
import { createSupplier, listSuppliers } from "@/server/modules/master/supplier";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listSuppliers(q, page, pageSize));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    await guardWrite("supplier");
    return NextResponse.json(await createSupplier(await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
