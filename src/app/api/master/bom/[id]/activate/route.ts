// BOM 生效=审批动作（体检 #4 整改）：activateBom 内校验 is_approver+职责分离并写 approvals
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { auditFromRoute, guardWrite } from "@/server/modules/master/common";
import { activateBom } from "@/server/modules/master/bom";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("bom");
    const { id } = await ctx.params;
    // FEATURE 5：{force:true} 显式跳过委外仓结存拦截（service 内 writeAudit 记 activate_forced）
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    const result = await activateBom(parseId(id), user, { force: body?.force === true });
    await auditFromRoute(user, "bom", parseId(id), "activate", result);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
