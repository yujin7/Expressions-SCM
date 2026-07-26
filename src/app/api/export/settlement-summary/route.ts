import { NextRequest, NextResponse } from "next/server";
import { errorResponse, todayShanghai } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  buildCsv, csvDisposition, EXPORT_KINDS, stripMoneyColumns, SYNC_EXPORT_MAX,
} from "@/server/modules/report/export";
import { ensureExportWorkerStarted, syncExportGate } from "@/jobs/export-worker";

/**
 * 结算汇总表导出（docs 明细行）。角色门禁与报表一致：
 * 新鲜身份 + 采购/PMC/财务（service 内校验，运营/仓管 403 而非静默剥列）。
 * stripMoneyColumns 仍套用——门禁角色均可见价格，此处为机械双保险。
 * >5000 行：自动创建异步导出任务并返回 202 {jobId}（UAT 缺口 #4）。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const def = EXPORT_KINDS["settlement-summary"];
    const params = def.paramsFromSearch(new URL(req.url).searchParams);
    const { rows, columns, total } = await def.produce(user, params, SYNC_EXPORT_MAX);
    const deferred = await syncExportGate(user, "settlement-summary", params, total);
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
        "Content-Disposition": csvDisposition(`结算汇总表_${todayShanghai()}`),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
