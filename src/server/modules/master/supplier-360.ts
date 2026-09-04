/**
 * 供应商 360（只读装配层）：主数据页每行旁边的「这家供应商到底怎么样」。
 *
 * 不新增任何口径——四个既有读模型各取该供应商那一行并排摆出来：
 * - 记分卡 `report/supplier-scorecard`：OTIF（准时率）× 质检 × 价格异动 → 综合分与建议等级；
 * - 采购订单指标 `report/purchase-order-metrics.bySupplier`：已下单量、订单至交付周期、OTIF、降本；
 * - 账期候选 `report/supplier-payment-term`：账期类型 / 达成 / 采购额名次；
 * - 历史交期观察 `report/supplier-lead-history`：简道云历史订单→入库交期分布（authority=observation_only，只看不改）。
 *
 * 金额：账期看板与采购指标各自的 strip*Money 按角色剥离（PRICE_VISIBLE_ROLES），路由再过 maskSensitive；
 * 主数据行不选 bankAccount（敏感）——本页不需要银行账户。
 */
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { getSupplierScorecard, type ScorecardRow } from "@/server/modules/report/supplier-scorecard";
import {
  loadSupplierPaymentTerm, stripSupplierPaymentTermMoney, type SupplierPaymentTermRow,
} from "@/server/modules/report/supplier-payment-term";
import { loadSupplierLeadHistory, type SupplierLeadHistoryRow } from "@/server/modules/report/supplier-lead-history";
import {
  loadPurchaseOrderMetrics, stripPurchaseOrderMoney, type PoSupplierRow,
} from "@/server/modules/report/purchase-order-metrics";

export interface Supplier360 {
  supplier: {
    id: number;
    code: string;
    name: string;
    kinds: string[];
    status: string;
    level: string | null;
    paymentTerm: string | null;
    paymentTermType: string | null;
    creditDays: number | null;
    paymentTermEffectiveFrom: string | null;
    declaredMonthlyCapacity: string | null;
    capacityUom: string | null;
  };
  /** 记分卡该供应商行（窗口内无信号 = null，不是 0 分） */
  scorecard: { windowDays: number; minSamples: number; row: ScorecardRow | null };
  /** 采购订单指标该供应商行（当年无已下单 PO = null） */
  purchaseOrders: { year: number; asOf: string; moneyVisible: boolean; row: PoSupplierRow | null };
  /** 账期候选该供应商行（无采购额 = null） */
  paymentTerm: { asOf: string; year: number; moneyVisible: boolean; row: SupplierPaymentTermRow | null };
  /** 历史交期观察：observation_only——只观察、不改主数据、不改阈值 */
  leadHistory: {
    authority: "observation_only";
    source: string;
    state: "ready" | "insufficient";
    sourceAsOf: string | null;
    minSamples: number;
    row: SupplierLeadHistoryRow | null;
  };
  links: { scorecard: string; purchaseOrders: string; paymentTerm: string; leadHistory: string; lifecycle: string };
}

export async function getSupplier360(id: number, roles: string[], dbArg?: AnyDb): Promise<Supplier360> {
  const db = await resolveDb(dbArg);
  const s = schema.suppliers;
  const [supplier] = await db
    .select({
      id: s.id, code: s.code, name: s.name, kinds: s.kinds, status: s.status, level: s.level,
      paymentTerm: s.paymentTerm, paymentTermType: s.paymentTermType, creditDays: s.creditDays,
      paymentTermEffectiveFrom: s.paymentTermEffectiveFrom,
      declaredMonthlyCapacity: s.declaredMonthlyCapacity, capacityUom: s.capacityUom,
    })
    .from(s)
    .where(eq(s.id, id));
  if (!supplier) throw new ApiError(404, "供应商不存在");

  const [scorecard, poMetrics, paymentTerm, leadHistory] = await Promise.all([
    getSupplierScorecard({ q: supplier.code, page: 1, pageSize: 50 }, db),
    loadPurchaseOrderMetrics({}, db),
    loadSupplierPaymentTerm(db),
    loadSupplierLeadHistory(db),
  ]);
  const po = stripPurchaseOrderMoney(poMetrics, roles);
  const pt = stripSupplierPaymentTermMoney(paymentTerm, roles);
  const codeQ = encodeURIComponent(supplier.code);

  return {
    supplier: {
      ...supplier,
      kinds: (supplier.kinds ?? []) as string[],
      level: supplier.level ?? null,
      paymentTerm: supplier.paymentTerm ?? null,
      paymentTermType: supplier.paymentTermType ?? null,
      creditDays: supplier.creditDays ?? null,
      paymentTermEffectiveFrom: supplier.paymentTermEffectiveFrom ?? null,
      declaredMonthlyCapacity: supplier.declaredMonthlyCapacity == null ? null : String(supplier.declaredMonthlyCapacity),
      capacityUom: supplier.capacityUom ?? null,
    },
    scorecard: {
      windowDays: scorecard.summary.windowDays,
      minSamples: scorecard.minSamples,
      row: scorecard.rows.find((r) => r.supplierId === id) ?? null,
    },
    purchaseOrders: {
      year: po.year,
      asOf: po.asOf,
      moneyVisible: po.moneyVisible,
      row: po.bySupplier.find((r) => r.supplierId === id) ?? null,
    },
    paymentTerm: {
      asOf: pt.asOf,
      year: pt.year,
      moneyVisible: pt.moneyVisible,
      row: pt.rows.find((r) => r.supplierId === id) ?? null,
    },
    leadHistory: {
      authority: "observation_only",
      source: leadHistory.source,
      state: leadHistory.state,
      sourceAsOf: leadHistory.sourceAsOf,
      minSamples: leadHistory.minSamples,
      row: leadHistory.bySupplier.find((r) => r.supplierId === id) ?? null,
    },
    links: {
      scorecard: `/report/supplier-scorecard?sc_q=${codeQ}`,
      purchaseOrders: "/report/purchase-orders",
      paymentTerm: `/report/supplier-scorecard?tab=term&pt_q=${codeQ}`,
      leadHistory: `/report/supplier-scorecard?tab=lead-history&lh_q=${codeQ}`,
      lifecycle: `/master/supplier/lifecycle?supplierId=${id}`,
    },
  };
}
