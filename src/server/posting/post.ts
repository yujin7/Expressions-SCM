/**
 * 过账引擎（《01》§4 + R10）——写 stock_ledger / stock_balances 的唯一合法路径。
 *
 * 不变式：
 * - 幂等优先（R10）：同 (sourceDocType, sourceDocId, action) 已过账 → 直接返回
 *   { posted:false }，不触碰余额；UNIQUE(uq_ledger_source) 为并发硬兜底。
 * - 余额更新在事务内按 (skuId, warehouseId, batchId) 排序，防死锁（CLAUDE.md）。
 * - 负库存规则（R4）：实时仓 ≥0；委外仓可负（=加工厂垫料）；快照仓禁止过账。
 * - 数量运算一律走 src/server/core/decimal.ts，禁止 float。
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { stockBalances, stockLedger, warehouses } from "@/db/schema";
import { dCmp, dNeg, dQty } from "@/server/core/decimal";
import { getLocatedQty } from "@/server/modules/inventory/location-balance";
import { isRegisteredSource } from "./registry";

/**
 * 宽松 db 句柄：node-postgres 的 NodePgDatabase 与 PGlite 的 PgliteDatabase
 * （tests/helpers/db.ts）泛型签名不兼容，无公共命名超类，故此处用 any 收口；
 * 运行时只依赖 drizzle 通用查询构建器 + .transaction()。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = any;

export type PostingLine = {
  sourceLineId: number;
  skuId: number;
  warehouseId: number;
  batchId?: number | null;
  qtyDelta: string; // 十进制字符串，scale≤4
};

export type PostingEvent = {
  sourceDocType: string;
  sourceDocId: number;
  action: string;
  lines: PostingLine[];
  occurredAt?: Date;
};

export type PostingErrorCode =
  | "NEGATIVE_STOCK"
  | "EMPTY_EVENT"
  | "UNREGISTERED_SOURCE"
  | "SNAPSHOT_WAREHOUSE"
  | "LOCATED_STOCK";

export class PostingError extends Error {
  readonly code: PostingErrorCode;
  constructor(code: PostingErrorCode, message: string) {
    super(message);
    this.name = "PostingError";
    this.code = code;
  }
}

/** 排序键：(skuId, warehouseId, batchId)，batchId NULL 视为最小（排最前） */
function compareLines(a: PostingLine, b: PostingLine): number {
  if (a.skuId !== b.skuId) return a.skuId - b.skuId;
  if (a.warehouseId !== b.warehouseId) return a.warehouseId - b.warehouseId;
  return (a.batchId ?? -1) - (b.batchId ?? -1);
}

/**
 * 过账。总是自行开启事务——调用方应传入根 db 实例；若传入的是已有事务句柄，
 * drizzle 会以 SAVEPOINT 嵌套执行，语义不变。
 * 返回 { posted:false } 表示该事件此前已过账（幂等重试，未做任何写入）。
 */
export async function post(db: AnyDb, event: PostingEvent): Promise<{ posted: boolean }> {
  if (!event.lines || event.lines.length === 0) {
    throw new PostingError("EMPTY_EVENT", `过账事件无行: ${event.sourceDocType}#${event.sourceDocId}`);
  }
  if (!isRegisteredSource(event.sourceDocType, event.action)) {
    throw new PostingError(
      "UNREGISTERED_SOURCE",
      `未注册的过账来源: (${event.sourceDocType}, ${event.action})——库存只能经 posting/registry.ts 注册的入口过账`,
    );
  }

  return db.transaction(async (tx: AnyDb) => {
    // 1) 幂等检查优先（R10）：已有任意流水 → 重试直接短路，不触余额
    const dup = await tx
      .select({ id: stockLedger.id })
      .from(stockLedger)
      .where(
        and(
          eq(stockLedger.sourceDocType, event.sourceDocType),
          eq(stockLedger.sourceDocId, event.sourceDocId),
          eq(stockLedger.action, event.action),
        ),
      )
      .limit(1);
    if (dup.length > 0) return { posted: false };

    // 2) 排序防死锁（CLAUDE.md）
    const lines = [...event.lines].sort(compareLines);

    // 3) 仓库 kind 一次性取齐（每事件一次，不逐行查）
    const whIds = [...new Set(lines.map((l) => l.warehouseId))];
    const whRows: { id: number; kind: string }[] = await tx
      .select({ id: warehouses.id, kind: warehouses.kind })
      .from(warehouses)
      .where(inArray(warehouses.id, whIds));
    const kindByWh = new Map(whRows.map((w) => [w.id, w.kind]));

    // 快照仓（保税/E/云）只吃 snapshot 导入，任何 ledger 过账都是错误
    for (const l of lines) {
      if (kindByWh.get(l.warehouseId) === "snapshot") {
        throw new PostingError(
          "SNAPSHOT_WAREHOUSE",
          `快照仓(warehouse#${l.warehouseId})禁止过账——快照导入只覆写 stock_snapshots，不触 ledger`,
        );
      }
    }

    // 库位作业与库存过账共用仓库主档行锁。否则“定位未定位量”和“出库扣总账”
    // 可在两个事务中同时通过检查，提交后制造 Σ库位 > 仓库余额。
    for (const warehouseId of [...whIds].sort((a, b) => a - b)) {
      await tx.execute(sql`select id from warehouses where id = ${warehouseId} for update`);
    }

    // 4) 插入流水（按排序后顺序，一行一条；dQty 兼做十进制校验与规格化）
    await tx.insert(stockLedger).values(
      lines.map((l) => ({
        skuId: l.skuId,
        warehouseId: l.warehouseId,
        batchId: l.batchId ?? null,
        qtyDelta: dQty(l.qtyDelta),
        sourceDocType: event.sourceDocType,
        sourceDocId: event.sourceDocId,
        sourceLineId: l.sourceLineId,
        action: event.action,
        ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
      })),
    );

    // 5) upsert 余额（uq_balance_key NULLS NOT DISTINCT）+ 逐行负库存校验（R4）
    for (const l of lines) {
      const delta = dQty(l.qtyDelta);
      const [row]: { qty: string }[] = await tx
        .insert(stockBalances)
        .values({
          skuId: l.skuId,
          warehouseId: l.warehouseId,
          batchId: l.batchId ?? null,
          qty: delta,
        })
        .onConflictDoUpdate({
          target: [stockBalances.skuId, stockBalances.warehouseId, stockBalances.batchId],
          set: { qty: sql`${stockBalances.qty} + excluded.qty` },
        })
        .returning({ qty: stockBalances.qty });

      if (dCmp(row.qty, "0") < 0) {
        const kind = kindByWh.get(l.warehouseId);
        if (kind === "outsource") continue; // 委外仓可负=加工厂垫料（对账页标红）
        throw new PostingError(
          "NEGATIVE_STOCK",
          `负库存被拒（R4）: sku#${l.skuId} warehouse#${l.warehouseId}(${kind ?? "unknown"}) 过账后余额 ${row.qty} < 0`,
        );
      }
      if (dCmp(delta, "0") < 0) {
        const locatedQty = await getLocatedQty(tx, {
          skuId: l.skuId,
          warehouseId: l.warehouseId,
          batchId: l.batchId ?? null,
        });
        if (dCmp(row.qty, locatedQty) < 0) {
          throw new PostingError(
            "LOCATED_STOCK",
            `可出库的未定位库存不足: sku#${l.skuId} warehouse#${l.warehouseId} ` +
              `过账后总账 ${row.qty}，已有库位定位 ${locatedQty}；请先在库位作业中取消定位或放行后再出库`,
          );
        }
      }
    }

    return { posted: true };
  });
}

/**
 * 红字冲销（R12）：对原事件全部行取负后过账。
 * sourceDocType 固定 "stock_doc"（红字单，subtype=reversal），action="reverse"，
 * sourceDocId=红字单 id。同一红字单重复调用幂等（返回 { posted:false }）。
 */
export async function reverse(
  db: AnyDb,
  original: PostingEvent,
  reversalDocId: number,
): Promise<{ posted: boolean }> {
  // 红队防御纵深：action 编码被冲原单身份，且先查该原单是否已被任何红字冲销过——
  // 模块层（reverseStockDoc 409）仍是主防线，这里防"不同红字单二次冲销同一原单"绕过引擎。
  const reverseAction = `reverse:${original.sourceDocType}#${original.sourceDocId}`;
  const already = await db
    .select({ id: stockLedger.id })
    .from(stockLedger)
    .where(eq(stockLedger.action, reverseAction))
    .limit(1);
  if (already.length > 0) return { posted: false };
  return post(db, {
    sourceDocType: "stock_doc",
    sourceDocId: reversalDocId,
    action: reverseAction,
    lines: original.lines.map((l) => ({
      sourceLineId: l.sourceLineId,
      skuId: l.skuId,
      warehouseId: l.warehouseId,
      batchId: l.batchId ?? null,
      qtyDelta: dNeg(l.qtyDelta),
    })),
  });
}

/** 查询余额；无余额行返回 "0"。batchId 省略/null 时匹配 NULL 批次行。 */
export async function getBalance(
  db: AnyDb,
  skuId: number,
  warehouseId: number,
  batchId?: number | null,
): Promise<string> {
  const rows: { qty: string }[] = await db
    .select({ qty: stockBalances.qty })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.skuId, skuId),
        eq(stockBalances.warehouseId, warehouseId),
        batchId == null ? isNull(stockBalances.batchId) : eq(stockBalances.batchId, batchId),
      ),
    )
    .limit(1);
  return rows[0]?.qty ?? "0";
}
