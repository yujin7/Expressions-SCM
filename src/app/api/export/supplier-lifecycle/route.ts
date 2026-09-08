import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, todayShanghai } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { buildCsv, csvDisposition, EXPORT_KINDS, stripMoneyColumns, SYNC_EXPORT_MAX } from "@/server/modules/report/export";
import { ensureExportWorkerStarted, syncExportGate } from "@/jobs/export-worker";

export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    requireAnyRole(user, "purchasing", "pmc", "finance");
    const def = EXPORT_KINDS["supplier-lifecycle"];
    const params = def.paramsFromSearch(req.nextUrl.searchParams);
    const { rows, columns, total } = await def.produce(user, params, SYNC_EXPORT_MAX);
    const deferred = await syncExportGate(user, "supplier-lifecycle", params, total);
    const headers = { "Cache-Control": "private, no-store" };
    if (deferred) {
      ensureExportWorkerStarted();
      return NextResponse.json({ ...deferred, message: "超过5000行，已创建供应商工作项导出任务；按本次筛选读取执行时最新数据" }, { status: 202, headers });
    }
    return new NextResponse(buildCsv(rows, stripMoneyColumns(columns, user.roles)), {
      headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": csvDisposition(`供应商工作项_${todayShanghai()}`) },
    });
  } catch (error) {
    return errorResponse(error, { path: "/api/export/supplier-lifecycle", method: "GET" });
  }
}
