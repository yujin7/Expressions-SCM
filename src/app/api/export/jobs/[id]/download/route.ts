import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { exportJobs } from "@/db/schema";
import { ApiError, errorResponse, guardRead, parseId, todayShanghai } from "@/server/modules/master/common";
import { csvDisposition, EXPORT_KIND_LABELS } from "@/server/modules/report/export";

/**
 * GET /api/export/jobs/[id]/download：任务完成后下载 CSV。
 * 仅本人或 admin；未完成/失败/文件缺失一律 404（不泄露他人任务存在性）。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardRead();
    const { id: raw } = await ctx.params;
    const id = parseId(raw);
    const db = await getDbAsync();
    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, id));
    if (!job || (job.requestedBy !== user.id && !user.roles.includes("admin"))) {
      throw new ApiError(404, "任务不存在");
    }
    if (job.status !== "done" || !job.filePath) {
      throw new ApiError(404, "任务尚未完成，暂无文件可下载");
    }
    let buf: Buffer;
    try {
      buf = await readFile(job.filePath);
    } catch {
      throw new ApiError(404, "导出文件已不存在，请重新创建导出任务");
    }
    const label = EXPORT_KIND_LABELS[job.kind] ?? job.kind;
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": csvDisposition(`${label}_${todayShanghai()}_任务${job.id}`),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
