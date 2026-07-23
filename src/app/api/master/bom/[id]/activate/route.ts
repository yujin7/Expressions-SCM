// BOM 生效=审批动作（体检 #4 整改）：activateBom 内校验 is_approver+职责分离并写 approvals
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { auditFromRoute, guardRead, guardWrite } from "@/server/modules/master/common";
import { activateBom } from "@/server/modules/master/bom";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("bom");
    const { id } = await ctx.params;
    const result = await activateBom(parseId(id), user);
    await auditFromRoute(user, "bom", parseId(id), "activate", result);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
