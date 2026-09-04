import { SENSITIVE_FIELDS } from "@/server/core/constants";
import { canSeePrices } from "@/server/core/dto";

/**
 * CSV 导出基础设施（W5）。
 * - UTF-8 带 BOM（Excel 直开不乱码）、CRLF 行结束、RFC4180 引号转义；
 * - decimal 字符串原样输出（禁 float 重格式化——CLAUDE.md）；
 * - 行数上限 EXPORT_ROW_CAP=50000：**仅异步导出任务用**（jobs/export-worker），命中后追加截断提示行；
 *   同步路由取的是 SYNC_EXPORT_MAX=5000——超过就转异步任务，因此同步路径永远不会截断。
 *   （2026-07-26 修：同步路由此前先按 50000 取数、再用 5000 判闸，多取的行直接丢弃，
 *   且随后的 `total > EXPORT_ROW_CAP` 分支恒为 false，是不可达代码。）
 * - 脱敏（R9 含导出）：canSeePrices=false 的用户，金额列**整列剔除**（非置空）。
 */

export const EXPORT_ROW_CAP = 50000;
export const TRUNCATION_ROW_TEXT = "……已达导出上限 50000 行，请缩小筛选范围";

export interface CsvColumn {
  key: string;
  title: string;
}

const SENSITIVE_SET: ReadonlySet<string> = new Set<string>(SENSITIVE_FIELDS);

/** maskSensitive 的列级等价物：非价格可见角色 → 剔除黑名单键对应的整列 */
export function stripMoneyColumns(columns: CsvColumn[], roles: string[]): CsvColumn[] {
  if (canSeePrices(roles)) return columns;
  return columns.filter((c) => !SENSITIVE_SET.has(c.key));
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else s = String(v);
  // 外部字段不可默认可信：阻止 Excel/Numbers 把 CSV 单元格解释为公式。
  // 真正的 number 以及合法负数字符串保持原样，避免破坏数量/decimal 口径。
  if (typeof v !== "number" && !(v instanceof Date)) {
    const firstNonSpace = s.search(/\S/);
    const candidate = firstNonSpace < 0 ? "" : s.slice(firstNonSpace);
    const isNegativeNumber = /^-[0-9]+(?:\.[0-9]+)?$/.test(candidate);
    if (/^[=+@]/.test(candidate) || (candidate.startsWith("-") && !isNegativeNumber)) {
      s = `'${s}`;
    }
  }
  // 含分隔符/引号/换行 → 引号包裹，内部引号加倍（RFC4180）
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** rows → CSV 文本：BOM + 标题行 + 数据行，CRLF；decimal 字符串逐字输出 */
export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
  const header = columns.map((c) => csvCell(c.title)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(","));
  return "\uFEFF" + [header, ...body].join("\r\n") + "\r\n";
}

/** 截断时在末尾追加提示行（占第一列） */
export function buildCsv(
  rows: Record<string, unknown>[],
  columns: CsvColumn[],
  opts?: { truncated?: boolean },
): string {
  const all = opts?.truncated && columns.length > 0
    ? [...rows, { [columns[0].key]: TRUNCATION_ROW_TEXT }]
    : rows;
  return toCsv(all, columns);
}

/** Content-Disposition：RFC5987 中文文件名 */
export function csvDisposition(nameCn: string): string {
  return `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(nameCn)}.csv`;
}

const SH_TZ_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

/** 业务时间列：Asia/Shanghai "YYYY-MM-DD HH:mm:ss"（sv-SE locale 恰为该格式） */
export function fmtShanghai(v: Date | string | null | undefined): string {
  if (v == null) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return SH_TZ_FMT.format(d);
}

/* ── 导出种类注册表（UAT 缺口 #4：同步路由与异步 worker 共享行生产器） ───────── */

import {
  COMMERCIAL_ROLE_LABELS,
  DOC_STATUS_LABELS, LEDGER_SOURCE_LABELS, STOCK_SUBTYPE_LABELS, WAREHOUSE_KIND_LABELS,
} from "@/components/labels";
import type { SessionUser } from "@/server/core/dto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 同步导出上限：超过即改走异步导出任务（CLAUDE.md：>5000 行走异步） */
export const SYNC_EXPORT_MAX = 5000;

export type ExportParams = Record<string, unknown>;

export interface ExportProduceResult {
  /** 已完成标签映射/时间格式化的行（列剥离由调用方按角色做） */
  rows: Record<string, unknown>[];
  columns: CsvColumn[];
  total: number;
}

export interface ExportKindDef {
  /** 文件名/UI 展示用中文名 */
  nameCn: string;
  /** 创建异步任务所需角色（undefined=任意登录用户；admin 恒兜底放行） */
  roles?: readonly string[];
  /** 同步路由查询串 → 任务 params（JSON 可序列化） */
  paramsFromSearch: (sp: URLSearchParams) => ExportParams;
  produce: (user: SessionUser, params: ExportParams, cap: number, db?: AnyDb) => Promise<ExportProduceResult>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export const EXPORT_KINDS: Record<string, ExportKindDef> = {
  balance: {
    nameCn: "库存余额",
    paramsFromSearch: (sp) => ({
      q: (sp.get("q") ?? "").trim(),
      warehouseId: Number(sp.get("warehouseId")) || undefined,
      nonzero: sp.get("nonzero") !== "0",
      commercialRole: sp.get("commercialRole") ?? undefined,
    }),
    async produce(_user, params, cap, db) {
      const { listBalances } = await import("@/server/modules/inventory/queries");
      const { rows, total } = await listBalances(
        {
          q: str(params.q) ?? "",
          warehouseId: num(params.warehouseId),
          nonzero: params.nonzero !== false,
          commercialRole: str(params.commercialRole),
          page: 1,
          pageSize: cap,
        },
        db,
      );
      const data = (rows as Record<string, unknown>[]).map((r) => ({
        ...r,
        warehouseKind: WAREHOUSE_KIND_LABELS[String(r.warehouseKind)] ?? r.warehouseKind,
        commercialRole: COMMERCIAL_ROLE_LABELS[String(r.commercialRole)] ?? r.commercialRole,
      }));
      return {
        rows: data,
        total,
        columns: [
          { key: "skuCode", title: "SKU编码" },
          { key: "skuName", title: "SKU名称" },
          { key: "commercialRole", title: "业务用途" },
          { key: "spuCode", title: "产品编码" },
          { key: "spuNameCn", title: "产品名称" },
          { key: "warehouseName", title: "仓库" },
          { key: "warehouseKind", title: "仓库类型" },
          { key: "batchId", title: "批次" },
          { key: "qty", title: "数量" },
          { key: "baseUom", title: "基础单位" },
        ],
      };
    },
  },

  /**
   * 盘点明细（带小样标注）——0727 会议行动项 #1 的交付物：
   * 「整理 7 月底盘点的小样库存数据，单独标注小样分类，提供给孙明」。
   * 按盘点期取单、按业务用途可筛，导出即可直接交付，不必再手工拼表。
   */
  countLines: {
    nameCn: "盘点明细",
    paramsFromSearch: (sp) => ({
      period: sp.get("period") ?? undefined,
      pdId: Number(sp.get("pdId")) || undefined,
      commercialRole: sp.get("commercialRole") ?? undefined,
    }),
    async produce(_user, params, cap, db) {
      const { listCountLinesForExport } = await import("@/server/modules/inventory/count");
      const { rows, total } = await listCountLinesForExport(
        {
          period: str(params.period),
          pdId: num(params.pdId),
          commercialRole: str(params.commercialRole),
          limit: cap,
        },
        db,
      );
      const data = (rows as Record<string, unknown>[]).map((r) => ({
        ...r,
        commercialRole: COMMERCIAL_ROLE_LABELS[String(r.commercialRole)] ?? r.commercialRole,
      }));
      return {
        rows: data,
        total,
        columns: [
          { key: "docNo", title: "盘点单号" },
          { key: "bizDate", title: "盘点期" },
          { key: "warehouseName", title: "仓库" },
          { key: "skuCode", title: "SKU编码" },
          { key: "skuName", title: "货品名称" },
          { key: "commercialRole", title: "业务用途" },
          { key: "baseUom", title: "单位" },
          { key: "bookQty", title: "账面数" },
          { key: "countedQty", title: "实盘数" },
          { key: "diffQty", title: "差异" },
        ],
      };
    },
  },

  ledger: {
    nameCn: "库存流水",
    paramsFromSearch: (sp) => ({
      skuId: Number(sp.get("skuId")) || undefined,
      warehouseId: Number(sp.get("warehouseId")) || undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
    }),
    async produce(user, params, cap, db) {
      const { listLedger } = await import("@/server/modules/inventory/queries");
      const { rows, total } = await listLedger(
        {
          skuId: num(params.skuId), warehouseId: num(params.warehouseId),
          from: str(params.from), to: str(params.to), page: 1, pageSize: cap,
          withValue: canSeePrices(user.roles),
        },
        db,
      );
      const data = (rows as unknown as Record<string, unknown>[]).map((r) => ({
        ...r,
        occurredAt: fmtShanghai(r.occurredAt as Date),
        sourceDocType: LEDGER_SOURCE_LABELS[String(r.sourceDocType)] ?? r.sourceDocType,
        sourceDocNo: r.sourceDocNo ?? `#${String(r.sourceDocId)}`,
      }));
      return {
        rows: data,
        total,
        /* amount/balanceAmount ∈ SENSITIVE_FIELDS → stripMoneyColumns 对非价格角色整列剔除（R9 含导出） */
        columns: [
          { key: "occurredAt", title: "时间" },
          { key: "skuCode", title: "SKU编码" },
          { key: "skuName", title: "SKU名称" },
          { key: "warehouseName", title: "仓库" },
          { key: "batchNo", title: "批次" },
          { key: "qtyDelta", title: "数量±" },
          { key: "balanceQty", title: "窗口累计余额" },
          { key: "amount", title: "金额" },
          { key: "balanceAmount", title: "累计余额金额" },
          { key: "sourceDocType", title: "来源类型" },
          { key: "sourceDocNo", title: "来源单号" },
          { key: "action", title: "动作" },
        ],
      };
    },
  },

  "stock-docs": {
    nameCn: "库存单据",
    paramsFromSearch: (sp) => ({
      q: (sp.get("q") ?? "").trim(),
      status: sp.get("status") ?? undefined,
      subtype: sp.get("subtype") ?? undefined,
    }),
    async produce(_user, params, cap, db) {
      const { listStockDocs } = await import("@/server/modules/inventory/stock-doc");
      const { rows, total } = await listStockDocs(
        str(params.q) ?? "",
        { status: str(params.status), subtype: str(params.subtype), page: 1, pageSize: cap },
        db,
      );
      const data = (rows as Record<string, unknown>[]).map((r) => ({
        ...r,
        subtype: STOCK_SUBTYPE_LABELS[String(r.subtype)] ?? r.subtype,
        status: DOC_STATUS_LABELS[String(r.status)] ?? r.status,
        createdAt: fmtShanghai(r.createdAt as Date),
      }));
      return {
        rows: data,
        total,
        columns: [
          { key: "docNo", title: "单据号" },
          { key: "subtype", title: "类型" },
          { key: "status", title: "状态" },
          { key: "warehouseName", title: "仓库" },
          { key: "toWarehouseName", title: "转入仓" },
          { key: "lineCount", title: "行数" },
          { key: "createdByName", title: "制单人" },
          { key: "createdAt", title: "创建时间" },
        ],
      };
    },
  },

  /* ── W2-4：重报表异步导出种类 ─────────────────────────────────────────────
     此前 EXPORT_KINDS 只登记了 5 个种类，一个报表页都没有；而风险处置 / 异动侦测 /
     库存分析三个页面的 CSV 页脚却写着「请缩小筛选范围，或改用「导出任务」」——
     指向一个根本创建不出来的任务。这四个种类就是那句话的兑现。 */

  risk: {
    nameCn: "风险库存处置",
    paramsFromSearch: (sp) => ({
      q: (sp.get("q") ?? "").trim(),
      action: sp.get("action") ?? undefined,
    }),
    async produce(user, params, cap, db) {
      const { getRiskWorklist } = await import("@/server/modules/report/risk");
      const { rows, total } = await getRiskWorklist(
        {
          q: str(params.q) ?? "",
          action: str(params.action),
          page: 1,
          pageSize: cap,
          precise: true, // 导出走全精度（E1-06）
          withValue: canSeePrices(user.roles),
        },
        db,
      );
      return {
        rows: rows as unknown as Record<string, unknown>[],
        total,
        columns: [
          { key: "action", title: "建议动作" },
          { key: "code", title: "SKU编码" },
          { key: "name", title: "名称" },
          { key: "brand", title: "品牌" },
          { key: "onHand", title: "在库" },
          { key: "amount", title: "在库金额" },
          { key: "atRiskAmount", title: "风险金额" },
          { key: "minDaysLeft", title: "最短剩余效期(天)" },
          { key: "nearExpiryDays", title: "临期阈值(天)" },
          { key: "expiredQty", title: "过期量" },
          { key: "nearQty", title: "阈值内到期量" },
          { key: "daily", title: "日均销" },
          { key: "cover", title: "可销天数" },
          { key: "palletRemark", title: "货盘注记" },
        ],
      };
    },
  },

  detectors: {
    nameCn: "异动侦测",
    paramsFromSearch: (sp) => ({
      q: (sp.get("q") ?? "").trim(),
      kind: sp.get("kind") ?? undefined,
    }),
    async produce(_user, params, cap, db) {
      const { getDetectorAlerts, DETECTOR_KINDS } = await import("@/server/modules/report/detectors");
      const rawKind = str(params.kind);
      const { rows, total } = await getDetectorAlerts(
        {
          q: str(params.q) ?? "",
          kind: DETECTOR_KINDS.includes(rawKind as never) ? (rawKind as never) : undefined,
          page: 1,
          pageSize: cap,
        },
        db,
      );
      const data = rows.map((r) => ({
        code: r.code,
        name: r.name,
        brand: r.brand,
        severity: r.severity,
        hitCount: r.hitCount,
        hits: r.hits.map((h) => h.title).join(" / "),
        detail: r.hits.map((h) => h.detail).join(" / "),
        onHand: r.onHand,
        lastQty: r.lastQty,
      }));
      return {
        rows: data,
        total,
        columns: [
          { key: "code", title: "SKU编码" },
          { key: "name", title: "名称" },
          { key: "brand", title: "品牌" },
          { key: "severity", title: "严重度" },
          { key: "hitCount", title: "命中条数" },
          { key: "hits", title: "命中侦测器" },
          { key: "detail", title: "命中说明" },
          { key: "onHand", title: "全网在库" },
          { key: "lastQty", title: "最近一期月销" },
        ],
      };
    },
  },

  "inventory-analytics": {
    nameCn: "库存分析",
    paramsFromSearch: (sp) => ({
      q: (sp.get("q") ?? "").trim(),
      windowDays: Number(sp.get("windowDays")) || undefined,
    }),
    async produce(_user, params, cap, db) {
      const { getInventoryAnalytics } = await import("@/server/modules/report/inventory-analytics");
      const { rows, total } = await getInventoryAnalytics(
        { q: str(params.q) ?? "", windowDays: num(params.windowDays), page: 1, pageSize: cap },
        db,
      );
      const data = rows.map((r) => ({
        code: r.code,
        name: r.name,
        brand: r.brand,
        onHand: r.onHand,
        daily: r.daily,
        daysCover: r.daysCover,
        outQty: r.outQty,
        turns: r.turns,
        dio: r.dio,
        avgAgeDays: r.avgAgeDays,
        unknownOriginQty: r.unknownOriginQty,
        cell: r.cell,
        abc: r.abc,
      }));
      return {
        rows: data,
        total,
        columns: [
          { key: "code", title: "SKU编码" },
          { key: "name", title: "名称" },
          { key: "brand", title: "品牌" },
          { key: "onHand", title: "全网在库" },
          { key: "daily", title: "日均销" },
          { key: "daysCover", title: "可销天数" },
          { key: "outQty", title: "窗口出库量" },
          { key: "turns", title: "年化周转次数" },
          { key: "dio", title: "周转天数DIO" },
          { key: "avgAgeDays", title: "加权平均库龄" },
          { key: "unknownOriginQty", title: "来源不明量" },
          { key: "cell", title: "ABC/XYZ" },
          { key: "abc", title: "ABC" },
        ],
      };
    },
  },

  segmentation: {
    nameCn: "库存分层 ABC/XYZ",
    paramsFromSearch: (sp) => ({
      q: (sp.get("q") ?? "").trim(),
      cell: sp.get("cell") ?? undefined,
      tier: sp.get("tier") ?? undefined,
      ownership: sp.get("ownership") ?? undefined,
    }),
    async produce(_user, params, cap, db) {
      const { getSegmentation } = await import("@/server/modules/report/segmentation");
      const { rows, total } = await getSegmentation(
        {
          q: str(params.q) ?? "",
          cell: str(params.cell),
          tier: str(params.tier),
          ownership: str(params.ownership),
          page: 1,
          pageSize: cap,
        },
        db,
      );
      const data = rows.map((r) => ({
        code: r.code,
        name: r.name,
        brand: r.brand,
        sales6m: r.sales6m,
        avgMonthly: r.avgMonthly,
        cv: r.cv,
        abc: r.abc,
        xyz: r.xyz,
        cell: r.cell,
        tier: r.tier,
        valueTier: r.valueTier ?? "insufficient",
        ownership: r.ownership,
        ownershipReason: r.ownershipReason,
        externalNet90: r.externalNet90,
      }));
      return {
        rows: data,
        total,
        columns: [
          { key: "code", title: "SKU编码" },
          { key: "name", title: "名称" },
          { key: "brand", title: "品牌" },
          { key: "sales6m", title: "近6月销量" },
          { key: "avgMonthly", title: "月均销量" },
          { key: "cv", title: "变异系数CV" },
          { key: "abc", title: "ABC" },
          { key: "xyz", title: "XYZ" },
          { key: "cell", title: "格" },
          { key: "tier", title: "四档分层" },
          { key: "valueTier", title: "金额口径分层(对照)" },
          { key: "ownership", title: "补货权责" },
          { key: "ownershipReason", title: "权责理由" },
          { key: "externalNet90", title: "外部近90天净需求" },
        ],
      };
    },
  },

  "settlement-summary": {
    nameCn: "结算汇总表",
    roles: ["purchasing", "pmc", "finance"], // = SETTLEMENT_SUMMARY_ROLES（service 内 requireAnyRole 仍是权威）
    paramsFromSearch: (sp) => ({
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      supplierId: Number(sp.get("supplierId")) || undefined,
      status: sp.get("status") ?? undefined,
    }),
    async produce(user, params, cap, db) {
      const { getSettlementSummary } = await import("@/server/modules/report/settlement-summary");
      const { docs } = await getSettlementSummary(
        user,
        { from: str(params.from), to: str(params.to), supplierId: num(params.supplierId), status: str(params.status) },
        db,
      );
      const total = docs.length;
      const data = (total > cap ? docs.slice(0, cap) : docs).map((d) => ({
        ...d,
        status: DOC_STATUS_LABELS[d.status] ?? d.status,
        createdAt: fmtShanghai(d.createdAt),
      }));
      return {
        rows: data,
        total,
        columns: [
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
        ],
      };
    },
  },
};

export const EXPORT_KIND_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(EXPORT_KINDS).map(([k, def]) => [k, def.nameCn]),
);
