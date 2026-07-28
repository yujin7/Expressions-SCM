import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, errorResponse, parseId, readOptionalJson } from "@/server/modules/master/common";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { ignoreException } from "@/server/modules/import-review/service";

const bodySchema = z.object({ note: z.string().trim().max(200).optional() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    let user;
    try {
      user = await getFreshSessionUser();
    } catch {
      throw new ApiError(401, "未登录或账号已停用");
    }
    try {
      requireRole(user, "pmc", "purchasing", "warehouse");
    } catch {
      throw new ApiError(403, "无权限处理别名异常");
    }
    const { id } = await ctx.params;
    const { note } = bodySchema.parse(await readOptionalJson(req));
    await ignoreException(user, parseId(id), note);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
