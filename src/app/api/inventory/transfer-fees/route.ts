import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser, maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { canSeePrices } from "@/server/core/dto";
import {
  addTransferFee, guardTransferFeeWrite, listTransferFees, reverseTransferFee,
} from "@/server/modules/inventory/transfer-fees";

const num = (v: string | null): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** D60 调拨费用列表（金额键 amount 按【新鲜】角色剥离，RT4） */
export async function GET(req: NextRequest) {
  try {
    const reader = await guardRead();
    requireAnyRole(reader, "warehouse", "pmc", "finance", "admin");
    const fresh = await getFreshSessionUser();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const view = searchParams.get("view") === "active" ? "active" : "all";
    const data = await listTransferFees({
      q,
      stockDocId: num(searchParams.get("stockDocId")),
      feeType: searchParams.get("feeType") ?? undefined,
      fromWarehouseId: num(searchParams.get("from")),
      toWarehouseId: num(searchParams.get("to")),
      transferType: searchParams.get("type") ?? undefined,
      dateFrom: searchParams.get("dateFrom") ?? undefined,
      dateTo: searchParams.get("dateTo") ?? undefined,
      view,
      page,
      pageSize,
    });
    const response = NextResponse.json(maskSensitive(data, fresh.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (e) {
    return errorResponse(e, { path: "/api/inventory/transfer-fees", method: "GET" });
  }
}

/** 登记费用（body 无 reversalOfId）或红字作废（body 带 reversalOfId + reason）；仓管/财务 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardTransferFeeWrite();
    const body = await readJson<Record<string, unknown>>(req);
    if (body && typeof body === "object" && body.reversalOfId != null) {
      const rev = await reverseTransferFee(user, body);
      return NextResponse.json(maskSensitive(rev, user.roles), { status: 201 });
    }
    const result = await addTransferFee(user, body);
    const safe = canSeePrices(user.roles) || !result || typeof result !== "object" || !("warning" in result) || !result.warning
      ? result
      : { ...result, warning: { ...(result.warning as unknown as Record<string, unknown>), docUnitFee: null, baselineAvgUnitFee: null, pctDev: null, reason: "金额类偏差仅价格可见角色可读" } };
    return NextResponse.json(maskSensitive(safe, user.roles), { status: 201 });
  } catch (e) {
    return errorResponse(e, { path: "/api/inventory/transfer-fees", method: "POST" });
  }
}
