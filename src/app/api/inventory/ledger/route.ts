import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listLedger } from "@/server/modules/inventory/queries";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await listLedger({
        skuId: Number(searchParams.get("skuId")) || undefined,
        warehouseId: Number(searchParams.get("warehouseId")) || undefined,
        from: searchParams.get("from") ?? undefined,
        to: searchParams.get("to") ?? undefined,
        page,
        pageSize,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
