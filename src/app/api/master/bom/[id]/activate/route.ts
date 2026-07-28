// BOM 生效=审批动作（体检 #4 整改）：activateBom 内校验 is_approver+职责分离并写 approvals
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId, readOptionalJson } from "@/server/modules/master/common";
import { guardWrite } from "@/server/modules/master/common";
import { activateBom } from "@/server/modules/master/bom";
import { z } from "zod";

const bodySchema = z.object({ force: z.boolean().optional() }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("bom");
    const { id } = await ctx.params;
    // FEATURE 5：{force:true} 显式跳过委外仓结存拦截（service 内 writeAudit 记 activate_forced）
    const body = bodySchema.parse(await readOptionalJson(req));
    const result = await activateBom(parseId(id), user, { force: body.force === true });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
