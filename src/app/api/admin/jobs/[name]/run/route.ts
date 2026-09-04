import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { runJobManually } from "@/server/modules/admin/job-run";

/**
 * 手动触发一个已登记的定时任务（审计 #10）。
 *
 * 名字白名单在 `INTERVAL_JOBS`（未知名 404）；权限、并发锁与审计都在服务层。
 * 写守卫用 getFreshSessionUser 回查 DB——管理员角色可能刚被撤销。
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  try {
    const user = await getFreshSessionUser();
    const { name } = await ctx.params;
    return NextResponse.json(await runJobManually(user, decodeURIComponent(name)));
  } catch (e) {
    return errorResponse(e, { path: "/api/admin/jobs/[name]/run", method: "POST" });
  }
}
