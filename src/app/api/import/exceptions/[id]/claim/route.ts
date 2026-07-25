import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { claimException } from "@/server/modules/import-review/service";

const bodySchema = z.object({ targetId: z.number().int().positive() });

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
      throw new ApiError(403, "无权限认领别名");
    }
    const { id } = await ctx.params;
    const { targetId } = bodySchema.parse(await readJson(req));
    await claimException(user, parseId(id), targetId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
