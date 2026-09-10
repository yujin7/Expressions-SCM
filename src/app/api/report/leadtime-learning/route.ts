import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { applyLeadTimeSuggestion, getLeadTimeLearning } from "@/server/modules/report/leadtime-learning";
import { guardFreshWrite } from "@/server/modules/outsource/common";

/** E2-04 交期学习：历史 PO 承诺交期 vs 实际收货 → 交期分布/准时率（只读） */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    return NextResponse.json({ ...await getLeadTimeLearning({ q, page, pageSize }), permissions: {
      canFill: user.roles.some(r => ["admin", "pmc", "purchasing"].includes(r)),
      canOverride: user.roles.some(r => ["admin", "pmc"].includes(r)),
    } });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 采纳所见采购周期建议；采购仅补空值，覆盖须pmc/admin，新鲜会话回查。 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = await readJson(req);
    return NextResponse.json(await applyLeadTimeSuggestion(user, body), { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
