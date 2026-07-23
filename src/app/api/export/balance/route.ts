import { NextRequest, NextResponse } from "next/server";
import { WAREHOUSE_KIND_LABELS } from "@/components/labels";
import { listBalances } from "@/server/modules/inventory/queries";
import { errorResponse, guardRead, todayShanghai } from "@/server/modules/master/common";
import {
  buildCsv, csvDisposition, EXPORT_ROW_CAP, stripMoneyColumns,
} from "@/server/modules/report/export";

/** 库存余额导出（参数与 /api/inventory/balance 一致；无金额列，strip 为机械保障） */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const searchParams = new URL(req.url).searchParams;
    const { rows, total } = await listBalances({
      q: (searchParams.get("q") ?? "").trim(),
      warehouseId: Number(searchParams.get("warehouseId")) || undefined,
      nonzero: searchParams.get("nonzero") !== "0",
      page: 1,
      pageSize: EXPORT_ROW_CAP,
    });
    const data = (rows as Record<string, unknown>[]).map((r) => ({
      ...r,
      warehouseKind: WAREHOUSE_KIND_LABELS[String(r.warehouseKind)] ?? r.warehouseKind,
    }));
    const columns = stripMoneyColumns([
      { key: "skuCode", title: "SKU编码" },
      { key: "skuName", title: "SKU名称" },
      { key: "spuCode", title: "产品编码" },
      { key: "spuNameCn", title: "产品名称" },
      { key: "warehouseName", title: "仓库" },
      { key: "warehouseKind", title: "仓库类型" },
      { key: "batchId", title: "批次" },
      { key: "qty", title: "数量" },
      { key: "baseUom", title: "基础单位" },
    ], user.roles);
    const truncated = total > EXPORT_ROW_CAP;
    return new NextResponse(buildCsv(data, columns, { truncated }), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": csvDisposition(`库存余额_${todayShanghai()}`),
        ...(truncated ? { "X-Truncated": "1" } : {}),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
