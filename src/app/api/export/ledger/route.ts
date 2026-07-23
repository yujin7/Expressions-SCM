import { NextRequest, NextResponse } from "next/server";
import { LEDGER_SOURCE_LABELS } from "@/components/labels";
import { listLedger } from "@/server/modules/inventory/queries";
import { errorResponse, guardRead, todayShanghai } from "@/server/modules/master/common";
import {
  buildCsv, csvDisposition, EXPORT_ROW_CAP, fmtShanghai, stripMoneyColumns,
} from "@/server/modules/report/export";

/** 库存流水导出（参数与 /api/inventory/ledger 一致；无金额列，strip 为机械保障） */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const searchParams = new URL(req.url).searchParams;
    const { rows, total } = await listLedger({
      skuId: Number(searchParams.get("skuId")) || undefined,
      warehouseId: Number(searchParams.get("warehouseId")) || undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      page: 1,
      pageSize: EXPORT_ROW_CAP,
    });
    const data = (rows as Record<string, unknown>[]).map((r) => ({
      ...r,
      occurredAt: fmtShanghai(r.occurredAt as Date),
      sourceDocType: LEDGER_SOURCE_LABELS[String(r.sourceDocType)] ?? r.sourceDocType,
    }));
    const columns = stripMoneyColumns([
      { key: "occurredAt", title: "时间" },
      { key: "skuCode", title: "SKU编码" },
      { key: "skuName", title: "SKU名称" },
      { key: "warehouseName", title: "仓库" },
      { key: "qtyDelta", title: "数量±" },
      { key: "sourceDocType", title: "来源类型" },
      { key: "sourceDocId", title: "来源单ID" },
      { key: "action", title: "动作" },
    ], user.roles);
    const truncated = total > EXPORT_ROW_CAP;
    return new NextResponse(buildCsv(data, columns, { truncated }), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": csvDisposition(`库存流水_${todayShanghai()}`),
        ...(truncated ? { "X-Truncated": "1" } : {}),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
