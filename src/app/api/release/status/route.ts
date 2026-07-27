// 放行进度总览（驱动放行 UI）：按 targetTable 汇总 待放行/已提交/拒收 + 阻塞原因
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { importJobs } from "@/db/schema";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { releaseStatus } from "@/server/modules/release/engine";

export async function GET(req: NextRequest) {
  try {
    const raw = new URL(req.url).searchParams.get("jobId");
    const jobId = raw ? Number(raw) : undefined;
    if (raw && (!Number.isInteger(jobId) || jobId! <= 0)) {
      return NextResponse.json({ error: "无效的 jobId" }, { status: 400 });
    }
    const user = await guardFreshWrite();
    const db = await getDbAsync();
    if (jobId == null) {
      requireAnyRole(user, "pmc");
    } else {
      const [job]: { template: string }[] = await db
        .select({ template: importJobs.template })
        .from(importJobs)
        .where(eq(importJobs.id, jobId));
      if (!job) throw new ApiError(404, "导入任务不存在");
      requireAnyRole(user, job.template === "sku_cost" ? "finance" : "pmc");
    }
    return NextResponse.json(await releaseStatus(jobId, db));
  } catch (e) {
    return errorResponse(e);
  }
}
