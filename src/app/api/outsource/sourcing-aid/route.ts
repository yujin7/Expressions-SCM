import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getSourcingAid } from "@/server/modules/outsource/sourcing-aid";

/**
 * 选源决策辅助（W2 审计 6）：`/outsource/wo`「生成单据」旁的只读事实面板。
 * 含供应商基准价（R9 敏感金额）：走新鲜身份回查，金额由服务层按 canSeePrices 剥离，
 * 出口再过 maskSensitive 收口。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const url = new URL(req.url);
    const skuId = Number(url.searchParams.get("skuId"));
    const supplierIds = (url.searchParams.get("supplierIds") ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    const data = await getSourcingAid(user, { skuId, supplierIds: supplierIds.length ? supplierIds : undefined });
    return NextResponse.json(maskSensitive(data, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
