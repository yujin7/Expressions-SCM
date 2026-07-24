import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import type { SessionUser } from "@/server/core/dto";
import { getInbox } from "@/server/modules/inbox/service";

/** 我的待办：待我审批 + 我提交的待审（新鲜会话——审批域即时反映角色变更） */
export async function GET() {
  try {
    let user: SessionUser;
    try {
      const { getFreshSessionUser } = await import("@/server/core/dto");
      user = await getFreshSessionUser();
    } catch {
      throw new ApiError(401, "未登录或账号已停用");
    }
    return NextResponse.json(await getInbox(user));
  } catch (e) {
    return errorResponse(e);
  }
}
