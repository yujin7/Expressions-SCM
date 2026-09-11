import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getMoveOrBuyDecisions } from "@/server/modules/report/move-or-buy";

/**
 * 「先挪后买」统一决策表（只读）：按 SKU 并排调拨建议与补货建议，按最晚下单日排序。
 * 金额（线路单位费用/估算成本）由 service 内按 PRICE_VISIBLE_ROLES 剥离（stripLaneMoney 唯一权威），
 * 出口再过一次 `maskSensitive` 兜底（2026-09-04 安全审计）：`laneMedianUnitFee` / `laneEstCost`
 * 此前只靠 service 里那一道手工闸，黑名单里一个都没有——手工闸漏一处整条链路就裸奔，
 * 而这正是 CLAUDE.md 把 maskSensitive 定为唯一收口的理由。
 * 本路由不写库；页面的两个动作走既有草稿端点（/api/inventory/stock-doc、/api/replenish/draft）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const horizonRaw = Number(searchParams.get("horizonDays"));
    const horizonDays = Number.isFinite(horizonRaw) && horizonRaw > 0 ? horizonRaw : undefined;
    const data = await getMoveOrBuyDecisions({ q, page, pageSize, horizonDays, roles: user.roles });
    return NextResponse.json(maskSensitive(data, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
