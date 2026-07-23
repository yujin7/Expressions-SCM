import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { ApiError, errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { previewJs } from "@/server/modules/settlement/js";

/** 结算预览满页是钱——仅 PMC/财务/采购/管理员可看（《01》§6 JS 行：运营/仓管无 R） */
const PREVIEW_ROLES = ["pmc", "finance", "purchasing", "admin"];

export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    if (!user.roles.some((r) => PREVIEW_ROLES.includes(r))) {
      throw new ApiError(403, "无权限查看结算预览");
    }
    const jgId = parseId(new URL(req.url).searchParams.get("jgId") ?? "");
    // 上列角色均可见价格（PRICE_VISIBLE_ROLES 超集校验）——仍走 maskSensitive 统一收口
    return NextResponse.json(maskSensitive(await previewJs(jgId), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
