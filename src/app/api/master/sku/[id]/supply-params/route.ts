import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { patchSupplyParams } from "@/server/modules/master/sku-supply-params-fill";

/**
 * PATCH 周期主数据补录 { normalLeadDays?, logisticsLeadDays?, purchaseLeadDays?, note? }：
 * 只允许填空；覆盖非空值须 pmc/admin（purchasing 403）。同事务 upsert sku_params + 审计。
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const { id } = await ctx.params;
    return NextResponse.json(await patchSupplyParams(user, parseId(id), await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
