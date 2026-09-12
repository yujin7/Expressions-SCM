import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { ApiError, errorResponse, parseId } from "@/server/modules/master/common";
import { previewJs } from "@/server/modules/settlement/js";
import { guardFreshWrite, resolveDb } from "@/server/modules/outsource/common";
import { loadSettlementReadPolicy } from "@/server/modules/settlement/read-access";

/** 结算预览满页是钱——仅 PMC/财务/采购/管理员可看（《01》§6 JS 行：运营/仓管无 R） */
const PREVIEW_ROLES = ["pmc", "finance", "purchasing", "admin"];

export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    if (!user.roles.some((r) => PREVIEW_ROLES.includes(r))) {
      throw new ApiError(403, "无权限查看结算预览");
    }
    const db = await resolveDb();
    if (!(await loadSettlementReadPolicy(db, user)).allowed) throw new ApiError(403, "当前渠道范围不可查看结算预览");
    const jgId = parseId(new URL(req.url).searchParams.get("jgId") ?? "");
    // 上列角色均可见价格（PRICE_VISIBLE_ROLES 超集校验）——仍走 maskSensitive 统一收口
    return NextResponse.json(maskSensitive(await previewJs(jgId, "0", db), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
