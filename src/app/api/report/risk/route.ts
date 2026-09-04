import { NextRequest, NextResponse } from "next/server";
import { canSeePrices, maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { closeRiskDisposal, getRiskWorklist, registerRiskDisposal, registerRiskDisposalBatch } from "@/server/modules/report/risk";
import { guardFreshWrite } from "@/server/modules/outsource/common";

/**
 * F 项：风险库存处置工作台（只读；效期×注记×销速三源融合）。
 * 金额（`amount` / `atRiskAmount`）仅对 PRICE_VISIBLE_ROLES 计算下发，出口经 maskSensitive 兜底。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const action = searchParams.get("action") ?? undefined;
    const withValue = canSeePrices(user.roles);
    const data = await getRiskWorklist({
      q, action, page, pageSize,
      precise: searchParams.get("precise") === "1",
      withValue,
    });
    return NextResponse.json(maskSensitive({ ...data, canSeeValue: withValue }, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}

/** 处置决定登记（pmc/ops/warehouse，新鲜会话回查） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = (await readJson(req)) as { items?: unknown; intent?: string };
    if (body?.intent === "close") {
      return NextResponse.json(await closeRiskDisposal(user, body as { skuCode: string }), { status: 200 });
    }
    if (Array.isArray(body?.items)) {
      return NextResponse.json(await registerRiskDisposalBatch(user, body as { items: { skuCode: string; action: string }[] }), { status: 201 });
    }
    return NextResponse.json(await registerRiskDisposal(user, body as { skuCode: string; action: string }), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
