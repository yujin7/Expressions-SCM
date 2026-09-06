import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getSettlementSummary } from "@/server/modules/report/settlement-summary";
import { optionalIntegerQuery } from "@/server/core/query-number";

/**
 * 结算汇总表——金额报表：新鲜身份回查（getFreshSessionUser）+
 * 角色门禁 采购/PMC/财务（admin 兜底；service 内 requireAnyRole → 运营/仓管 403）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 回查 DB 新鲜身份（金额报表不信任 8h JWT）
    const searchParams = new URL(req.url).searchParams;
    const supplierId = optionalIntegerQuery(searchParams, "supplierId", { label: "供应商 ID" });
    return NextResponse.json(
      await getSettlementSummary(user, {
        from: searchParams.get("from") ?? undefined,
        to: searchParams.get("to") ?? undefined,
        supplierId,
        status: searchParams.get("status") ?? undefined,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
