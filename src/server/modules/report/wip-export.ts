import { z } from "zod";
import type { ExportKindDef } from "./export";
import { wipQuery } from "./wip-query";
import { shanghaiTimestampOf } from "@/server/core/business-day";
import { DOC_STATUS_LABELS, formatOrderType } from "@/components/labels";

const schema = z.object({ supplierId: z.number().int().positive().max(2147483647).optional(),
  mode: z.enum(["progress", "cycles"]).default("progress"), overdueOnly: z.boolean().default(false) }).strict();
const time = (s: string | null) => s ? shanghaiTimestampOf(new Date(s)) : "";
export const wipExport: ExportKindDef = {
  nameCn: "委外在制与加工周期", paramsFromSearch: wipQuery,
  async produce(_user, params, cap, db) {
    const value = schema.parse(params);
    const query = wipQuery(new URLSearchParams({ mode: value.mode, overdueOnly: value.overdueOnly ? "1" : "0",
      ...(value.supplierId ? { supplierId: String(value.supplierId) } : {}) }));
    if (query.mode === "cycles") {
      const { listProcessingCycles } = await import("./processing-cycle");
      const result = await listProcessingCycles(query, db);
      const fields = ["工单", "加工厂ID", "加工厂", "SKU", "成品", "单位", "订单量", "净入库量", "类型", "状态", "审批时点(上海)", "首批录单时点(上海)", "正常全收录单时点(上海)", "全量净入库时点(上海)", "审批到首批录单天数", "审批到全量净入库天数", "加工段可评", "返单加工段20天内(非客户交付)", "证据缺口", "加工单", "收货单", "达到全量凭据"];
      return { total: result.rows.length, columns: fields.map((title, i) => ({ key: `c${i}`, title })),
        rows: result.rows.slice(0, cap).map(r => Object.fromEntries([r.woNo, r.supplierId, r.supplierName, r.skuCode, r.skuName, r.baseUom, r.orderQty, r.acceptedQty,
          r.orderType ? formatOrderType(r.orderType) : "未分类", DOC_STATUS_LABELS[r.status] ?? r.status, time(r.approvedAt), time(r.firstReceiptAt), time(r.normalFullAt), time(r.acceptedFullAt),
          r.firstReceiptDays, r.acceptedDays, r.eligible ? "是" : "否", r.within20Days === null ? "不可评/非返单" : r.within20Days ? "是" : "否", r.issues.join("；"), r.jgNos.join("；"), r.shNos.join("；"), r.fullShNos.join("；")].map((v, i) => [`c${i}`, v]))) };
    }
    const { listWip } = await import("./wip");
    const result = await listWip(query, db);
    const fields = ["加工单", "工单", "加工厂ID", "加工厂", "SKU", "成品", "单位", "订单量", "已检合格", "已检让步", "待正常收货", "超收", "发料行数", "状态", "交期", "在制", "逾期"];
    return { total: result.rows.length, columns: fields.map((title, i) => ({ key: `c${i}`, title })),
      rows: result.rows.slice(0, cap).map(r => Object.fromEntries([r.jgNo, r.woNo, r.supplierId, r.supplierName, r.productSkuCode, r.productName, r.baseUom, r.orderQty,
        r.receivedGood, r.receivedConcession, r.pendingQty, r.overReceivedQty, r.issuedMaterialLines, DOC_STATUS_LABELS[r.status] ?? r.status, r.dueDate, r.inWip ? "是" : "否", r.overdue ? "是" : "否"].map((v, i) => [`c${i}`, v]))) };
  },
};
