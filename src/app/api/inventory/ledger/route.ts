import { NextRequest, NextResponse } from "next/server";
import { canSeePrices, maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listLedger } from "@/server/modules/inventory/queries";

/**
 * 库存流水清单。数量/批次/窗口累计余额全员可见；
 * 金额（`amount` / `balanceAmount`）仅按 PRICE_VISIBLE_ROLES 计算并下发，
 * 出口再经 maskSensitive 兜底（R9 唯一收口）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { page, pageSize, searchParams } = parseListQuery(req.url);
    const data = await listLedger({
      skuId: Number(searchParams.get("skuId")) || undefined,
      warehouseId: Number(searchParams.get("warehouseId")) || undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      page,
      pageSize,
      withValue: canSeePrices(user.roles),
    });
    return NextResponse.json(maskSensitive({ ...data, canSeeValue: canSeePrices(user.roles) }, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
