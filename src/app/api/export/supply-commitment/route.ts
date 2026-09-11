import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { buildCsv, csvDisposition, EXPORT_KINDS, stripMoneyColumns, SYNC_EXPORT_MAX } from "@/server/modules/report/export";
import { ensureExportWorkerStarted, syncExportGate } from "@/jobs/export-worker";

export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const def = EXPORT_KINDS["supply-commitment"];
    const params = def.paramsFromSearch(req.nextUrl.searchParams);
    const { rows, columns, total } = await def.produce(user, params, SYNC_EXPORT_MAX);
    const deferred = await syncExportGate(user, "supply-commitment", params, total);
    const headers = { "Cache-Control": "private, no-store" };
    if (deferred) {
      ensureExportWorkerStarted();
      return NextResponse.json({ ...deferred, message: "超过5000行，已创建承诺证据导出任务；保留观察窗，读取执行时最新事实，不是页面快照" }, { status: 202, headers });
    }
    return new NextResponse(buildCsv(rows, stripMoneyColumns(columns, user.roles)), {
      headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": csvDisposition(`采购承诺例外证据_${params.asOf}`) },
    });
  } catch (error) {
    return errorResponse(error, { path: "/api/export/supply-commitment", method: "GET" });
  }
}
