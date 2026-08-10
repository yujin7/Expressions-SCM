import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseListQuery, readJson } from "@/server/modules/master/common";
import { getMarginReport, upsertSkuCost } from "@/server/modules/report/margin";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { PRICE_VISIBLE_ROLES } from "@/server/core/constants";

/**
 * 毛利视角 v1（只读；手工成本×近3月销量；售价源未接入时留白）。
 *
 * **角色门禁（2026-08-03 修）**：本报表逐行返回 `unitCost`（sku_costs.unit_cost），
 * 属 R9 敏感金额字段。此前只有 `guardRead()`（任何登录用户），实测 ops01 能直接读到
 * `unitCost: 12.5`，而同类金额报表 settlement-summary 对同一账号返回 403 —— 口径不一致。
 * 现与 settlement-summary 对齐：新鲜身份回查（金额报表不信任 8h JWT）+ PRICE_VISIBLE_ROLES。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 金额报表：回查 DB，停用/降权立即生效
    requireAnyRole(user, ...PRICE_VISIBLE_ROLES);
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const onlyCosted = searchParams.get("onlyCosted") === "1" || searchParams.get("onlyCosted") === "true";
    const data = await getMarginReport({ q, page, pageSize, onlyCosted });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}

/** 成本录入（finance/admin，新鲜会话回查；service 内校验角色） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await upsertSkuCost(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
