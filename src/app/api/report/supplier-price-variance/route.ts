import { NextRequest, NextResponse } from "next/server";

import { PRICE_VISIBLE_ROLES } from "@/server/core/constants";
import { csvDisposition, toCsv } from "@/server/modules/report/export";
import { getSupplierPriceVariance } from "@/server/modules/report/supplier-price-variance";
import { errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";

const EXPORT_LIMIT = 5000;

/** 价格敏感报表：每次读取均回查新鲜身份，并要求价格可见角色。 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...PRICE_VISIBLE_ROLES);
    const searchParams = new URL(req.url).searchParams;
    const q = (searchParams.get("q") ?? "").trim();
    const windowDays = Number(searchParams.get("windowDays")) || undefined;
    const format = searchParams.get("format");

    if (format === "csv") {
      const data = await getSupplierPriceVariance({ q, page: 1, pageSize: EXPORT_LIMIT + 1, windowDays });
      if (data.total > EXPORT_LIMIT) {
        return NextResponse.json(
          { error: `当前筛选有 ${data.total} 行，超过同步导出上限 ${EXPORT_LIMIT} 行，请缩小范围后重试` },
          { status: 409 },
        );
      }
      const csv = toCsv(data.rows.map((row) => ({ ...row })), [
        { key: "supplierCode", title: "供应商编码" },
        { key: "supplierName", title: "供应商名称" },
        { key: "skuCode", title: "SKU编码" },
        { key: "skuName", title: "SKU名称" },
        { key: "baseUom", title: "基础单位" },
        { key: "currency", title: "系统基准币种（非PO行级凭证）" },
        { key: "lineCount", title: "有效采购行数" },
        { key: "orderedBaseQty", title: "采购基础数量" },
        { key: "averageBaseNetPrice", title: "数量加权基础单位未税价" },
        { key: "benchmarkBaseNetPrice", title: "同SKU窗口最低可比价" },
        { key: "variancePct", title: "相对最低可比价偏差%" },
      ]);
      return new NextResponse(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": csvDisposition("供应商价格偏差观察值"),
        },
      });
    }

    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(searchParams.get("pageSize")) || 20));
    return NextResponse.json(await getSupplierPriceVariance({ q, page, pageSize, windowDays }));
  } catch (error) {
    return errorResponse(error);
  }
}
