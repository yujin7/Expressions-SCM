/**
 * ABC/XYZ 库存分层（只读报表层）。
 *
 * 单源（既有数据，不新增口径）：sales_monthly 近 6 月（窗口自 max(yearMonth) 动态回推，与 R11/风险表同法）。
 * - 分层范围：finished + active 成品 SKU（半成品/原料/包材不入销售分层）。
 * - ABC（销售贡献）：各 SKU 近6月总销量降序，按累计占比切分——A 累计前 80%，B 次 15%（80–95%），C 末 5%（95–100%）；零销量=C。
 * - XYZ（需求波动）：6 个月量的变异系数 CV=总体标准差/均值——X CV≤0.5 稳定，Y 0.5<CV≤1.0 中，Z CV>1.0 波动；零均值（无动销）=Z。
 * - cell = ABC+XYZ（AX…CZ），每格给出建议补货策略。
 * 全表无金额字段，免脱敏；只读不写库。
 */
import { inArray, eq, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { lastMonths } from "@/server/core/velocity";
import { classifyAbc } from "@/server/rules/abc";
import { num, r1 } from "@/server/core/svc";
import { salesWindow } from "@/server/core/sales-window";
import { participatesInNormalSalesMovement } from "@/server/rules/sku-standardization";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const r2 = (v: number): number => Math.round(v * 100) / 100;

export const SEG_CELLS = ["AX", "AY", "AZ", "BX", "BY", "BZ", "CX", "CY", "CZ"] as const;
export type SegCell = (typeof SEG_CELLS)[number];

/** 9 格建议补货策略（中文，只读建议） */
export const SEG_POLICY: Record<SegCell, string> = {
  AX: "高频精准补货·低安全库存（定期定量，优先保供）",
  AY: "核心且有波动·适度安全库存+滚动预测复核",
  AZ: "高价值波动大·加大安全库存+紧盯需求/缩短周期",
  BX: "稳定中值·经济批量补货，常规安全库存",
  BY: "中值波动·常规安全库存+定期复核订货量",
  BZ: "中值波动大·谨慎备货+缩短补货周期防积压",
  CX: "低值稳定·可批量低频补货，压库存成本",
  CY: "低值波动·按需补货，控制在库天数",
  CZ: "长尾波动·按需/停采评估，避免呆滞",
};

export interface SegRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  sales6m: number;
  avgMonthly: number;
  cv: number;
  abc: "A" | "B" | "C";
  xyz: "X" | "Y" | "Z";
  cell: SegCell;
}

export interface SegMatrixCell {
  count: number;
  /** 该格销量占近6月总销量的百分比（1dp） */
  salesShare: number;
}

export interface SegmentationResult {
  months: string[];
  rows: SegRow[];
  total: number;
  matrix: Record<SegCell, SegMatrixCell>;
  policy: Record<SegCell, string>;
}

function classifyXyz(quantities: number[], mean: number): "X" | "Y" | "Z" {
  if (mean <= 0) return "Z";
  const n = quantities.length;
  const variance = quantities.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n;
  const cv = Math.sqrt(variance) / mean;
  if (cv <= 0.5) return "X";
  if (cv <= 1.0) return "Y";
  return "Z";
}

function cvOf(quantities: number[], mean: number): number {
  if (mean <= 0) return 0;
  const n = quantities.length;
  const variance = quantities.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n;
  return Math.sqrt(variance) / mean;
}

export async function getSegmentation(
  query: { q?: string; cell?: string; page?: number; pageSize?: number; allRows?: boolean },
  dbArg?: AnyDb,
): Promise<SegmentationResult> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const page = Math.max(1, query.page ?? 1);
  // allRows：内部消费者（自动补货候选等）取全量，防静默截断；HTTP 层永不传 true
  const pageSize = query.allRows ? Number.MAX_SAFE_INTEGER : Math.min(500, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();
  const cellFilter = (query.cell ?? "").trim().toUpperCase();

  const emptyMatrix = (): Record<SegCell, SegMatrixCell> =>
    Object.fromEntries(SEG_CELLS.map((c) => [c, { count: 0, salesShare: 0 }])) as Record<SegCell, SegMatrixCell>;

  /* ── 近 6 月窗口（自 max(yearMonth) 回推） ── */
  const sm = schema.salesMonthly;
  const { maxYm } = await salesWindow(db);
  const months = maxYm ? lastMonths(maxYm, 6) : [];

  /* ── 成品主档（finished + active，且排除非销售用途——口径同驾驶舱/风险页） ── */
  const skuRowsRaw: { id: number; code: string; name: string; brand: string | null; commercialRole: string }[] = await db
    .select({
      id: schema.skus.id, code: schema.skus.code, name: schema.skus.name,
      brand: schema.brands.nameCn, commercialRole: schema.skus.commercialRole,
    })
    .from(schema.skus)
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .where(sql`${schema.skus.active} = true and ${schema.skus.skuType} = 'finished'`);
  // 样品/赠品/试用/内用不参与按销量的帕累托分层，否则会把"从来不卖"的品算成 C 类拖低基数。
  // 判定走共享规则，禁止在此本地重实现（口径漂移根因）。
  const skuRows = skuRowsRaw.filter((r) => participatesInNormalSalesMovement(r.commercialRole));
  if (skuRows.length === 0) {
    return { months, rows: [], total: 0, matrix: emptyMatrix(), policy: SEG_POLICY };
  }

  /* ── 近6月逐 SKU×月 销量（跨渠道汇总） ── */
  const salesRows: { skuId: number; ym: string; qty: string | null }[] = months.length
    ? await db
        .select({ skuId: sm.skuId, ym: sm.yearMonth, qty: sql<string | null>`sum(${sm.qty})` })
        .from(sm)
        .where(inArray(sm.yearMonth, months))
        .groupBy(sm.skuId, sm.yearMonth)
    : [];
  const qtyBySku = new Map<number, Map<string, number>>();
  for (const r of salesRows) {
    let m = qtyBySku.get(r.skuId);
    if (!m) { m = new Map(); qtyBySku.set(r.skuId, m); }
    m.set(r.ym, num(r.qty));
  }

  /* ── 逐 SKU 组装 6 月量、总量、均值、CV、XYZ ── */
  const interims: SegRow[] = [];
  let totalSales = 0;
  for (const sku of skuRows) {
    const m = qtyBySku.get(sku.id);
    const quantities = months.map((ym) => (m ? m.get(ym) ?? 0 : 0));
    const sales6m = quantities.reduce((a, b) => a + b, 0);
    const mean = months.length ? sales6m / months.length : 0;
    totalSales += sales6m;
    interims.push({
      skuId: sku.id,
      code: sku.code,
      name: sku.name,
      brand: sku.brand,
      sales6m: r2(sales6m),
      avgMonthly: r2(mean),
      cv: r2(cvOf(quantities, mean)),
      abc: "C",
      xyz: classifyXyz(quantities, mean),
      cell: "CZ",
    });
  }

  /* ── ABC：按 6 月总销量降序累计占比切分（80% / 95%） ── */
  interims.sort((a, b) => b.sales6m - a.sales6m);
  const abcByKey = classifyAbc(interims.map((it, i) => ({ id: i, qty: it.sales6m })));
  for (const [i, it] of interims.entries()) {
    it.abc = abcByKey.get(i) ?? "C";
    it.cell = `${it.abc}${it.xyz}` as SegCell;
  }

  /* ── 矩阵汇总（全量，不受筛选影响） ── */
  const matrix = emptyMatrix();
  for (const it of interims) {
    const c = matrix[it.cell];
    c.count += 1;
    c.salesShare += it.sales6m;
  }
  for (const c of SEG_CELLS) {
    matrix[c].salesShare = totalSales > 0 ? r1((matrix[c].salesShare / totalSales) * 100) : 0;
  }

  /* ── 筛选/排序/分页 ── */
  let filtered = interims;
  if (cellFilter) filtered = filtered.filter((r) => r.cell === cellFilter);
  if (q) filtered = filtered.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  filtered.sort((a, b) => b.sales6m - a.sales6m);
  return {
    months,
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    matrix,
    policy: SEG_POLICY,
  };
}
