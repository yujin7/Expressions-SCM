/**
 * RT4 数据修复（须停 dev server 运行；getDbAsync 会顺带应用迁移 0007）：
 *  A) 仓库 hex 前缀碰撞体检+修复——短 hex 码曾把同前缀异仓合并；
 *     依据 staging（committed 行留有 warehouseRaw/sheetWarehouse 原文）重建正确归属：
 *     新建全量 hash 仓、纠正别名绑定、重建受影响仓的 stock_snapshots、纠正 batch_stocks.warehouseId。
 *  B) 月销修复——渠道别名归并曾令同键行"后写覆盖"（RT4-F2）：重导销量文件（旧 pending 行被
 *     supersede，committed 历史保留），用已修复的聚合放行重算 sales_monthly。
 * 运行：npx tsx scripts/rt4-repair.ts
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { dAdd } from "../src/server/core/decimal";
import { writeAudit } from "../src/server/core/audit";
import { releaseSalesMonthly, type ReleaseUser } from "../src/server/modules/release/engine";
import { stageSalesMonthly } from "../src/server/import/adapters/sales-monthly";

const SALES_FILE = "/Users/yj/Downloads/26年产品销量汇总（6月）.xlsx";
const SNAPSHOT_BIZ_DATE = "2026-07-21";

const fullHashCode = (name: string): string =>
  "WH-SNAP-" + createHash("md5").update(name).digest("hex").slice(0, 10).toUpperCase();

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const [adminRow] = await db.select().from(schema.users).where(eq(schema.users.username, "admin"));
  const admin: ReleaseUser = { id: adminRow.id, name: adminRow.name, roles: adminRow.roles as string[], isApprover: adminRow.isApprover };

  /* ── A) 仓库碰撞体检 ── */
  const whAliases: { rawValue: string; targetId: number }[] = await db
    .select({ rawValue: schema.aliases.rawValue, targetId: schema.aliases.targetId })
    .from(schema.aliases)
    .where(eq(schema.aliases.aliasType, "warehouse"));
  const whRows: (typeof schema.warehouses.$inferSelect)[] = await db.select().from(schema.warehouses);
  const whById = new Map(whRows.map((w) => [w.id, w]));

  // 碰撞 = 一个快照仓（WH-SNAP-*）挂了 >1 个原文别名（WH-OWN 合并口径除外）
  const byTarget = new Map<number, string[]>();
  for (const a of whAliases) {
    const w = whById.get(a.targetId);
    if (!w || !w.code.startsWith("WH-SNAP-")) continue;
    const arr = byTarget.get(a.targetId) ?? [];
    arr.push(a.rawValue);
    byTarget.set(a.targetId, arr);
  }
  const collisions = [...byTarget.entries()].filter(([, raws]) => raws.length > 1);
  console.log(`碰撞体检：${collisions.length} 个快照仓挂多别名`, JSON.stringify(collisions.map(([id, raws]) => ({ wh: whById.get(id)!.name, raws }))));

  const repairedWh: string[] = [];
  if (collisions.length > 0) {
    for (const [whId, raws] of collisions) {
      // 首个别名保留原仓（名称对齐该别名）；其余各建正确仓
      const [keepRaw, ...moveRaws] = raws.sort();
      await db.update(schema.warehouses).set({ name: keepRaw }).where(eq(schema.warehouses.id, whId));
      const rawToWh = new Map<string, number>([[keepRaw, whId]]);
      for (const raw of moveRaws) {
        const code = fullHashCode(raw);
        let [w] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.code, code));
        if (!w) {
          [w] = await db
            .insert(schema.warehouses)
            .values({ code, name: raw, kind: "snapshot", accountingMode: "snapshot" })
            .returning();
        }
        await db
          .update(schema.aliases)
          .set({ targetId: w.id, note: "RT4 碰撞修复重绑" })
          .where(and(eq(schema.aliases.aliasType, "warehouse"), eq(schema.aliases.rawValue, raw)));
        rawToWh.set(raw, w.id);
        repairedWh.push(`${raw} → ${code}`);
      }

      // 重建受影响仓的快照：从 committed 期初候选行按原文重新聚合
      const openRows: { id: number; payload: unknown }[] = await db
        .select({ id: schema.stagingRows.id, payload: schema.stagingRows.payload })
        .from(schema.stagingRows)
        .where(and(eq(schema.stagingRows.targetTable, "stock_opening_candidate"), eq(schema.stagingRows.status, "committed")));
      const agg = new Map<string, { warehouseId: number; skuId: number; qty: string }>();
      const skuAlias = new Map<string, number | null>();
      for (const r of openRows) {
        const p = r.payload as { warehouseRaw?: string; skuCode?: string; qty?: number };
        if (!p.warehouseRaw || !rawToWh.has(p.warehouseRaw)) continue;
        if (typeof p.qty !== "number" || p.qty === 0) continue;
        const code = p.skuCode ?? "";
        if (!skuAlias.has(code)) {
          const [al] = await db
            .select({ targetId: schema.aliases.targetId })
            .from(schema.aliases)
            .where(and(eq(schema.aliases.aliasType, "sku_code"), eq(schema.aliases.rawValue, code)));
          skuAlias.set(code, al?.targetId ?? null);
        }
        const skuId = skuAlias.get(code);
        if (skuId == null) continue;
        const wid = rawToWh.get(p.warehouseRaw)!;
        const key = `${wid}|${skuId}`;
        const a = agg.get(key);
        if (a) a.qty = dAdd(a.qty, String(p.qty));
        else agg.set(key, { warehouseId: wid, skuId, qty: String(p.qty) });
      }
      const affectedWhIds = [...rawToWh.values()];
      await db
        .delete(schema.stockSnapshots)
        .where(and(inArray(schema.stockSnapshots.warehouseId, affectedWhIds), eq(schema.stockSnapshots.bizDate, SNAPSHOT_BIZ_DATE)));
      for (const a of agg.values()) {
        await db
          .insert(schema.stockSnapshots)
          .values({ warehouseId: a.warehouseId, skuId: a.skuId, bizDate: SNAPSHOT_BIZ_DATE, qty: a.qty })
          .onConflictDoUpdate({
            target: [schema.stockSnapshots.warehouseId, schema.stockSnapshots.skuId, schema.stockSnapshots.bizDate],
            set: { qty: a.qty },
          });
      }

      // 纠正批次效期的仓归属（committed batch_stock 行 payload.sheetWarehouse + targetId=批次行）
      const batchRows: { id: number; payload: unknown; targetId: number | null }[] = await db
        .select({ id: schema.stagingRows.id, payload: schema.stagingRows.payload, targetId: schema.stagingRows.targetId })
        .from(schema.stagingRows)
        .where(and(eq(schema.stagingRows.targetTable, "batch_stock"), eq(schema.stagingRows.status, "committed")));
      let batchFixed = 0;
      for (const r of batchRows) {
        const p = r.payload as { sheetWarehouse?: string | null };
        const raw = p.sheetWarehouse ?? "";
        const wid = rawToWh.get(raw);
        if (wid == null || r.targetId == null) continue;
        const res = await db
          .update(schema.batchStocks)
          .set({ warehouseId: wid })
          .where(and(eq(schema.batchStocks.id, r.targetId), sql`${schema.batchStocks.warehouseId} <> ${wid}`))
          .returning({ id: schema.batchStocks.id });
        batchFixed += res.length;
      }
      console.log(`仓 #${whId} 修复：快照重建 ${agg.size} 键，批次纠仓 ${batchFixed} 行`);
    }
    await writeAudit(db, {
      userId: admin.id,
      entity: "warehouse_collision_repair",
      action: "update",
      after: { collisions: collisions.length, repairedWh },
    });
  }

  /* ── B) 月销修复：重导销量文件 → 聚合放行重算 ── */
  const before: { total: string | null }[] = await db.select({ total: sql<string | null>`sum(${schema.salesMonthly.qty})` }).from(schema.salesMonthly);
  const stage = await stageSalesMonthly(db, SALES_FILE, admin.id, "2026-06-30");
  console.log("重导销量:", JSON.stringify(stage.stats));
  const rel = await releaseSalesMonthly(admin, { dryRun: false });
  const after: { total: string | null }[] = await db.select({ total: sql<string | null>`sum(${schema.salesMonthly.qty})` }).from(schema.salesMonthly);
  console.log(
    "月销修复:",
    JSON.stringify({ created: rel.created, updated: rel.updated, blocked: rel.blocked, totalBefore: before[0].total, totalAfter: after[0].total }),
  );
  await writeAudit(db, {
    userId: admin.id,
    entity: "sales_monthly_repair",
    action: "release",
    after: { totalBefore: before[0].total, totalAfter: after[0].total, created: rel.created, updated: rel.updated },
  });
  console.log("修复完成");
}

void main();
