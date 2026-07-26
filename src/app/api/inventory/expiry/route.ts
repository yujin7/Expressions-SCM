import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listExpiryBatches } from "@/server/modules/inventory/expiry-list";

/** 效期批次清单（仓库操作层，只读；batch_stocks 参考层口径） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const bucket = searchParams.get("bucket") ?? undefined;
    const wh = searchParams.get("warehouseId");
    const data = await listExpiryBatches({
      q,
      bucket,
      warehouseId: wh ? Number(wh) : undefined,
      page,
      pageSize,
    });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
