import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { resolveImportRejectionArtifact } from "@/server/import/rejection-artifact";
import { errorResponse, parseId } from "@/server/modules/master/common";
import {
  generateJobErrorFile,
  getAuthorizedImportJob,
} from "@/server/modules/import-review/service";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { csvDisposition } from "@/server/modules/report/export";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id: rawId } = await ctx.params;
    const id = parseId(rawId);
    const job = await getAuthorizedImportJob(user, id);
    if (!job.errorFile) {
      return NextResponse.json({ error: "该任务尚无拒收明细文件" }, { status: 404 });
    }
    const filePath = await resolveImportRejectionArtifact(job.errorFile);
    const file = await readFile(filePath);
    return new NextResponse(file, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": csvDisposition(`导入拒收明细_任务${id}`),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardFreshWrite();
    const { id: rawId } = await ctx.params;
    const id = parseId(rawId);
    await generateJobErrorFile(user, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
