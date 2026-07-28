import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, errorResponse, readJson } from "@/server/modules/master/common";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { getDbAsync } from "@/db";
import { runReconcileJst } from "@/jobs/reconcile-jst";
import { writeAudit } from "@/server/core/audit";

const bodySchema = z.object({ bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "须为 YYYY-MM-DD") });

/** POST /api/jobs/recon/run {bizDate} → 手动触发对账（财务/仓管/管理员） */
export async function POST(req: NextRequest) {
  try {
    let user;
    try {
      user = await getFreshSessionUser();
    } catch {
      throw new ApiError(401, "未登录或账号已停用");
    }
    try {
      requireRole(user, "finance", "warehouse");
    } catch {
      throw new ApiError(403, "无权限触发对账");
    }
    const { bizDate } = bodySchema.parse(await readJson(req));
    const db = await getDbAsync();
    const summary = await db.transaction(async (tx) => {
      const result = await runReconcileJst(tx, bizDate);
      await writeAudit(tx, {
        userId: user.id,
        entity: "recon_diffs",
        entityId: null,
        action: "reconcile-jst:run",
        after: result,
      });
      return result;
    });
    return NextResponse.json(summary);
  } catch (e) {
    return errorResponse(e);
  }
}
