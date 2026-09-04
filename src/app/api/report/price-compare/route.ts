import { NextRequest, NextResponse } from "next/server";
import { PRICE_VISIBLE_ROLES } from "@/server/core/constants";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseListQuery } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { getPriceCompare } from "@/server/modules/report/price-compare";

/**
 * E5-08 物料比价：同一物料多供应商基准价横向对比（只读，不开单）。
 *
 * **角色门禁（2026-09-04 修）**：本报表逐行返回供应商采购基准价（quotes[].price / bestPrice /
 * worstPrice），属 R9 敏感金额。此前只有 `guardRead()`——任何登录用户（含仓管/运营）都能看到
 * 每家供应商的报价。现与 /report/margin、/master/feeref 对齐：新鲜身份回查（金额报表不信任
 * 8h JWT）+ PRICE_VISIBLE_ROLES，响应再过 maskSensitive 统一收口。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 金额报表：回查 DB，停用/降权立即生效
    requireAnyRole(user, ...PRICE_VISIBLE_ROLES);
    const { q, page, pageSize } = parseListQuery(req.url);
    const data = await getPriceCompare({ q, page, pageSize });
    return NextResponse.json(maskSensitive(data, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
