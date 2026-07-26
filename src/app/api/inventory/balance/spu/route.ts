import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listBalancesBySpu } from "@/server/modules/inventory/queries";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await listBalancesBySpu({ q, page, pageSize }));
  } catch (e) {
    return errorResponse(e);
  }
}
