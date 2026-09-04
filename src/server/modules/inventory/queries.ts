import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import {
  batches, ctDocs, flDocs, jsDocs, shDocs, skus, spus, stockBalances, stockDocs, stockLedger,
  tlDocs, warehouses,
} from "@/db/schema";
import type { AnyDb } from "@/server/posting/post";
import { dMul, dQty } from "@/server/core/decimal";
import { resolveDb } from "@/server/core/svc";
import { resolveUnitCosts } from "@/server/core/valuation";
import { LEDGER_SOURCE_TARGETS, ledgerSourceHref, type LedgerSourceTable } from "@/lib/ledger-source-docs";
import { createdWithinShanghaiDays } from "@/server/core/doc-search";


/** SKU×仓库×批次 余额（实时仓口径；快照仓 1.1 并入）。nonzero 默认 true=隐藏零余额行 */
export async function listBalances(
  opts: {
    q?: string;
    warehouseId?: number;
    nonzero?: boolean;
    /** 业务用途筛选（0727 会议：小样要能单独查库存明细）。 */
    commercialRole?: string;
    page: number;
    pageSize: number;
  },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.nonzero !== false) conds.push(sql`${stockBalances.qty} <> 0`);
  if (opts.warehouseId) conds.push(eq(stockBalances.warehouseId, opts.warehouseId));
  // 能筛小样的地方（SKU 主档）没有库存数量，有库存数量的地方没有业务用途——
  // M-22 说的「输入=小样、输出=库存明细」此前无处可做，这里补上入口。
  if (opts.commercialRole) conds.push(eq(skus.commercialRole, opts.commercialRole));
  if (opts.q) {
    conds.push(
      or(
        ilike(skus.code, `%${opts.q}%`),
        ilike(skus.name, `%${opts.q}%`),
        ilike(spus.nameCn, `%${opts.q}%`),
        ilike(batches.batchNo, `%${opts.q}%`),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        skuId: skus.id,
        skuCode: skus.code,
        skuName: skus.name,
        baseUom: skus.baseUom,
        commercialRole: skus.commercialRole,
        spuCode: spus.code,
        spuNameCn: spus.nameCn,
        warehouseId: warehouses.id,
        warehouseName: warehouses.name,
        warehouseKind: warehouses.kind,
        batchId: stockBalances.batchId,
        batchNo: batches.batchNo,
        batchExpiryDate: batches.expiryDate,
        qty: stockBalances.qty,
      })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .innerJoin(warehouses, eq(stockBalances.warehouseId, warehouses.id))
      .leftJoin(batches, eq(stockBalances.batchId, batches.id))
      .where(where)
      .orderBy(skus.code, warehouses.code, stockBalances.batchId)
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .innerJoin(warehouses, eq(stockBalances.warehouseId, warehouses.id))
      .leftJoin(batches, eq(stockBalances.batchId, batches.id))
      .where(where),
  ]);
  return { rows, total };
}

/**
 * SPU 口径汇总（R3 报表归集）。跨仓合计；仅同基础单位的产品数量相加才有业务意义
 * （单位混合风险已知，UI 注明）。
 */
export async function listBalancesBySpu(
  opts: { q?: string; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.q) conds.push(or(ilike(spus.code, `%${opts.q}%`), ilike(spus.nameCn, `%${opts.q}%`)));
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        spuId: spus.id,
        spuCode: spus.code,
        spuNameCn: spus.nameCn,
        totalQty: sql<string>`sum(${stockBalances.qty})`,
        skuCount: sql<number>`count(distinct ${skus.id})::int`,
      })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .where(where)
      .groupBy(spus.id, spus.code, spus.nameCn)
      .orderBy(spus.code)
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db
      .select({ total: sql<number>`count(distinct ${spus.id})::int` })
      .from(stockBalances)
      .innerJoin(skus, eq(stockBalances.skuId, skus.id))
      .innerJoin(spus, eq(skus.spuId, spus.id))
      .where(where),
  ]);
  return { rows, total };
}

/** 库存流水（唯一事实源，仅追加）分页查询 */
export interface LedgerRow {
  id: number;
  occurredAt: Date;
  skuId: number;
  skuCode: string;
  skuName: string;
  warehouseId: number;
  warehouseName: string;
  batchId: number | null;
  batchNo: string | null;
  qtyDelta: string;
  /** 该 (SKU, 仓库) 在**筛选窗口内**截至本行的累计余额（SQL 窗口函数算，非浏览器端累加） */
  balanceQty: string;
  sourceDocType: string;
  sourceDocId: number;
  /** 来源单号（解析失败为 null——不编造） */
  sourceDocNo: string | null;
  /** 来源单据页链接；无单号即 null */
  sourceHref: string | null;
  action: string;
  /** 本行金额 = 数量 × 单位成本（core/valuation）；无成本 → null。SENSITIVE_FIELDS 收录 amount */
  amount?: string | null;
  /**
   * 窗口内累计余额金额 = `balanceQty` x **今日**单位成本（见 `LEDGER_MONEY_CALIBRE.balanceBasis`）。
   * 三件事必须和这个数一起出现，否则它会被当成「当时的库存价值」：
   *  1. `balanceQty` 只在**当前筛选窗口内**累计，不是该 (SKU,仓) 的历史全量余额——窗口起点之前的
   *     出入库不参与，因此这个数可以是负的；
   *  2. 单位成本是**取数当刻**的成本，不是每一行发生当时的成本（系统没有逐行历史成本）；
   *  3. 无成本 -> null（不是 0）。SENSITIVE_FIELDS 收录 balanceAmount。
   */
  balanceAmount?: string | null;
}

/**
 * 流水金额口径（唯一文案权威；出处守卫 `tests/report/calibre-provenance-guard.test.ts` 认 `key`）。
 * 前端不得另写一份——一个可以为负、又没有成本基准日的金额列，没有这段话就是错的。
 */
export const LEDGER_MONEY_CALIBRE_KEY = "ledger-money/v1";
export const LEDGER_MONEY_CALIBRE = {
  key: LEDGER_MONEY_CALIBRE_KEY,
  costSource: "单位成本：core/valuation.resolveUnitCosts（sku_costs 优先，缺则财务运营成本观察）；两者皆无则金额为空，不是 0 元",
  amountBasis: "本行金额 = 本行数量变动 x 单位成本（入库为正、出库为负）",
  balanceBasis: "累计余额金额 = 窗口内累计余额 x 单位成本",
  windowNote: "累计余额只在**当前筛选窗口内**累加（窗口起点之前的出入库不参与），因此它不是该 SKU/仓的历史全量余额，**可以为负**——负值表示这段窗口里出多于进，不表示库存为负。",
  costAsOfNote: "单位成本是**取数当刻**的成本，不是每一行发生当时的历史成本（系统不保存逐行历史成本）；因此该列是「按今天的成本重估这段窗口的净流量」，不是当时的库存价值。",
} as const;

const LEDGER_SOURCE_TABLES = {
  stock_docs: stockDocs,
  fl_docs: flDocs,
  tl_docs: tlDocs,
  sh_docs: shDocs,
  ct_docs: ctDocs,
  js_docs: jsDocs,
} as const;

/** 逐来源表批量解析单号（每页最多 6 次查询；解析不到的行 docNo=null） */
async function resolveSourceDocNos(
  db: AnyDb,
  rows: { sourceDocType: string; sourceDocId: number }[],
): Promise<Map<string, string>> {
  const byTable = new Map<LedgerSourceTable, Set<number>>();
  for (const r of rows) {
    const target = LEDGER_SOURCE_TARGETS[r.sourceDocType];
    if (!target) continue;
    const set = byTable.get(target.table) ?? new Set<number>();
    set.add(r.sourceDocId);
    byTable.set(target.table, set);
  }
  const out = new Map<string, string>();
  await Promise.all(
    [...byTable.entries()].map(async ([tableKey, ids]) => {
      const table = LEDGER_SOURCE_TABLES[tableKey];
      const found: { id: number; docNo: string }[] = await db
        .select({ id: table.id, docNo: table.docNo })
        .from(table)
        .where(inArray(table.id, [...ids]));
      for (const row of found) out.set(`${tableKey}:${row.id}`, row.docNo);
    }),
  );
  return out;
}


/**
 * 库存流水清单（D-W2-2）。
 *
 * 三个此前缺失、但流水页离了就没法用的东西：
 * 1. **批次**：`stock_ledger.batch_id` 一直有，页面从不显示——召回时最要紧的一列；
 * 2. **窗口内累计余额**：`sum(qty_delta) over (partition by sku,仓 order by 时间,id)`，
 *    在 **SQL 里**按排序窗口算，再对结果分页。浏览器端累加只能对当前这一页，翻页即错；
 * 3. **金额**：`core/valuation` 唯一权威解析单位成本（数量 × 单位成本），
 *    `amount`/`balanceAmount` 进 SENSITIVE_FIELDS，非价格角色由 maskSensitive 剥离。
 *
 * `withValue=false`（默认）完全不查成本，非价格角色连一次成本查询都不会发生。
 */
export async function listLedger(
  opts: {
    skuId?: number;
    warehouseId?: number;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
    /** 是否附带金额列（调用方按 canSeePrices 决定；DTO 出口仍走 maskSensitive 兜底） */
    withValue?: boolean;
  },
  dbArg?: AnyDb,
): Promise<{ rows: LedgerRow[]; total: number; moneyCalibre: typeof LEDGER_MONEY_CALIBRE | null }> {
  const db = await resolveDb(dbArg);
  const conds = [];
  if (opts.skuId) conds.push(eq(stockLedger.skuId, opts.skuId));
  if (opts.warehouseId) conds.push(eq(stockLedger.warehouseId, opts.warehouseId));
  /* 日期窗口的校验与时区边界都在 createdWithinShanghaiDays 里（唯一权威）：
     两侧过 shanghaiDay（吃日期串也吃时间戳、真验日历），解析不了 400，起止倒置 400，
     再按上海业务日绑定 timestamptz。此前这里各写一半——校验在本模块、时区边界在 helper，
     而 helper 对非法串静默不加条件，两边合起来才补全。 */
  conds.push(...createdWithinShanghaiDays(stockLedger.occurredAt, opts.from, opts.to));
  const where = conds.length ? and(...conds) : undefined;

  /* 累计余额必须在**筛选后的整个窗口**上按升序算，因此先做带窗口函数的子查询，
     再在外层按时间倒序分页——把累加放到前端就只能对当前页正确，翻到第 2 页立刻错。 */
  const windowed = db
    .select({
      id: stockLedger.id,
      occurredAt: stockLedger.occurredAt,
      skuId: stockLedger.skuId,
      warehouseId: stockLedger.warehouseId,
      batchId: stockLedger.batchId,
      qtyDelta: stockLedger.qtyDelta,
      sourceDocType: stockLedger.sourceDocType,
      sourceDocId: stockLedger.sourceDocId,
      action: stockLedger.action,
      balanceQty: sql<string>`sum(${stockLedger.qtyDelta}) over (
        partition by ${stockLedger.skuId}, ${stockLedger.warehouseId}
        order by ${stockLedger.occurredAt} asc, ${stockLedger.id} asc
        rows between unbounded preceding and current row
      )`.as("balance_qty"),
    })
    .from(stockLedger)
    .where(where)
    .as("w");

  type RawLedgerRow = {
    id: number; occurredAt: Date; skuId: number; skuCode: string; skuName: string;
    warehouseId: number; warehouseName: string; batchId: number | null; batchNo: string | null;
    qtyDelta: string; balanceQty: string; sourceDocType: string; sourceDocId: number; action: string;
  };
  const [rows, [{ total }]]: [RawLedgerRow[], { total: number }[]] = await Promise.all([
    db
      .select({
        id: windowed.id,
        occurredAt: windowed.occurredAt,
        skuId: windowed.skuId,
        skuCode: skus.code,
        skuName: skus.name,
        warehouseId: windowed.warehouseId,
        warehouseName: warehouses.name,
        batchId: windowed.batchId,
        batchNo: batches.batchNo,
        qtyDelta: windowed.qtyDelta,
        balanceQty: windowed.balanceQty,
        sourceDocType: windowed.sourceDocType,
        sourceDocId: windowed.sourceDocId,
        action: windowed.action,
      })
      .from(windowed)
      .innerJoin(skus, eq(windowed.skuId, skus.id))
      .innerJoin(warehouses, eq(windowed.warehouseId, warehouses.id))
      .leftJoin(batches, eq(windowed.batchId, batches.id))
      .orderBy(desc(windowed.occurredAt), desc(windowed.id))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(stockLedger).where(where),
  ]);

  const docNos = await resolveSourceDocNos(db, rows);
  const unitCosts = opts.withValue
    ? await resolveUnitCosts(db, rows.map((r) => r.skuId))
    : null;

  return {
    rows: rows.map((r) => {
      const target = LEDGER_SOURCE_TARGETS[r.sourceDocType];
      const sourceDocNo = target ? docNos.get(`${target.table}:${r.sourceDocId}`) ?? null : null;
      const unitCost = unitCosts?.get(r.skuId)?.unitCost ?? null;
      return {
        id: r.id,
        occurredAt: r.occurredAt,
        skuId: r.skuId,
        skuCode: r.skuCode,
        skuName: r.skuName,
        warehouseId: r.warehouseId,
        warehouseName: r.warehouseName,
        batchId: r.batchId,
        batchNo: r.batchNo,
        qtyDelta: dQty(r.qtyDelta),
        balanceQty: dQty(r.balanceQty),
        sourceDocType: r.sourceDocType,
        sourceDocId: r.sourceDocId,
        sourceDocNo,
        sourceHref: ledgerSourceHref(r.sourceDocType, sourceDocNo),
        action: r.action,
        ...(opts.withValue
          ? {
              amount: unitCost == null ? null : dMul(r.qtyDelta, unitCost, 2),
              balanceAmount: unitCost == null ? null : dMul(r.balanceQty, unitCost, 2),
            }
          : {}),
      };
    }),
    total,
    // 金额口径随金额一起下发：页面必须原样展示（成本来源 + 成本基准 + 窗口口径 + 可为负）
    moneyCalibre: opts.withValue ? LEDGER_MONEY_CALIBRE : null,
  };
}

/**
 * D20 全仓视图（2026-07-24 代决落地）：快照仓最新快照，只读参考口径——不入账本。
 * 每 (仓库,SKU) 取最大 biz_date 行；行带 bizDate 供前端数据龄标注。
 */
export async function listSnapshotBalances(
  opts: { q?: string; warehouseId?: number; page: number; pageSize: number },
  dbArg?: AnyDb,
): Promise<{ rows: unknown[]; total: number }> {
  const db = await resolveDb(dbArg);
  /* 「取最新快照」只有 core/stock-view.getLatestSnapshotRows 一个实现（此前本函数逐字复制了一份子查询）。
     快照仓 × SKU 的最新行规模在千级，维表补齐与搜索/分页在内存完成；行带 commercialRole（0727：小样要能单独查库存）。 */
  const { getLatestSnapshotRows } = await import("@/server/core/stock-view");
  const latestRows = (await getLatestSnapshotRows(db))
    .filter((r) => Number(r.qty) !== 0 && (!opts.warehouseId || r.warehouseId === opts.warehouseId));
  const skuIds = [...new Set(latestRows.map((r) => r.skuId))];
  const whIds = [...new Set(latestRows.map((r) => r.warehouseId))];
  const [skuRows, whRows]: [
    { id: number; code: string; name: string; baseUom: string; commercialRole: string; spuCode: string; spuNameCn: string }[],
    { id: number; name: string; kind: string }[],
  ] = await Promise.all([
    skuIds.length
      ? db
        .select({
          id: skus.id, code: skus.code, name: skus.name, baseUom: skus.baseUom, commercialRole: skus.commercialRole,
          spuCode: spus.code, spuNameCn: spus.nameCn,
        })
        .from(skus)
        .innerJoin(spus, eq(skus.spuId, spus.id))
        .where(inArray(skus.id, skuIds))
      : Promise.resolve([]),
    whIds.length
      ? db.select({ id: warehouses.id, name: warehouses.name, kind: warehouses.kind }).from(warehouses).where(inArray(warehouses.id, whIds))
      : Promise.resolve([]),
  ]);
  const skuById = new Map(skuRows.map((s) => [s.id, s]));
  const whById = new Map(whRows.map((w) => [w.id, w]));
  const q = (opts.q ?? "").trim().toLowerCase();
  const collator = new Intl.Collator("zh-CN");
  const all = latestRows
    .flatMap((r) => {
      const s = skuById.get(r.skuId);
      const w = whById.get(r.warehouseId);
      if (!s || !w) return [];
      if (q && !s.code.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) return [];
      return [{
        skuId: r.skuId,
        skuCode: s.code,
        skuName: s.name,
        baseUom: s.baseUom,
        commercialRole: s.commercialRole,
        spuCode: s.spuCode,
        spuNameCn: s.spuNameCn,
        warehouseId: r.warehouseId,
        warehouseName: w.name,
        warehouseKind: w.kind,
        qty: r.qty,
        bizDate: r.bizDate,
      }];
    })
    .sort((a, b) => collator.compare(a.skuCode, b.skuCode) || collator.compare(a.warehouseName, b.warehouseName));
  const start = (opts.page - 1) * opts.pageSize;
  return { rows: all.slice(start, start + opts.pageSize), total: all.length };
}
