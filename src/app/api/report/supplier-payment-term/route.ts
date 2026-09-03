import { NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import {
  loadSupplierPaymentTerm, refreshSupplierPaymentTerm, stripSupplierPaymentTermMoney,
} from "@/server/modules/report/supplier-payment-term";

/**
 * D64 供应商账期看板：候选判定、达成率、账期类采购额占比。
 * 候选/账期/名次全员可读；采购额只对 PRICE_VISIBLE_ROLES 下发（含金额故回查新鲜身份）。
 */
export async function GET() {
  try {
    const user = await guardFreshWrite();
    const db = await getDbAsync();
    const model = await loadSupplierPaymentTerm(db);
    return NextResponse.json(maskSensitive(stripSupplierPaymentTermMoney(model, user.roles), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}

/** 手动重建读模型：PMC/采购/管理员 */
export async function POST() {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, "pmc", "purchasing");
    const db = await getDbAsync();
    const model = await refreshSupplierPaymentTerm(db);
    return NextResponse.json(maskSensitive(stripSupplierPaymentTermMoney(model, user.roles), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
