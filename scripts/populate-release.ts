/**
 * 数据填充 · 阶段2-5（业主 2026-07-24 会话内授权代决；复核清单落 reports/）：
 *  2) SPU/SKU/BOM 放行——review 簇代决接受、歧义块代决「表内最后一块=active」，全部留痕待业务复核
 *  3) 非 BOM 品牌壳 SKU 建档 + sku_code 别名按码精确认领
 *  4) 加工费参考价 / 批次效期 / 月销量放行
 *  5) 自有仓期初单（warehouse01 制单 → finance01 审批）+ 快照仓 stock_snapshots 载入（D20）
 * 运行（须先停 dev server——PGlite 单进程）：npx tsx scripts/populate-release.ts
 * 幂等：committed 行不再入选；壳 SKU 按码跳过；快照 upsert；期初只吃 pending 行。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { claimAlias, resolveAlias } from "../src/server/modules/dimension/resolver";
import {
  releaseSpus,
  releaseSkus,
  releaseBoms,
  activateReleasedBoms,
  releaseFeeRefs,
  releaseBatchStocks,
  releaseSalesMonthly,
  releaseStatus,
  type ReleaseUser,
  type BomResolution,
} from "../src/server/modules/release/engine";
import { createStockDoc, submitStockDoc, approveStockDoc } from "../src/server/modules/inventory/stock-doc";
import { dAdd } from "../src/server/core/decimal";
import { writeAudit } from "../src/server/core/audit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

const SNAPSHOT_BIZ_DATE = "2026-07-21"; // 电商部库存明细 7-21 数据源
const OPENING_CHUNK = 200; // 期初单每单行数上限（可读性+审批粒度）

const report: Record<string, unknown> = {};
const reviewList: string[] = [];

async function loadUser(db: AnyDb, username: string): Promise<ReleaseUser> {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, username));
  if (!u) throw new Error(`用户不存在：${username}（先跑 db:seed）`);
  return { id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover };
}

/** SPU 取号（复刻引擎私有逻辑：doc_counters 原子 upsert，禁止 MAX+1） */
async function nextSpuCode(db: AnyDb): Promise<string> {
  for (let guard = 0; guard < 100000; guard++) {
    const [row] = await db
      .insert(schema.docCounters)
      .values({ prefix: "SPU", bizDate: "GLOBAL", lastNo: 1 })
      .onConflictDoUpdate({
        target: [schema.docCounters.prefix, schema.docCounters.bizDate],
        set: { lastNo: sql`${schema.docCounters.lastNo} + 1` },
      })
      .returning({ lastNo: schema.docCounters.lastNo });
    const code = `P${String(row.lastNo).padStart(5, "0")}`;
    const [dup] = await db.select({ id: schema.spus.id }).from(schema.spus).where(eq(schema.spus.code, code));
    if (!dup) return code;
  }
  throw new Error("SPU 取号异常");
}

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const admin = await loadUser(db, "admin");
  const pmc01 = await loadUser(db, "pmc01");
  const warehouse01 = await loadUser(db, "warehouse01");
  const finance01 = await loadUser(db, "finance01");

  /* ── 阶段2a：SPU 放行（review 簇代决接受，簇名单入复核清单） ── */
  const spuDry = await releaseSpus(admin, { dryRun: true });
  const overrides: Record<string, { action: "accept" }> = {};
  for (const nr of spuDry.needsReview) {
    overrides[nr.spuKey] = { action: "accept" };
    reviewList.push(`SPU 簇代决接受：${nr.spuKey}（成员 ${nr.members.length}；原因：${nr.reason}）`);
  }
  const spuRes = await releaseSpus(admin, { overrides, dryRun: false });
  report.spus = {
    created: spuRes.created.length,
    existing: spuRes.existing,
    merged: spuRes.merged,
    stillNeedsReview: spuRes.needsReview.length,
    acceptedReviewClusters: Object.keys(overrides).length,
  };
  console.log("SPU:", JSON.stringify(report.spus));

  /* ── 阶段2b：SKU 放行（BOM 三品牌成品+物料） ── */
  const skuRes = await releaseSkus(admin, { dryRun: false });
  report.skus = {
    createdFinished: skuRes.createdFinished,
    createdMaterials: skuRes.createdMaterials,
    existing: skuRes.existing,
    blocked: skuRes.blocked.length,
    uncoded: skuRes.uncoded.length,
    unresolvedBrands: skuRes.unresolvedBrands,
    nameCrossCheck: skuRes.nameCrossCheck.length,
  };
  for (const b of skuRes.blocked.slice(0, 50)) reviewList.push(`SKU 放行受阻：${b.code}（${b.reason}）`);
  for (const u of skuRes.uncoded) reviewList.push(`无编码物料待人工建档：${u.name}（出现 ${u.occurrences} 次）`);
  console.log("SKU:", JSON.stringify(report.skus));

  /* ── 阶段3：壳 SKU（非 BOM 品牌）+ sku_code 别名认领 ── */
  const openSku = await db
    .select()
    .from(schema.aliasExceptions)
    .where(and(eq(schema.aliasExceptions.aliasType, "sku_code"), eq(schema.aliasExceptions.status, "open")));
  // 名称/品牌来源：期初候选 → 批次 → 月销（首见）
  const nameByCode = new Map<string, { name: string | null; brand: string | null }>();
  for (const t of ["stock_opening_candidate", "batch_stock", "sales_monthly"]) {
    const rows: { payload: unknown }[] = await db
      .select({ payload: schema.stagingRows.payload })
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.targetTable, t));
    for (const r of rows) {
      const p = r.payload as { skuCode?: string | null; skuName?: string | null; brandRaw?: string | null };
      if (p.skuCode && !nameByCode.has(p.skuCode)) {
        nameByCode.set(p.skuCode, { name: p.skuName ?? null, brand: p.brandRaw ?? null });
      }
    }
  }
  const brandRows = await db.select().from(schema.brands);
  const shellSpuByBrand = new Map<string, number>();
  let claimedExisting = 0, shellCreated = 0, skuStillOpen = 0;
  for (const exc of openSku) {
    const code = exc.rawValue.trim();
    if (!code) { skuStillOpen++; continue; }
    let [skuRow] = await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.code, code));
    if (skuRow) {
      await claimAlias(db, { aliasType: "sku_code", rawValue: exc.rawValue, targetId: skuRow.id, userId: admin.id });
      claimedExisting++;
      continue;
    }
    const meta = nameByCode.get(code) ?? { name: null, brand: null };
    const brandKey = (meta.brand ?? "未知品牌").trim() || "未知品牌";
    let spuId = shellSpuByBrand.get(brandKey);
    if (spuId == null) {
      // 同品牌壳 SPU 复用（含跨次运行：按名称回查）
      const shellName = `【${brandKey}】未归组（导入壳，待业务归组）`;
      const [existSpu] = await db.select().from(schema.spus).where(eq(schema.spus.nameCn, shellName));
      if (existSpu) spuId = existSpu.id;
      else {
        const spuCode = await nextSpuCode(db);
        const [spu] = await db.insert(schema.spus).values({ code: spuCode, nameCn: shellName }).returning();
        spuId = spu.id;
      }
      shellSpuByBrand.set(brandKey, spuId!);
    }
    const brand = brandRows.find(
      (b: typeof schema.brands.$inferSelect) => b.code === brandKey || b.nameCn === brandKey || (b.nameEn ?? "") === brandKey,
    );
    const brandId = brand?.id ?? (await resolveAlias(db, "brand", brandKey));
    [skuRow] = await db
      .insert(schema.skus)
      .values({
        code,
        name: meta.name ?? code,
        spuId: spuId!,
        baseUom: "件",
        skuType: "finished",
        brandId: brandId ?? null,
        attrs: { needsReview: ["spu", "baseUom"], source: "shell_import_2026-07-24" },
        remark: "非 BOM 品牌导入壳档（规格/单位/归组待业务补全）",
      })
      .returning({ id: schema.skus.id });
    await claimAlias(db, { aliasType: "sku_code", rawValue: exc.rawValue, targetId: skuRow.id, userId: admin.id });
    shellCreated++;
  }
  await writeAudit(db, {
    userId: admin.id,
    entity: "release_shell_sku",
    action: "release",
    after: { claimedExisting, shellCreated, skuStillOpen, shellSpus: [...shellSpuByBrand.keys()] },
  });
  report.shellSkus = { claimedExisting, shellCreated, skuStillOpen, shellSpuBrands: [...shellSpuByBrand.keys()] };
  reviewList.push(`壳 SKU 建档 ${shellCreated} 个（品牌：${[...shellSpuByBrand.keys()].join("、")}）——单位默认「件」、未归组，待业务补全`);
  console.log("壳SKU:", JSON.stringify(report.shellSkus));

  /* ── 阶段2c：BOM 放行（歧义块代决：同产品表内最后一块=active，其余=retired） ── */
  const bomRows: { id: number; importJobId: number; rowNo: number; payload: unknown }[] = await db
    .select({
      id: schema.stagingRows.id,
      importJobId: schema.stagingRows.importJobId,
      rowNo: schema.stagingRows.rowNo,
      payload: schema.stagingRows.payload,
    })
    .from(schema.stagingRows)
    .where(
      and(
        eq(schema.stagingRows.targetTable, "bom_block"),
        inArray(schema.stagingRows.status, ["pending", "validated"]),
      ),
    )
    .orderBy(asc(schema.stagingRows.importJobId), asc(schema.stagingRows.rowNo));
  const ambiguousByProduct = new Map<string, { id: number }[]>();
  for (const r of bomRows) {
    const p = r.payload as { ambiguous?: boolean; productCode?: string | null };
    if (p.ambiguous && p.productCode) {
      const list = ambiguousByProduct.get(p.productCode) ?? [];
      list.push({ id: r.id });
      ambiguousByProduct.set(p.productCode, list);
    }
  }
  const resolutions: Record<string, BomResolution> = {};
  for (const [code, list] of ambiguousByProduct) {
    for (let i = 0; i < list.length; i++) {
      resolutions[String(list[i].id)] = { decision: i === list.length - 1 ? "active" : "retired" };
    }
    reviewList.push(`BOM 歧义代决：${code}（${list.length} 块，取表内最后一块为现行版）——自动裁决待复核`);
  }
  const bomRes = await releaseBoms(admin, { resolutions, dryRun: false });
  report.boms = {
    created: bomRes.created,
    candidates: bomRes.candidates.length,
    retired: bomRes.retired,
    skipped: bomRes.skipped,
    blocked: bomRes.blocked.length,
    lineSkips: bomRes.lineSkips.length,
    unresolvedSuppliers: bomRes.unresolvedSuppliers,
    releaseRunId: bomRes.releaseRunId,
    ambiguousAutoResolved: ambiguousByProduct.size,
  };
  for (const b of bomRes.blocked.slice(0, 30)) reviewList.push(`BOM 放行受阻：${b.productCode ?? "?"}（${b.reason}）`);
  console.log("BOM:", JSON.stringify(report.boms));

  /* ── 阶段2d：BOM 批量生效（pmc01 审批——SoD：放行人=admin） ── */
  if (bomRes.releaseRunId != null && bomRes.candidates.length > 0) {
    const act = await activateReleasedBoms(pmc01, { releaseRunId: bomRes.releaseRunId, dryRun: false });
    report.bomActivation = {
      activated: act.activated,
      alreadyActive: act.alreadyActive,
      skippedRetired: act.skippedRetired,
      sampleSize: act.sample.length,
    };
    for (const s of act.sample) reviewList.push(`BOM 生效抽检（10%样本）：${s.productCode} ${s.versionNo}`);
    console.log("BOM生效:", JSON.stringify(report.bomActivation));
  }

  /* ── 阶段4：参考价 / 批次效期 / 月销量 ── */
  const feeRes = await releaseFeeRefs(admin, { dryRun: false });
  report.feeRefs = { created: feeRes.created, existing: feeRes.existing, blocked: feeRes.blocked.length };
  console.log("加工费参考:", JSON.stringify(report.feeRefs));

  const batchRes = await releaseBatchStocks(admin, { dryRun: false });
  report.batchStocks = { created: batchRes.created, blocked: batchRes.blocked.length, unresolved: batchRes.unresolved };
  console.log("批次效期:", JSON.stringify(report.batchStocks));

  const salesRes = await releaseSalesMonthly(admin, { dryRun: false });
  report.salesMonthly = {
    created: salesRes.created,
    updated: salesRes.updated,
    blocked: salesRes.blocked,
    unresolved: salesRes.unresolved,
  };
  console.log("月销量:", JSON.stringify(report.salesMonthly));

  /* ── 阶段5：期初（实时仓）+ 快照载入（快照仓，D20） ── */
  const openingRows: { id: number; payload: unknown }[] = await db
    .select({ id: schema.stagingRows.id, payload: schema.stagingRows.payload })
    .from(schema.stagingRows)
    .where(
      and(
        eq(schema.stagingRows.targetTable, "stock_opening_candidate"),
        inArray(schema.stagingRows.status, ["pending", "validated"]),
      ),
    )
    .orderBy(asc(schema.stagingRows.id));
  const whRows = await db.select().from(schema.warehouses);
  const whById = new Map(whRows.map((w: typeof schema.warehouses.$inferSelect) => [w.id, w]));
  const whAlias = new Map<string, number | null>();
  const skuAlias = new Map<string, number | null>();

  type Bucket = { qty: string; rowIds: number[] }; // RT4-P3：dAdd 字符串求和（禁 float）
  const openingBySku = new Map<number, Bucket>(); // 实时仓（WH-OWN 合并口径）
  const snapByKey = new Map<string, Bucket & { warehouseId: number; skuId: number }>();
  let zeroRows = 0, unresolvedRows = 0;

  for (const r of openingRows) {
    const p = r.payload as { warehouseRaw?: string; skuCode?: string; qty?: number };
    const whRaw = p.warehouseRaw ?? "";
    if (!whAlias.has(whRaw)) whAlias.set(whRaw, await resolveAlias(db, "warehouse", whRaw));
    const whId = whAlias.get(whRaw);
    const code = p.skuCode ?? "";
    if (!skuAlias.has(code)) {
      let sid = await resolveAlias(db, "sku_code", code);
      if (sid == null) {
        const [s] = await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.code, code));
        sid = s?.id ?? null;
      }
      skuAlias.set(code, sid);
    }
    const skuId = skuAlias.get(code);
    if (whId == null || skuId == null || typeof p.qty !== "number") {
      unresolvedRows++;
      await db
        .update(schema.stagingRows)
        .set({ errorMsg: whId == null ? `仓库未解析：${whRaw}` : skuId == null ? `SKU 未解析：${code}` : "数量非法" })
        .where(eq(schema.stagingRows.id, r.id));
      continue;
    }
    if (p.qty === 0) {
      zeroRows++;
      await db
        .update(schema.stagingRows)
        .set({ status: "committed", targetId: null, errorMsg: "数量0——期初/快照无需入账" })
        .where(eq(schema.stagingRows.id, r.id));
      continue;
    }
    const wh = whById.get(whId)!;
    if (wh.accountingMode === "realtime") {
      const b = openingBySku.get(skuId) ?? { qty: "0", rowIds: [] };
      b.qty = dAdd(b.qty, String(p.qty));
      b.rowIds.push(r.id);
      openingBySku.set(skuId, b);
    } else {
      const key = `${whId}|${skuId}`;
      const b = snapByKey.get(key) ?? { qty: "0", rowIds: [], warehouseId: whId, skuId };
      b.qty = dAdd(b.qty, String(p.qty));
      b.rowIds.push(r.id);
      snapByKey.set(key, b);
    }
  }

  // 5a) 实时仓期初单：warehouse01 制单+提交 → finance01 审批（期初审批域=finance）
  const [ownWh] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.code, "WH-OWN"));
  const openingEntries = [...openingBySku.entries()];
  const docNos: string[] = [];
  for (let i = 0; i < openingEntries.length; i += OPENING_CHUNK) {
    const chunk = openingEntries.slice(i, i + OPENING_CHUNK);
    const doc = await createStockDoc(warehouse01, {
      subtype: "opening",
      warehouseId: ownWh.id,
      remark: `期初建账（电商部库存明细 ${SNAPSHOT_BIZ_DATE}，1仓2仓合并口径）批次 ${Math.floor(i / OPENING_CHUNK) + 1}`,
      lines: chunk.map(([skuId, b]) => ({ skuId, qty: b.qty })),
    });
    const submitted = await submitStockDoc(warehouse01, doc.id, doc.version);
    // RT4-F3：审批过账与 staging 提交同事务——消除"已过账但行仍 pending"的崩溃窗口（重跑翻倍根因之二）
    const rowIds = chunk.flatMap(([, b]) => b.rowIds);
    await db.transaction(async (tx: typeof db) => {
      await approveStockDoc(finance01, doc.id, { action: "approve", version: submitted.version, comment: "期初批量建账（业主代决授权）" }, tx);
      await tx
        .update(schema.stagingRows)
        .set({ status: "committed", targetId: doc.id, errorMsg: null })
        .where(inArray(schema.stagingRows.id, rowIds));
    });
    docNos.push(doc.docNo);
  }
  report.opening = { docs: docNos.length, docNos, skuLines: openingEntries.length, zeroRows, unresolvedRows };
  console.log("期初:", JSON.stringify(report.opening));

  // 5b) 快照仓载入（只读参考，D20；不入账本）
  let snapUpserts = 0;
  for (const b of snapByKey.values()) {
    const [row] = await db
      .insert(schema.stockSnapshots)
      .values({ warehouseId: b.warehouseId, skuId: b.skuId, bizDate: SNAPSHOT_BIZ_DATE, qty: b.qty })
      .onConflictDoUpdate({
        target: [schema.stockSnapshots.warehouseId, schema.stockSnapshots.skuId, schema.stockSnapshots.bizDate],
        set: { qty: b.qty },
      })
      .returning({ id: schema.stockSnapshots.id });
    await db
      .update(schema.stagingRows)
      .set({ status: "committed", targetId: row.id, errorMsg: null })
      .where(inArray(schema.stagingRows.id, b.rowIds));
    snapUpserts++;
  }
  await writeAudit(db, {
    userId: admin.id,
    entity: "stock_snapshot_load",
    action: "release",
    after: { bizDate: SNAPSHOT_BIZ_DATE, upserts: snapUpserts, zeroRows, unresolvedRows },
  });
  report.snapshots = { upserts: snapUpserts, bizDate: SNAPSHOT_BIZ_DATE };
  console.log("快照:", JSON.stringify(report.snapshots));

  /* ── 收尾：状态汇总 + 复核清单落盘 ── */
  const status = await releaseStatus();
  report.finalStatus = status.tables;
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/populate-release-report.json", JSON.stringify(report, null, 2));
  writeFileSync(
    "reports/复核清单-2026-07-24.md",
    `# 数据填充代决复核清单（2026-07-24）\n\n> 业主会话内授权代决产生的自动裁决，全部可经红字/重导改判。\n\n${reviewList.map((l) => `- ${l}`).join("\n")}\n`,
  );
  console.log("最终状态:", JSON.stringify(status.tables, null, 2));
  console.log(`复核清单 ${reviewList.length} 条 → reports/复核清单-2026-07-24.md`);
}

void main();
