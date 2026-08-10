import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listBalances } from "@/server/modules/inventory/queries";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const warehouseId = Number(searchParams.get("warehouseId")) || undefined;
    // nonzero 默认 1（隐藏零余额行）；显式 nonzero=0 时展示全部
    const nonzero = searchParams.get("nonzero") !== "0";
    const commercialRole = searchParams.get("commercialRole") ?? undefined;
    return NextResponse.json(
      await listBalances({ q, warehouseId, nonzero, commercialRole, page, pageSize }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
