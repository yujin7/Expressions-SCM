import { NextRequest, NextResponse } from "next/server";
import { DOC_STATUS_LABELS } from "@/components/labels";
import { errorResponse, todayShanghai } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  buildCsv, csvDisposition, EXPORT_ROW_CAP, fmtShanghai, stripMoneyColumns,
} from "@/server/modules/report/export";
import { getSettlementSummary } from "@/server/modules/report/settlement-summary";

/**
 * 结算汇总表导出（docs 明细行）。角色门禁与报表一致：
 * 新鲜身份 + 采购/PMC/财务（service 内校验，运营/仓管 403 而非静默剥列）。
 * stripMoneyColumns 仍套用——门禁角色均可见价格，此处为机械双保险。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const searchParams = new URL(req.url).searchParams;
    const { docs } = await getSettlementSummary(user, {
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      supplierId: Number(searchParams.get("supplierId")) || undefined,
      status: searchParams.get("status") ?? undefined,
    });
    const truncated = docs.length > EXPORT_ROW_CAP;
    const data = (truncated ? docs.slice(0, EXPORT_ROW_CAP) : docs).map((d) => ({
      ...d,
      status: DOC_STATUS_LABELS[d.status] ?? d.status,
      createdAt: fmtShanghai(d.createdAt),
    }));
    const columns = stripMoneyColumns([
      { key: "jsNo", title: "结算单号" },
      { key: "jgNo", title: "加工通知单号" },
      { key: "supplierName", title: "加工厂" },
      { key: "goodQty", title: "合格数" },
      { key: "concessionQty", title: "让步数" },
      { key: "spareQty", title: "备品数" },
      { key: "feePayable", title: "应付加工费" },
      { key: "deductionTotal", title: "扣款合计" },
      { key: "settleAmount", title: "结算金额" },
      { key: "status", title: "状态" },
      { key: "createdAt", title: "创建时间" },
    ], user.roles);
    return new NextResponse(buildCsv(data, columns, { truncated }), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": csvDisposition(`结算汇总表_${todayShanghai()}`),
        ...(truncated ? { "X-Truncated": "1" } : {}),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
