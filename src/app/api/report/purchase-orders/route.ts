import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import {
  listPurchaseOrderYears, loadPurchaseOrderMetrics, refreshPurchaseOrderMetrics, stripPurchaseOrderMoney,
} from "@/server/modules/report/purchase-order-metrics";

/**
 * D63 采购订单指标（真报表）：已下单单数/数量/金额、订单至交付、降本、供应商 OTIF。
 * 单数/数量全员可读；金额只对 PRICE_VISIBLE_ROLES 下发（stripPurchaseOrderMoney），
 * 因含金额故回查新鲜身份（guardFreshWrite）而非只解 JWT。
 * 响应另带 availableYears（读模型事实里有已下单 PO 的年份，恒含当年），供年份下拉，不再取浏览器时钟。
 */
function parseYear(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ApiError(400, "year 非法（2000–2100）");
  return year;
}

export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const year = parseYear(new URL(req.url).searchParams.get("year"));
    const db = await getDbAsync();
    const [model, availableYears] = await Promise.all([loadPurchaseOrderMetrics({ year }, db), listPurchaseOrderYears(db)]);
    return NextResponse.json({ ...maskSensitive(stripPurchaseOrderMoney(model, user.roles), user.roles), availableYears });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 手动重建当年读模型（状态类变化不改 source_binding，日任务之外的兜底）：PMC/采购/管理员 */
export async function POST() {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, "pmc", "purchasing");
    const db = await getDbAsync();
    const model = await refreshPurchaseOrderMetrics(db);
    return NextResponse.json(maskSensitive(stripPurchaseOrderMoney(model, user.roles), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
