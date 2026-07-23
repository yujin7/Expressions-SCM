// 放行进度总览（驱动放行 UI）：按 targetTable 汇总 待放行/已提交/拒收 + 阻塞原因
import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { releaseStatus } from "@/server/modules/release/engine";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const raw = new URL(req.url).searchParams.get("jobId");
    const jobId = raw ? Number(raw) : undefined;
    if (raw && (!Number.isInteger(jobId) || jobId! <= 0)) {
      return NextResponse.json({ error: "无效的 jobId" }, { status: 400 });
    }
    return NextResponse.json(await releaseStatus(jobId));
  } catch (e) {
    return errorResponse(e);
  }
}
