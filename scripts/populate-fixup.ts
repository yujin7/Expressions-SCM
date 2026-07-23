/**
 * 数据填充 · 补遗（2026-07-24 代决第二轮）：
 *  A) segment=unknown 物料按「编码段位扩展表 + 名称关键词」代决分类建档（全部打 needsReview 标）
 *     —— 实证依据（scripts/inspect-unknown.ts）：0102=进口内料；0301/0302/0501=标贴；
 *        0601=膜布/膜材（构成产品本体→原料）；0602/0603=袋/衬辅材；0001=配件；
 *        ZCLY-*=自供原料（适配器只认 ZCYL，真实编码为 ZCLY——字母序修正）
 *  B) 重放 SKU/BOM/费用放行（歧义块沿用「表内最后一块=active」代决），新候选由 pmc01 批审（SoD）
 *  C) 壳 SKU 品牌归位：编码前缀→品牌（E/N/B/DEV/L/A/D 名称实证；V→微初 消去法存疑标记）；
 *     F/P 前缀（泵头/礼盒/小卡）实为包材→改 skuType=packaging 并打标
 * 运行（须先停 dev server）：npx tsx scripts/populate-fixup.ts
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { writeAudit } from "../src/server/core/audit";
import {
  releaseSkus,
  releaseBoms,
  activateReleasedBoms,
  releaseFeeRefs,
  releaseStatus,
  type ReleaseUser,
  type BomResolution,
} from "../src/server/modules/release/engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const review: string[] = [];

async function loadUser(db: AnyDb, username: string): Promise<ReleaseUser> {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.username, username));
  if (!u) throw new Error(`用户不存在：${username}`);
  return { id: u.id, name: u.name, roles: u.roles as string[], isApprover: u.isApprover };
}

/** 段位扩展分类（infix 优先，名称关键词兜底）；null=仍无法判定（保持阻塞） */
function classify(code: string, name: string): "raw" | "packaging" | null {
  const c = code.toUpperCase();
  if (c.startsWith("ZCLY") || c.startsWith("ZCYL") || /自供原料/.test(name)) return "raw";
  const infix = c.match(/-(\d{4})/)?.[1];
  if (infix === "0102" || infix === "0601") return "raw";
  if (infix && ["0301", "0302", "0501", "0602", "0603", "0001"].includes(infix)) return "packaging";
  if (/内料|原料|料体|膜布|膜材/.test(name)) return "raw";
  if (/瓶|盖|泵|箱|盒|袋|标|贴|纸|罐|喷|软管|衬|刮板|棉签|棉片|海绵|卡|膜|管/.test(name)) return "packaging";
  return null;
}

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const db = await getDbAsync();
  const admin = await loadUser(db, "admin");
  const pmc01 = await loadUser(db, "pmc01");
  const report: Record<string, unknown> = {};

  /* ── A) unknown 段位物料建档 ── */
  const pending: { payload: unknown }[] = await db
    .select({ payload: schema.stagingRows.payload })
    .from(schema.stagingRows)
    .where(
      and(
        eq(schema.stagingRows.targetTable, "bom_block"),
        inArray(schema.stagingRows.status, ["pending", "validated"]),
      ),
    );
  interface Cand { code: string; name: string; spec: string; guesses: Set<string>; parents: string[] }
  const cands = new Map<string, Cand>();
  for (const r of pending) {
    const b = r.payload as {
      productCode?: string | null;
      lines?: { materialCode: string | null; materialName: string; materialSpec?: string; uomGuess: string; segment: string }[];
    };
    for (const l of b.lines ?? []) {
      if (l.segment !== "unknown" || !l.materialCode) continue;
      const e = cands.get(l.materialCode) ?? {
        code: l.materialCode,
        name: l.materialName,
        spec: l.materialSpec ?? "",
        guesses: new Set<string>(),
        parents: [],
      };
      e.guesses.add(l.uomGuess);
      if (b.productCode && !e.parents.includes(b.productCode)) e.parents.push(b.productCode);
      cands.set(l.materialCode, e);
    }
  }
  // 父产品 SPU 索引
  const parentCodes = [...new Set([...cands.values()].flatMap((c) => c.parents))];
  const parentSkus: { code: string; spuId: number }[] = parentCodes.length
    ? await db.select({ code: schema.skus.code, spuId: schema.skus.spuId }).from(schema.skus).where(inArray(schema.skus.code, parentCodes))
    : [];
  const spuByParent = new Map(parentSkus.map((p) => [p.code, p.spuId]));
  // 物料兜底壳 SPU
  const MAT_SHELL = "【物料】未归组（导入壳，待业务归组）";
  let [matShell] = await db.select().from(schema.spus).where(eq(schema.spus.nameCn, MAT_SHELL));
  if (!matShell) {
    // SPU 取号走 doc_counter（禁 MAX+1）
    const [row] = await db
      .insert(schema.docCounters)
      .values({ prefix: "SPU", bizDate: "GLOBAL", lastNo: 1 })
      .onConflictDoUpdate({
        target: [schema.docCounters.prefix, schema.docCounters.bizDate],
        set: { lastNo: sql`${schema.docCounters.lastNo} + 1` },
      })
      .returning({ lastNo: schema.docCounters.lastNo });
    [matShell] = await db
      .insert(schema.spus)
      .values({ code: `P${String(row.lastNo).padStart(5, "0")}`, nameCn: MAT_SHELL })
      .returning();
  }

  let matCreated = 0, matUnclassified = 0, matExisting = 0;
  for (const c of cands.values()) {
    const [exist] = await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.code, c.code));
    if (exist) { matExisting++; continue; }
    const skuType = classify(c.code, c.name);
    if (skuType == null) {
      matUnclassified++;
      review.push(`物料仍无法分类（保持阻塞待人工）：${c.code} ${c.name}`);
      continue;
    }
    const allCount = c.guesses.size === 1 && c.guesses.has("count");
    const allGram = c.guesses.size === 1 && c.guesses.has("gram_ml");
    const needsReview = ["segment", ...(allCount ? [] : ["baseUom"])];
    const spuId = c.parents.map((p) => spuByParent.get(p)).find((x) => x != null) ?? matShell.id;
    await db.insert(schema.skus).values({
      code: c.code,
      name: c.name,
      spec: c.spec || null,
      spuId,
      baseUom: allGram ? "g" : "个",
      skuType,
      lossCategory: skuType === "raw" ? "raw" : "packaging",
      attrs: { needsReview, source: "segment_fixup_2026-07-24" },
      remark: "段位扩展代决分类（0102/0601=原料，0301/0302/0501/0602/0603/0001=包材，ZCLY=自供原料）——待业务复核",
    });
    matCreated++;
    review.push(`物料代决分类为${skuType === "raw" ? "原料" : "包材"}：${c.code} ${c.name}`);
  }
  await writeAudit(db, {
    userId: admin.id,
    entity: "release_segment_fixup",
    action: "release",
    after: { matCreated, matUnclassified, matExisting },
  });
  report.materials = { created: matCreated, unclassified: matUnclassified, existing: matExisting };
  console.log("物料补建:", JSON.stringify(report.materials));

  /* ── B) 重放 SKU/BOM/费用放行 ── */
  const skuRes = await releaseSkus(admin, { dryRun: false });
  report.skuRerun = { createdFinished: skuRes.createdFinished, createdMaterials: skuRes.createdMaterials, existing: skuRes.existing, blocked: skuRes.blocked.length };
  console.log("SKU重放:", JSON.stringify(report.skuRerun));

  const bomRows: { id: number; payload: unknown }[] = await db
    .select({ id: schema.stagingRows.id, payload: schema.stagingRows.payload })
    .from(schema.stagingRows)
    .where(
      and(
        eq(schema.stagingRows.targetTable, "bom_block"),
        inArray(schema.stagingRows.status, ["pending", "validated"]),
      ),
    )
    .orderBy(schema.stagingRows.importJobId, schema.stagingRows.rowNo);
  const ambByProduct = new Map<string, number[]>();
  for (const r of bomRows) {
    const p = r.payload as { ambiguous?: boolean; productCode?: string | null };
    if (p.ambiguous && p.productCode) {
      const l = ambByProduct.get(p.productCode) ?? [];
      l.push(r.id);
      ambByProduct.set(p.productCode, l);
    }
  }
  const resolutions: Record<string, BomResolution> = {};
  for (const list of ambByProduct.values()) {
    list.forEach((id, i) => {
      resolutions[String(id)] = { decision: i === list.length - 1 ? "active" : "retired" };
    });
  }
  const bomRes = await releaseBoms(admin, { resolutions, dryRun: false });
  report.bomRerun = {
    created: bomRes.created,
    candidates: bomRes.candidates.length,
    retired: bomRes.retired,
    blocked: bomRes.blocked.length,
    lineSkips: bomRes.lineSkips.length,
    releaseRunId: bomRes.releaseRunId,
  };
  console.log("BOM重放:", JSON.stringify(report.bomRerun));

  if (bomRes.releaseRunId != null && bomRes.candidates.length > 0) {
    const act = await activateReleasedBoms(pmc01, { releaseRunId: bomRes.releaseRunId, dryRun: false });
    report.bomActivation2 = { activated: act.activated, sampleSize: act.sample.length };
    for (const s of act.sample) review.push(`BOM 生效抽检（补遗轮）：${s.productCode} ${s.versionNo}`);
    console.log("BOM生效:", JSON.stringify(report.bomActivation2));
  }

  const feeRes = await releaseFeeRefs(admin, { dryRun: false });
  report.feeRerun = { created: feeRes.created, existing: feeRes.existing, blocked: feeRes.blocked.length };
  console.log("费用重放:", JSON.stringify(report.feeRerun));

  /* ── C) 壳 SKU 品牌归位 ── */
  const PFX_MAP: [RegExp, string, string?][] = [
    [/^DEV/i, "DEV"],
    [/^E/i, "EXP"],
    [/^N/i, "NING"],
    [/^B/i, "B2F"],
    [/^L/i, "LYUV"],
    [/^A/i, "ABS"],
    [/^D/i, "DWS"],
    [/^V/i, "WC", "消去法推断（V→微初），存疑待业务确认"],
  ];
  const PACK_PFX = /^[FP]\d/i; // F=泵头/膜等耗材，P=礼盒/小卡——实为包材
  const brands = await db.select().from(schema.brands);
  const brandByCode = new Map(brands.map((b: typeof schema.brands.$inferSelect) => [b.code, b]));
  const shells: (typeof schema.skus.$inferSelect)[] = await db
    .select()
    .from(schema.skus)
    .where(sql`${schema.skus.attrs}->>'source' = 'shell_import_2026-07-24'`);
  const shellSpuByBrand = new Map<string, number>();
  let rebranded = 0, packified = 0, leftUnknown = 0;
  for (const s of shells) {
    if (PACK_PFX.test(s.code)) {
      const attrs = (s.attrs ?? {}) as Record<string, unknown>;
      const nr = new Set([...((attrs.needsReview as string[]) ?? []), "skuType"]);
      await db
        .update(schema.skus)
        .set({ skuType: "packaging", lossCategory: "packaging", attrs: { ...attrs, needsReview: [...nr] }, updatedAt: new Date() })
        .where(eq(schema.skus.id, s.id));
      packified++;
      review.push(`壳档改判包材（泵头/礼盒/小卡类）：${s.code} ${s.name.slice(0, 24)}`);
      continue;
    }
    const hit = PFX_MAP.find(([re]) => re.test(s.code));
    if (!hit) { leftUnknown++; continue; }
    const brand = brandByCode.get(hit[1]);
    if (!brand) { leftUnknown++; continue; }
    let spuId = shellSpuByBrand.get(brand.code);
    if (spuId == null) {
      const shellName = `【${brand.nameCn}】未归组（导入壳，待业务归组）`;
      const [existSpu] = await db.select().from(schema.spus).where(eq(schema.spus.nameCn, shellName));
      if (existSpu) spuId = existSpu.id;
      else {
        const [row] = await db
          .insert(schema.docCounters)
          .values({ prefix: "SPU", bizDate: "GLOBAL", lastNo: 1 })
          .onConflictDoUpdate({
            target: [schema.docCounters.prefix, schema.docCounters.bizDate],
            set: { lastNo: sql`${schema.docCounters.lastNo} + 1` },
          })
          .returning({ lastNo: schema.docCounters.lastNo });
        const [spu] = await db
          .insert(schema.spus)
          .values({ code: `P${String(row.lastNo).padStart(5, "0")}`, nameCn: shellName })
          .returning();
        spuId = spu.id;
      }
      shellSpuByBrand.set(brand.code, spuId!);
    }
    await db
      .update(schema.skus)
      .set({ spuId: spuId!, brandId: brand.id, updatedAt: new Date() })
      .where(eq(schema.skus.id, s.id));
    rebranded++;
    if (hit[2]) review.push(`壳档品牌${hit[2]}：${s.code}`);
  }
  await writeAudit(db, {
    userId: admin.id,
    entity: "release_shell_rebrand",
    action: "update",
    after: { rebranded, packified, leftUnknown, brands: [...shellSpuByBrand.keys()] },
  });
  report.shellRebrand = { rebranded, packified, leftUnknown, brands: [...shellSpuByBrand.keys()] };
  console.log("壳归位:", JSON.stringify(report.shellRebrand));

  /* ── 收尾 ── */
  const status = await releaseStatus();
  report.finalStatus = status.tables.map((t) => ({ t: t.targetTable, staged: t.staged, committed: t.committed }));
  const prev = JSON.parse(readFileSync("reports/populate-release-report.json", "utf8"));
  writeFileSync("reports/populate-release-report.json", JSON.stringify({ ...prev, fixup: report }, null, 2));
  appendFileSync(
    "reports/复核清单-2026-07-24.md",
    `\n## 补遗轮（segment 代决分类 + 壳档品牌归位）\n\n${review.map((l) => `- ${l}`).join("\n")}\n`,
  );
  console.log("最终状态:", JSON.stringify(report.finalStatus));
  console.log(`复核补充 ${review.length} 条已追加`);
}

void main();
