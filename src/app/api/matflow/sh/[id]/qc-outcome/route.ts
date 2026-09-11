import { NextRequest, NextResponse } from "next/server";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { getQcOutcome, raiseQcFailureOutcome } from "@/server/modules/quality/qc-outcome";

/**
 * 检验不合格的去向（W2 审计 3）：GET 看三桶量/可退量/已登记后果，POST 登记后果
 * （质量案件 和/或 退货 CT 草稿，双向留痕）。角色门与审计在服务层。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    return NextResponse.json(maskSensitive(await getQcOutcome(user, parseId(id)), user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const body = (await readJson(req)) as Record<string, unknown>;
    // shId 以路径为准（body 中同名字段忽略）
    return NextResponse.json(await raiseQcFailureOutcome(user, { ...body, shId: parseId(id) }), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
