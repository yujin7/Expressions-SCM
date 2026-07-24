import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { applyLeadTimeSuggestion, getLeadTimeLearning } from "@/server/modules/report/leadtime-learning";
import { guardFreshWrite } from "@/server/modules/outsource/common";

/** E2-04 交期学习：历史 PO 承诺交期 vs 实际收货 → 交期分布/准时率（只读） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json(await getLeadTimeLearning({ q, page, pageSize }));
  } catch (e) {
    return errorResponse(e);
  }
}

/** 采纳建议 → 写 sku_params.normal_lead_days（pmc/purchasing/admin；人工闸，新鲜会话回查） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = (await req.json()) as { skuId: number; leadDays: number };
    return NextResponse.json(await applyLeadTimeSuggestion(user, body), { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
