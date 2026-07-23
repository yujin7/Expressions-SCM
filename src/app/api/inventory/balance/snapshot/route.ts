import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listSnapshotBalances } from "@/server/modules/inventory/queries";

/** D20 全仓视图：快照仓最新库存（只读参考口径） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const warehouseId = searchParams.get("warehouseId");
    return NextResponse.json(
      await listSnapshotBalances({ q, warehouseId: warehouseId ? Number(warehouseId) : undefined, page, pageSize }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
