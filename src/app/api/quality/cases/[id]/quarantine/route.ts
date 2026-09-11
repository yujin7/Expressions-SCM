import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { quarantineCaseScope } from "@/server/modules/quality/case-quarantine";

/**
 * 质量案件冻结范围内批次（W2 审计 4a）：登记围堵行动 + 调库存侧隔离能力。
 * 角色门（quality / warehouse，admin 兜底）与审计在服务层；执行不了会明说原因而不是静默跳过。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    const body = (await readJson(req)) as Record<string, unknown>;
    // caseId 以路径为准（body 中同名字段忽略）
    return NextResponse.json(await quarantineCaseScope(user, { ...body, caseId: parseId(id) }), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
