import type { CsvColumn, ExportKindDef } from "./export";
import type { SupplierLifecycleRow, SupplierTermSnapshot } from "../master/supplier-lifecycle";
import { supplierLifecycleFilterSchema } from "../master/supplier-lifecycle-query";
import { ApiError } from "../master/common";
import { optionalIntegerQuery } from "@/server/core/query-number";
import { requireAnyRole } from "../outsource/common";
import { shanghaiTimestampOf } from "@/server/core/business-day";

const ROLES = ["purchasing", "pmc", "finance"] as const;
const IDS = ["supplierId", "caseId", "ownerId"] as const;
const TEXT = ["q", "status", "kind", "sort", "order"] as const;

function fromSearch(sp: URLSearchParams) {
  const values: Record<string, unknown> = {};
  for (const key of sp.keys()) {
    if (key === "page" || key === "pageSize") continue;
    if (![...IDS, ...TEXT].includes(key as typeof IDS[number] | typeof TEXT[number])) throw new ApiError(400, "未知供应商工作项筛选");
    if (sp.getAll(key).length !== 1) throw new ApiError(400, "供应商工作项筛选不能重复传入");
  }
  for (const key of IDS) {
    const value = optionalIntegerQuery(sp, key, { label: key });
    if (value != null) values[key] = value;
  }
  for (const key of TEXT) if (sp.has(key)) values[key] = sp.get(key);
  return supplierLifecycleFilterSchema.parse(values);
}

const FIELDS = [
  ["id", "工作项ID"], ["supplierCode", "供应商编码"], ["supplierName", "供应商名称"],
  ["kind", "类型"], ["status", "状态"], ["priority", "优先级"], ["ownerName", "责任人"],
  ["dueDate", "截止日"], ["overdue", "已逾期"], ["reason", "完整发起依据"], ["progressNote", "最新跟进（非完整审计历史）"],
  ["targetCreditDays", "目标账期天数"], ["baselineType", "基线账期类型"], ["baselineDays", "基线账期天数"],
  ["baselineFrom", "基线生效日"], ["baselineText", "基线条款原文"],
  ["currentType", "主档当前登记类型（不代表已生效）"], ["currentDays", "主档当前登记天数"],
  ["currentFrom", "主档登记生效日"], ["currentText", "主档条款原文"], ["termChanged", "进行中谈判基线已变化"],
  ["agreementDays", "协议账期天数"], ["agreementFrom", "协议生效日"], ["agreementText", "完整协议条款"], ["evidenceRef", "协议凭据"],
  ["outcome", "结果"], ["closureNote", "完整关案依据"], ["pauseNewOrders", "本项要求暂停新单"],
  ["supplierStatusBefore", "发起前供应商状态"], ["supplierStatusAfter", "工作项记录的供应商状态"],
  ["supplierStatus", "供应商当前状态"], ["createdBy", "发起人ID"], ["createdAt", "发起时间（上海）"],
  ["closedBy", "关案人ID"], ["closedAt", "关案时间（上海）"], ["version", "记录版本"],
] as const;
export const SUPPLIER_LIFECYCLE_COLUMNS: CsvColumn[] = FIELDS.map(([key, title]) => ({ key, title }));
const kinds: Record<string, string> = { admission: "准入", corrective: "整改", payment_term: "账期谈判" };
const statuses: Record<string, string> = { pending: "待准入", qualified: "合格", paused: "暂停", blacklisted: "黑名单" };
const termTypes: Record<string, string> = { monthly_credit: "月结", on_delivery: "款到发货", prepay: "预付" };
function termColumns(prefix: string, term: SupplierTermSnapshot | null) {
  return { [`${prefix}Type`]: term?.paymentTermType ? termTypes[term.paymentTermType] ?? term.paymentTermType : "未知",
    [`${prefix}Days`]: term?.creditDays ?? null, [`${prefix}From`]: term?.paymentTermEffectiveFrom ?? null, [`${prefix}Text`]: term?.paymentTerm ?? null };
}
function exportRow(r: SupplierLifecycleRow): Record<string, unknown> {
  // Explicit allow-list: never spread a supplier record or arbitrary audit JSON into a file.
  return {
    id: r.id, supplierCode: r.supplierCode, supplierName: r.supplierName, kind: kinds[r.kind],
    status: r.status === "open" ? "进行中" : "已关闭", priority: { normal: "普通", high: "高", critical: "紧急" }[r.priority],
    ownerName: r.ownerName, dueDate: r.dueDate, overdue: r.overdue ? "是" : "否", reason: r.reason, progressNote: r.progressNote,
    targetCreditDays: r.targetCreditDays, ...termColumns("baseline", r.termBaseline), ...termColumns("current", r.termCurrent),
    termChanged: r.kind === "payment_term" ? r.termChanged ? "是" : "否" : "不适用",
    agreementDays: r.termAgreement?.creditDays ?? null, agreementFrom: r.termAgreement?.effectiveFrom ?? null,
    agreementText: r.termAgreement?.paymentTerm ?? null, evidenceRef: r.termAgreement?.evidenceRef ?? null,
    outcome: r.outcome == null ? null : ({ approved: "通过", rejected: "未通过", resolved: r.kind === "payment_term" ? "达成协议" : "已整改", failed: "未达成" } as Record<string, string>)[r.outcome] ?? r.outcome,
    closureNote: r.closureNote, pauseNewOrders: r.pauseNewOrders ? "是" : "否",
    supplierStatusBefore: statuses[r.supplierStatusBefore] ?? r.supplierStatusBefore,
    supplierStatusAfter: statuses[r.supplierStatusAfter] ?? r.supplierStatusAfter, supplierStatus: statuses[r.supplierStatus] ?? r.supplierStatus,
    createdBy: r.createdBy, createdAt: shanghaiTimestampOf(r.createdAt), closedBy: r.closedBy,
    closedAt: r.closedAt == null ? null : shanghaiTimestampOf(r.closedAt), version: r.version,
  };
}

export const supplierLifecycleExport: ExportKindDef = {
  nameCn: "供应商工作项", roles: ROLES, paramsFromSearch: fromSearch,
  async produce(user, params, cap, db) {
    requireAnyRole(user, ...ROLES);
    const query = supplierLifecycleFilterSchema.parse(params);
    const { exportSupplierLifecycleCases } = await import("../master/supplier-lifecycle");
    const result = await exportSupplierLifecycleCases(query, cap, db);
    return { rows: result.rows.map(exportRow), columns: SUPPLIER_LIFECYCLE_COLUMNS, total: result.total };
  },
};
