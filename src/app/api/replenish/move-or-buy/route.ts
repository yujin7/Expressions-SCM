import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getMoveOrBuyDecisions } from "@/server/modules/report/move-or-buy";

/**
 * 「先挪后买」统一决策表（只读）：按 SKU 并排调拨建议与补货建议，按最晚下单日排序。
 * 金额（线路单位费用/估算成本）由 service 内按 PRICE_VISIBLE_ROLES 置空（stripLaneMoney），
 * **出口再经 `maskSensitive` 兜底**——`laneMedianUnitFee`/`laneEstCost` 已进 SENSITIVE_FIELDS。
 * 手工闸门漏一处就整条链路裸奔（安全审计 S7 的结论），本波其余读模型路由都有这层兜底，唯独本路由曾没有。
 * 本路由不写库；页面的两个动作走既有草稿端点（/api/inventory/stock-doc、/api/replenish/draft）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const horizonRaw = Number(searchParams.get("horizonDays"));
    const horizonDays = Number.isFinite(horizonRaw) && horizonRaw > 0 ? horizonRaw : undefined;
    return NextResponse.json(
      maskSensitive(
        await getMoveOrBuyDecisions({ q, page, pageSize, horizonDays, roles: user.roles }),
        user.roles,
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
