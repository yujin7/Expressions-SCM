import { NextRequest, NextResponse } from "next/server";
import { canSeePrices, maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { listExpiryBatches, parseExpirySort } from "@/server/modules/inventory/expiry-list";

/**
 * 效期批次清单（仓库操作层，只读；batch_stocks 参考层口径）。
 * 数量全员可见；金额（`amount`）仅对 PRICE_VISIBLE_ROLES 计算并下发，出口再经 maskSensitive 兜底。
 * 排序 `sort=daysLeft|amount`：金额序在**服务端全集**上排完再分页（客户端比较器只排当前一页）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const bucket = searchParams.get("bucket") ?? undefined;
    const wh = searchParams.get("warehouseId");
    const brand = searchParams.get("brand")?.trim() || undefined;
    const withValue = canSeePrices(user.roles);
    const data = await listExpiryBatches({
      q,
      bucket,
      warehouseId: wh ? Number(wh) : undefined,
      brand,
      page,
      pageSize,
      withValue,
      sort: parseExpirySort(searchParams.get("sort")),
    });
    return NextResponse.json(maskSensitive({ ...data, canSeeValue: withValue }, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
