import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardWarehouseWrite } from "@/server/modules/inventory/stock-doc";
import { cancelStockCreateRequest } from "@/server/modules/inventory/stock-create-request";

export async function POST(req: NextRequest) {
  try {
    const actor = await guardWarehouseWrite();
    return NextResponse.json(await cancelStockCreateRequest(actor, await readJson(req)), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return errorResponse(e, { path: "/api/inventory/stock-doc/cancel-create", method: "POST" }); }
}
