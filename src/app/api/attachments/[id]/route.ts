import { NextRequest, NextResponse } from "next/server";
import { errorResponse, parseId } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { deleteAttachment } from "@/server/modules/attachment/service";

/** 删除附件：仅上传人或管理员（校验在 service）；硬删行 + 尽力 unlink */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id } = await ctx.params;
    await deleteAttachment(user, parseId(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
