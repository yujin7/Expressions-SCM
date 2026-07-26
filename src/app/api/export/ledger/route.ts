import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, todayShanghai } from "@/server/modules/master/common";
import {
  buildCsv, csvDisposition, EXPORT_KINDS, stripMoneyColumns, SYNC_EXPORT_MAX,
} from "@/server/modules/report/export";
import { ensureExportWorkerStarted, syncExportGate } from "@/jobs/export-worker";

/**
 * 库存流水导出（参数与 /api/inventory/ledger 一致；无金额列，strip 为机械保障）。
 * >5000 行：自动创建异步导出任务并返回 202 {jobId}（UAT 缺口 #4）；小导出行为不变。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const def = EXPORT_KINDS.ledger;
    const params = def.paramsFromSearch(new URL(req.url).searchParams);
    const { rows, columns, total } = await def.produce(user, params, SYNC_EXPORT_MAX);
    const deferred = await syncExportGate(user, "ledger", params, total);
    if (deferred) {
      ensureExportWorkerStarted();
      return NextResponse.json(
        { ...deferred, message: "已超过同步导出上限（5000 行），已自动创建异步导出任务，请到「导出任务」页下载" },
        { status: 202 },
      );
    }
    return new NextResponse(buildCsv(rows, stripMoneyColumns(columns, user.roles)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": csvDisposition(`库存流水_${todayShanghai()}`),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
