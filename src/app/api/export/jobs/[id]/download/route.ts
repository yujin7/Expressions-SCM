import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { exportJobs } from "@/db/schema";
import { ApiError, errorResponse, parseId, todayShanghai } from "@/server/modules/master/common";
import { getFreshSessionUser } from "@/server/core/dto";
import { csvDisposition, EXPORT_KIND_LABELS, EXPORT_KINDS } from "@/server/modules/report/export";
import { EXPORT_ACCESS_KEY, exportAccessFingerprint, exportFileHash, loadExportUser, requireExportRole } from "@/jobs/export-worker";

/**
 * GET /api/export/jobs/[id]/download：任务完成后下载 CSV。
 * 仅当前本人或 admin；生成身份/范围变化或旧文件缺证据时拒绝重用，须显式重新导出。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    let session;
    try { session = await getFreshSessionUser(); } catch { throw new ApiError(401, "未登录或会话已失效，请重新登录"); }
    const { id: raw } = await ctx.params;
    const id = parseId(raw);
    const db = await getDbAsync();
    const user = await loadExportUser(db, session.id);
    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, id));
    if (!job || (job.requestedBy !== user.id && !user.roles.includes("admin"))) {
      throw new ApiError(404, "任务不存在");
    }
    if (job.status !== "done" || !job.filePath) {
      throw new ApiError(404, "任务尚未完成，暂无文件可下载");
    }
    const owner = job.requestedBy === user.id ? user : await loadExportUser(db, job.requestedBy);
    const def = EXPORT_KINDS[job.kind];
    if (!def) throw new ApiError(409, "导出类型已变更，请重新创建导出任务");
    requireExportRole(owner.roles, def.roles);
    const binding = (job.params as Record<string, unknown> | null)?.[EXPORT_ACCESS_KEY] as
      { version?: number; identity?: string; sha256?: string } | undefined;
    if (binding?.version !== 1 || binding.identity !== exportAccessFingerprint(owner) || !binding.sha256) {
      throw new ApiError(409, "文件的生成权限已变化或缺少权限证据，请按当前权限重新导出");
    }
    let buf: Buffer;
    try {
      buf = await readFile(job.filePath);
    } catch {
      throw new ApiError(404, "导出文件已不存在，请重新创建导出任务");
    }
    if (exportFileHash(buf) !== binding.sha256) throw new ApiError(409, "导出文件校验失败，请重新创建导出任务");
    const label = EXPORT_KIND_LABELS[job.kind] ?? job.kind;
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": csvDisposition(`${label}_${todayShanghai()}_任务${job.id}`),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
