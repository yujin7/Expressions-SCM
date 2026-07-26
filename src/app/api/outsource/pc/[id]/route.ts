import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { approvals, pcDocs, users } from "@/db/schema";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { ApiError } from "@/server/modules/master/common";

/** PC 详情（W3-UI 契约缺口 #3 补齐：审批时间线可达） */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const { id } = await ctx.params;
    const db = await getDbAsync();
    const [doc] = await db.select().from(pcDocs).where(eq(pcDocs.id, parseId(id)));
    if (!doc) throw new ApiError(404, "价格变更申请不存在");
    const timeline = await db
      .select({ approverName: users.name, action: approvals.action, comment: approvals.comment, createdAt: approvals.createdAt })
      .from(approvals)
      .leftJoin(users, eq(approvals.approverId, users.id))
      .where(and(inArray(approvals.docType, ["pc"]), eq(approvals.docId, doc.id)))
      .orderBy(approvals.createdAt);
    return NextResponse.json(maskSensitive({ ...doc, approvals: timeline }, user.roles));
  } catch (e) {
    return errorResponse(e);
  }
}
