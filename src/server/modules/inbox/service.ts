import { eq, inArray } from "drizzle-orm";
import {
  approvalConfigs, bhDocs, bhLines, ctDocs, flDocs, jgDocs, jsDocs, pcDocs, pdDocs,
  poDocs, shDocs, skus, stockDocs, suppliers, tlDocs, users, warehouses, woDocs,
} from "@/db/schema";

import type { AnyDb } from "@/server/docflow/doc-no";
import type { SessionUser } from "@/server/core/dto";
import { STOCK_SUBTYPE_LABELS } from "@/components/labels";
import { resolveDb } from "@/server/core/svc";

/**
 * 我的待办（inbox）：聚合所有等待「我」审批的单据 + 我提交的待审单据。
 * 审批域来源=approval_configs（单一权威，与 approveDoc 同口径）：
 *   角色含 approverRole 且 is_approver=true 方可审批；admin 全域可审。
 * 职责分离（SoD）：createdBy=我 的单据即便域匹配也审不了——归入「我提交的待审」。
 */

export const INBOX_DOC_TYPE_LABELS: Record<string, string> = {
  bh: "备货申请",
  wo: "委外工单",
  po: "采购订单",
  pc: "价格变更",
  jg: "加工通知",
  fl: "发料单",
  tl: "退料单",
  sh: "收货单",
  ct: "采购退货",
  js: "委外结算",
  stock_doc: "库存单据",
  pd: "盘点单",
};

/** 列表页跳转（现有列表客户端均不支持 open-by-id/?q 查询参数直达，故用纯页面路径） */
export const INBOX_PAGE_HREFS: Record<string, string> = {
  bh: "/outsource/bh",
  wo: "/outsource/wo",
  po: "/outsource/po",
  pc: "/outsource/pc",
  jg: "/outsource/jg",
  fl: "/matflow/fl",
  tl: "/matflow/tl",
  sh: "/matflow/sh",
  ct: "/matflow/ct",
  js: "/settlement/js",
  stock_doc: "/inventory/docs",
  pd: "/inventory/count",
};

export interface InboxItem {
  docType: string;
  docTypeLabel: string;
  id: number;
  docNo: string;
  title: string;
  createdByName: string | null;
  createdAt: Date;
  href: string;
  version: number;
}

export interface InboxResult {
  total: number; // 待我审批数（供头部角标复用）
  pending: InboxItem[]; // 待我审批
  submitted: InboxItem[]; // 我提交的待审
}

/** 内部行：带审批域与制单人（分组后剥离） */
type RawItem = InboxItem & { domain: string; createdBy: number };


/** 展示用数量：去掉 numeric(14,4) 的尾零（100.0000→100、2.5000→2.5） */
function fmtQty(v: string): string {
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}

function mk(
  docType: string,
  domain: string,
  r: { id: number; docNo: string; version: number; createdBy: number; createdAt: Date; createdByName: string | null },
  title: string,
  docTypeLabel?: string,
): RawItem {
  return {
    docType,
    docTypeLabel: docTypeLabel ?? INBOX_DOC_TYPE_LABELS[docType] ?? docType,
    id: r.id,
    docNo: r.docNo,
    title,
    createdByName: r.createdByName,
    createdAt: r.createdAt,
    href: INBOX_PAGE_HREFS[docType] ?? "/",
    version: r.version,
    domain,
    createdBy: r.createdBy,
  };
}

/* ── 各单据源（均取 status='pending'；title=对方/品名摘要） ── */

async function collectBh(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: bhDocs.id, docNo: bhDocs.docNo, version: bhDocs.version,
      createdBy: bhDocs.createdBy, createdAt: bhDocs.createdAt, createdByName: users.name,
    })
    .from(bhDocs)
    .leftJoin(users, eq(bhDocs.createdBy, users.id))
    .where(eq(bhDocs.status, "pending"));
  if (rows.length === 0) return [];
  const lines = await db
    .select({ bhId: bhLines.bhId, qty: bhLines.qty, skuName: skus.name })
    .from(bhLines)
    .innerJoin(skus, eq(bhLines.skuId, skus.id))
    .where(inArray(bhLines.bhId, rows.map((r) => r.id)))
    .orderBy(bhLines.id);
  return rows.map((r) => {
    const mine = lines.filter((l) => l.bhId === r.id);
    const first = mine[0];
    const title = first
      ? `${first.skuName}×${fmtQty(first.qty)}${mine.length > 1 ? ` 等${mine.length}项` : ""}`
      : "（无明细）";
    return mk("bh", "bh", r, title);
  });
}

async function collectWo(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: woDocs.id, docNo: woDocs.docNo, version: woDocs.version,
      createdBy: woDocs.createdBy, createdAt: woDocs.createdAt, createdByName: users.name,
      qty: woDocs.qty, skuName: skus.name, supplierName: suppliers.name,
    })
    .from(woDocs)
    .innerJoin(skus, eq(woDocs.productSkuId, skus.id))
    .innerJoin(suppliers, eq(woDocs.supplierId, suppliers.id))
    .leftJoin(users, eq(woDocs.createdBy, users.id))
    .where(eq(woDocs.status, "pending"));
  return rows.map((r) => mk("wo", "wo", r, `${r.supplierName}·${r.skuName}×${fmtQty(r.qty)}`));
}

async function collectPo(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: poDocs.id, docNo: poDocs.docNo, version: poDocs.version,
      createdBy: poDocs.createdBy, createdAt: poDocs.createdAt, createdByName: users.name,
      supplierName: suppliers.name,
    })
    .from(poDocs)
    .innerJoin(suppliers, eq(poDocs.supplierId, suppliers.id))
    .leftJoin(users, eq(poDocs.createdBy, users.id))
    .where(eq(poDocs.status, "pending"));
  return rows.map((r) => mk("po", "po", r, r.supplierName));
}

async function collectPc(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: pcDocs.id, docNo: pcDocs.docNo, version: pcDocs.version,
      createdBy: pcDocs.createdBy, createdAt: pcDocs.createdAt, createdByName: users.name,
      target: pcDocs.target,
    })
    .from(pcDocs)
    .leftJoin(users, eq(pcDocs.createdBy, users.id))
    .where(eq(pcDocs.status, "pending"));
  return rows.map((r) =>
    mk("pc", "pc", r, r.target === "jg_fee" ? "加工费价格变更" : "采购行价格变更"),
  );
}

async function collectJg(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: jgDocs.id, docNo: jgDocs.docNo, version: jgDocs.version,
      createdBy: jgDocs.createdBy, createdAt: jgDocs.createdAt, createdByName: users.name,
      qty: jgDocs.qty, skuName: skus.name, supplierName: suppliers.name,
    })
    .from(jgDocs)
    .innerJoin(skus, eq(jgDocs.productSkuId, skus.id))
    .innerJoin(suppliers, eq(jgDocs.supplierId, suppliers.id))
    .leftJoin(users, eq(jgDocs.createdBy, users.id))
    .where(eq(jgDocs.status, "pending"));
  return rows.map((r) => mk("jg", "jg", r, `${r.supplierName}·${r.skuName}×${fmtQty(r.qty)}`));
}

/** FL/TL 共用：从仓→至仓 摘要 */
async function collectWarehouseFlow(
  db: AnyDb,
  docType: "fl" | "tl",
): Promise<RawItem[]> {
  const t = docType === "fl" ? flDocs : tlDocs;
  const fromWh = db.select({ id: warehouses.id, name: warehouses.name }).from(warehouses).as("from_wh");
  const toWh = db.select({ id: warehouses.id, name: warehouses.name }).from(warehouses).as("to_wh");
  const rows = await db
    .select({
      id: t.id, docNo: t.docNo, version: t.version,
      createdBy: t.createdBy, createdAt: t.createdAt, createdByName: users.name,
      fromName: fromWh.name, toName: toWh.name,
    })
    .from(t)
    .innerJoin(fromWh, eq(t.fromWarehouseId, fromWh.id))
    .innerJoin(toWh, eq(t.toWarehouseId, toWh.id))
    .leftJoin(users, eq(t.createdBy, users.id))
    .where(eq(t.status, "pending"));
  return rows.map((r) => mk(docType, docType, r, `${r.fromName}→${r.toName}`));
}

async function collectSh(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: shDocs.id, docNo: shDocs.docNo, version: shDocs.version,
      createdBy: shDocs.createdBy, createdAt: shDocs.createdAt, createdByName: users.name,
      sourceType: shDocs.sourceType, warehouseName: warehouses.name,
    })
    .from(shDocs)
    .innerJoin(warehouses, eq(shDocs.warehouseId, warehouses.id))
    .leftJoin(users, eq(shDocs.createdBy, users.id))
    .where(eq(shDocs.status, "pending"));
  return rows.map((r) =>
    mk("sh", "sh", r, `${r.sourceType === "po" ? "采购收货" : "委外收货"}·${r.warehouseName}`),
  );
}

async function collectCt(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: ctDocs.id, docNo: ctDocs.docNo, version: ctDocs.version,
      createdBy: ctDocs.createdBy, createdAt: ctDocs.createdAt, createdByName: users.name,
      poDocNo: poDocs.docNo, warehouseName: warehouses.name,
    })
    .from(ctDocs)
    .innerJoin(poDocs, eq(ctDocs.poId, poDocs.id))
    .innerJoin(warehouses, eq(ctDocs.warehouseId, warehouses.id))
    .leftJoin(users, eq(ctDocs.createdBy, users.id))
    .where(eq(ctDocs.status, "pending"));
  return rows.map((r) => mk("ct", "ct", r, `退 ${r.poDocNo}·${r.warehouseName}`));
}

async function collectJs(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: jsDocs.id, docNo: jsDocs.docNo, version: jsDocs.version,
      createdBy: jsDocs.createdBy, createdAt: jsDocs.createdAt, createdByName: users.name,
      jgDocNo: jgDocs.docNo, supplierName: suppliers.name,
    })
    .from(jsDocs)
    .innerJoin(jgDocs, eq(jsDocs.jgId, jgDocs.id))
    .innerJoin(suppliers, eq(jgDocs.supplierId, suppliers.id))
    .leftJoin(users, eq(jsDocs.createdBy, users.id))
    .where(eq(jsDocs.status, "pending"));
  return rows.map((r) => mk("js", "js", r, `${r.supplierName}·${r.jgDocNo}`));
}

async function collectStockDocs(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: stockDocs.id, docNo: stockDocs.docNo, version: stockDocs.version,
      createdBy: stockDocs.createdBy, createdAt: stockDocs.createdAt, createdByName: users.name,
      subtype: stockDocs.subtype,
    })
    .from(stockDocs)
    .leftJoin(users, eq(stockDocs.createdBy, users.id))
    .where(eq(stockDocs.status, "pending"));
  return rows.map((r) => {
    // 审批域映射与 approveStockDoc 同口径：期初→opening、盘点调整→count（财务），其余=stock_doc（仓管）
    const domain = r.subtype === "opening" ? "opening" : r.subtype === "count_adjust" ? "count" : "stock_doc";
    const subtypeLabel = STOCK_SUBTYPE_LABELS[r.subtype] ?? r.subtype;
    return mk("stock_doc", domain, r, subtypeLabel, `库存·${subtypeLabel}`);
  });
}

async function collectPd(db: AnyDb): Promise<RawItem[]> {
  const rows = await db
    .select({
      id: pdDocs.id, docNo: pdDocs.docNo, version: pdDocs.version,
      createdBy: pdDocs.createdBy, createdAt: pdDocs.createdAt, createdByName: users.name,
      mode: pdDocs.mode, warehouseName: warehouses.name,
    })
    .from(pdDocs)
    .innerJoin(warehouses, eq(pdDocs.warehouseId, warehouses.id))
    .leftJoin(users, eq(pdDocs.createdBy, users.id))
    .where(eq(pdDocs.status, "pending"));
  // 盘点单审批域=count（财务，见 count.ts approveCountTask）
  return rows.map((r) => mk("pd", "count", r, `${r.warehouseName}·${r.mode === "full" ? "全盘" : "抽盘"}`));
}

function strip(items: RawItem[]): InboxItem[] {
  return items.map(({ domain: _d, createdBy: _c, ...rest }) => rest);
}

export async function getInbox(user: SessionUser, dbArg?: AnyDb): Promise<InboxResult> {
  const db = await resolveDb(dbArg);

  // 我可审批的域集合（approval_configs 单一权威；admin=全域；非审批人=空集）
  const cfgs = await db
    .select({ docType: approvalConfigs.docType, approverRole: approvalConfigs.approverRole })
    .from(approvalConfigs);
  const isAdmin = user.roles.includes("admin");
  const myDomains = new Set<string>();
  for (const c of cfgs) {
    if (isAdmin || (user.isApprover && user.roles.includes(c.approverRole))) myDomains.add(c.docType);
  }

  const all = (
    await Promise.all([
      collectBh(db),
      collectWo(db),
      collectPo(db),
      collectPc(db),
      collectJg(db),
      collectWarehouseFlow(db, "fl"),
      collectWarehouseFlow(db, "tl"),
      collectSh(db),
      collectCt(db),
      collectJs(db),
      collectStockDocs(db),
      collectPd(db),
    ])
  ).flat();

  // 最早提交的排最前
  all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);

  // SoD：我创建的单据即便审批域匹配也不能自审——单列「我提交的待审」
  const submitted = all.filter((i) => i.createdBy === user.id);
  const pending = all.filter((i) => i.createdBy !== user.id && myDomains.has(i.domain));

  return { total: pending.length, pending: strip(pending), submitted: strip(submitted) };
}
