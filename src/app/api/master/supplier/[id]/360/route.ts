import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getSupplier360 } from "@/server/modules/master/supplier-360";

/**
 * 供应商 360（只读装配）：记分卡 × 采购订单指标 × 账期候选 × 历史交期观察 各取该供应商一行。
 * 含采购额（账期看板 / 采购指标），故回查新鲜身份；金额按 PRICE_VISIBLE_ROLES 在 service 内剥离，
 * 响应再过 maskSensitive 统一收口。非金额字段（OTIF / 交期 / 质检）全员可读。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getSupplier360(parseId(id), user.roles), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
