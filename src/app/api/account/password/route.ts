import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { changeOwnPassword } from "@/server/modules/admin/users";

/** POST /api/account/password：自助改密码（写路径→新鲜身份；首登强制修改亦走此口） */
export async function POST(req: NextRequest) {
  try {
    let user;
    try {
      user = await getFreshSessionUser();
    } catch {
      throw new ApiError(401, "未登录或账号已停用");
    }
    await changeOwnPassword(user.id, await req.json());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
