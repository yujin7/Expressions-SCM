import { NextRequest, NextResponse } from "next/server";
import { PRICE_VISIBLE_ROLES } from "@/server/core/constants";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { createPriceList, listPriceLists } from "@/server/modules/outsource/price-list";

/**
 * 采购价目表 `price_lists`（W2 审计 2）：此前唯一写入者是 seed 脚本，上线后再无维护入口，
 * 而它同时是 R1 比价基准、/report/price-compare 的唯一数据源、结算扣款单价代理。
 *
 * 读：金额报表口径——回查 DB 新鲜身份 + PRICE_VISIBLE_ROLES，出口再过 maskSensitive。
 * 写：服务层 requireAnyRole(user, "purchasing")（admin 兜底），同事务 writeAudit。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...PRICE_VISIBLE_ROLES);
    const { q, page, pageSize } = parseListQuery(req.url);
    const url = new URL(req.url);
    const num = (key: string): number | undefined => {
      const raw = url.searchParams.get(key);
      const n = raw == null ? NaN : Number(raw);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    };
    const data = await listPriceLists(user, {
      q,
      page,
      pageSize,
      skuId: num("skuId"),
      supplierId: num("supplierId"),
      effective: url.searchParams.get("effective") ?? undefined,
    });
    return NextResponse.json(maskSensitive(data, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = await readJson(req);
    const row = await createPriceList(user, body);
    return NextResponse.json(maskSensitive(row, user.roles), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
