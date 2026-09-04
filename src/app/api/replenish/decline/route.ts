import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { clearReplenishSuppression, declineReplenishSuggestion } from "@/server/modules/replenish/decline";

/**
 * 补货建议「已复核并放弃」留痕（闭环审计 #12）：pmc/admin，新鲜会话回查；只写审计，不开单据（R13）。
 * W2-#6 起同事务再落一条抑制窗口，下一次运行不再重复建议同一个 SKU。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 角色（pmc/admin）在 service 内校验
    return NextResponse.json(await declineReplenishSuggestion(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e, { path: "/api/replenish/decline", method: "POST" });
  }
}

/** W2-#6 解除抑制（pmc/admin）：写 cleared_at 留痕、不删行；该 SKU 立刻恢复建议。抑制绝不静默，也绝不不可逆。 */
export async function DELETE(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await clearReplenishSuppression(user, await readJson(req)));
  } catch (e) {
    return errorResponse(e, { path: "/api/replenish/decline", method: "DELETE" });
  }
}
