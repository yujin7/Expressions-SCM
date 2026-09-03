import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getTransferSuggestions } from "@/server/modules/report/transfer-suggest";

/** E3-04 仓间调拨建议（只读；逐仓出库流水代理逐仓需求，先挪后买） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const horizonRaw = Number(searchParams.get("horizonDays"));
    const horizonDays = Number.isFinite(horizonRaw) && horizonRaw > 0 ? horizonRaw : undefined;
    // 预警行深链 `?skuIds=1,2,3`（D57 IAL-04）：只算这些 SKU
    const skuIds = (searchParams.get("skuIds") ?? "")
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    const data = await getTransferSuggestions({ q, page, pageSize, horizonDays, skuIds: skuIds.length ? skuIds : undefined });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
