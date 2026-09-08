import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, todayShanghai } from "@/server/modules/master/common";
import { buildCsv, csvDisposition, EXPORT_KINDS, stripMoneyColumns, SYNC_EXPORT_MAX } from "@/server/modules/report/export";
import { ensureExportWorkerStarted, syncExportGate } from "@/jobs/export-worker";

/** Same read scope as the quantity-only inventory alert list; no recompute or business mutation. */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const def = EXPORT_KINDS["inventory-alerts"];
    const params = def.paramsFromSearch(new URL(req.url).searchParams);
    const { rows, columns, total } = await def.produce(user, params, SYNC_EXPORT_MAX);
    const deferred = await syncExportGate(user, "inventory-alerts", params, total);
    const headers = { "Cache-Control": "private, no-store" };
    if (deferred) {
      ensureExportWorkerStarted();
      return NextResponse.json({ ...deferred, message: "超过5000行，已创建导出任务；任务按本次筛选和排序读取执行时最新数据" }, { status: 202, headers });
    }
    return new NextResponse(buildCsv(rows, stripMoneyColumns(columns, user.roles)), {
      headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": csvDisposition(`库存预警_${todayShanghai()}`) },
    });
  } catch (error) {
    return errorResponse(error, { path: "/api/export/inventory-alerts", method: "GET" });
  }
}
