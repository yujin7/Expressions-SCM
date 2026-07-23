import { NextRequest, NextResponse } from "next/server";
import { DOC_STATUS_LABELS, STOCK_SUBTYPE_LABELS } from "@/components/labels";
import { listStockDocs } from "@/server/modules/inventory/stock-doc";
import { errorResponse, guardRead, todayShanghai } from "@/server/modules/master/common";
import {
  buildCsv, csvDisposition, EXPORT_ROW_CAP, fmtShanghai, stripMoneyColumns,
} from "@/server/modules/report/export";

/** 库存单据导出（参数与 /api/inventory/stock-doc 一致；列表无金额列，strip 为机械保障） */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const searchParams = new URL(req.url).searchParams;
    const { rows, total } = await listStockDocs((searchParams.get("q") ?? "").trim(), {
      status: searchParams.get("status") ?? undefined,
      subtype: searchParams.get("subtype") ?? undefined,
      page: 1,
      pageSize: EXPORT_ROW_CAP,
    });
    const data = (rows as Record<string, unknown>[]).map((r) => ({
      ...r,
      subtype: STOCK_SUBTYPE_LABELS[String(r.subtype)] ?? r.subtype,
      status: DOC_STATUS_LABELS[String(r.status)] ?? r.status,
      createdAt: fmtShanghai(r.createdAt as Date),
    }));
    const columns = stripMoneyColumns([
      { key: "docNo", title: "单据号" },
      { key: "subtype", title: "类型" },
      { key: "status", title: "状态" },
      { key: "warehouseName", title: "仓库" },
      { key: "toWarehouseName", title: "转入仓" },
      { key: "lineCount", title: "行数" },
      { key: "createdByName", title: "制单人" },
      { key: "createdAt", title: "创建时间" },
    ], user.roles);
    const truncated = total > EXPORT_ROW_CAP;
    return new NextResponse(buildCsv(data, columns, { truncated }), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": csvDisposition(`库存单据_${todayShanghai()}`),
        ...(truncated ? { "X-Truncated": "1" } : {}),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
