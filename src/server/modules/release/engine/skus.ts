/** release 流水线：skus（自 engine.ts 拆出，行为未变） */
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";

import type { BomBlock, BomLine } from "@/server/import/adapters/bom";
import type { SpuCluster } from "@/server/import/adapters/bom-spu";
import { type AnyDb, type ReleaseUser, resolveDb, loadStagedRows, markBlocked, aliasCache, loadReleasedSpuIndex, loadSkuIdByCode, isBomBlockPayload } from "./common";

/* ══ 2) releaseSkus（BOM 块 → 成品/物料建档） ═══════════ */

type BlockedSku = { code: string; kind: "finished" | "material"; reason: string };

export interface ReleaseSkusResult {
  dryRun: boolean;
  createdFinished: number;
  createdMaterials: number;
  createdCodes: string[];
  existing: number;
  blocked: BlockedSku[];
  /** 无编码物料——不放行，人工建档队列（§4.5 精神：不混入去重） */
  uncoded: { name: string; occurrences: number }[];
  /** 品牌别名未认领的 brandCode（SKU 照建，brandId 置空并打标） */
  unresolvedBrands: string[];
  /** 与 stock_opening_candidate 的名称交叉核对（仅提示，不阻塞） */
  nameCrossCheck: { code: string; bomName: string; openingName: string }[];
}

export async function releaseSkus(
  user: ReleaseUser,
  args: { jobIds?: number[]; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseSkusResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, "bom_block", args.jobIds);
  const spuOfCode = await loadReleasedSpuIndex(db);
  const resolve = aliasCache(db);

  // 编码 → 贡献 staging 行（阻塞原因写回行级——一个 bom_block 行贡献产品码与每个物料码）
  const codeRows = new Map<string, number[]>();
  const addCodeRow = (code: string, rowId: number): void => {
    const arr = codeRows.get(code);
    if (!arr) codeRows.set(code, [rowId]);
    else if (!arr.includes(rowId)) arr.push(rowId);
  };

  // 成品：编码首见为准
  interface ProductCand { code: string; name: string; spec: string; barcode: string | null; brandCode: string }
  const products = new Map<string, ProductCand>();
  // 物料：编码首见为准；uomGuess 聚合；父产品按出现顺序
  interface MaterialCand {
    code: string; name: string; spec: string;
    segment: BomLine["segment"]; guesses: Set<BomLine["uomGuess"]>; parents: string[];
  }
  const materials = new Map<string, MaterialCand>();
  const uncodedCount = new Map<string, number>();

  for (const r of rows) {
    const b = r.payload;
    if (!isBomBlockPayload(b)) continue;
    if (b.productCode) {
      addCodeRow(b.productCode, r.id);
      if (!products.has(b.productCode)) {
        products.set(b.productCode, {
          code: b.productCode,
          name: b.productName,
          spec: b.productSpec,
          barcode: b.barcode,
          brandCode: b.brandCode,
        });
      }
    }
    for (const l of b.lines) {
      if (l.materialCode == null) {
        const nm = l.materialName || "(无名物料)";
        uncodedCount.set(nm, (uncodedCount.get(nm) ?? 0) + 1);
        continue;
      }
      addCodeRow(l.materialCode, r.id);
      let m = materials.get(l.materialCode);
      if (!m) {
        m = {
          code: l.materialCode,
          name: l.materialName,
          spec: l.materialSpec,
          segment: l.segment,
          guesses: new Set(),
          parents: [],
        };
        materials.set(l.materialCode, m);
      }
      m.guesses.add(l.uomGuess);
      if (b.productCode && !m.parents.includes(b.productCode)) m.parents.push(b.productCode);
    }
  }

  const allCodes = [...products.keys(), ...materials.keys()];
  const skuByCode = await loadSkuIdByCode(db, allCodes);

  const blocked: BlockedSku[] = [];
  const unresolvedBrands = new Set<string>();
  let existing = 0;

  type SkuInsert = typeof schema.skus.$inferInsert;
  const finishedPlans: SkuInsert[] = [];
  const materialPlans: SkuInsert[] = [];

  for (const p of [...products.values()].sort((a, b) => (a.code < b.code ? -1 : 1))) {
    if (skuByCode.has(p.code)) {
      existing++;
      continue;
    }
    const spuId = spuOfCode.get(p.code);
    if (spuId == null) {
      blocked.push({ code: p.code, kind: "finished", reason: "SPU 未放行" });
      continue;
    }
    const brandId = p.brandCode ? await resolve("brand", p.brandCode) : null;
    const needs = ["baseUom"]; // BOM 文件无基础单位——「件」为待复核占位，非猜测定案
    if (p.brandCode && brandId == null) {
      needs.push("brandId");
      unresolvedBrands.add(p.brandCode);
    }
    finishedPlans.push({
      code: p.code,
      name: p.name,
      spuId,
      spec: p.spec || null,
      skuType: "finished",
      baseUom: "件",
      barcode: p.barcode,
      brandId,
      lifecycle: "on_sale",
      attrs: { needsReview: needs, source: "bom_import" },
    });
  }

  for (const m of [...materials.values()].sort((a, b) => (a.code < b.code ? -1 : 1))) {
    if (skuByCode.has(m.code)) {
      existing++;
      continue;
    }
    let skuType: "raw" | "packaging";
    if (m.segment === "raw_bulk" || m.segment === "self_supplied") skuType = "raw";
    else if (m.segment === "primary_pack" || m.segment === "secondary_pack" || m.segment === "box") skuType = "packaging";
    else {
      blocked.push({ code: m.code, kind: "material", reason: "物料段位无法判定（segment=unknown）" });
      continue;
    }
    // v1 决策：物料挂其父成品的 SPU（同一产品族簇）——首个已放行 SPU 的父产品为准
    const parentWithSpu = m.parents.find((pc) => spuOfCode.has(pc));
    if (parentWithSpu == null) {
      blocked.push({ code: m.code, kind: "material", reason: "SPU 未放行（所有父产品均无已放行 SPU）" });
      continue;
    }
    const guesses = m.guesses;
    let baseUom = "个";
    let flag = true;
    if (guesses.size === 1 && guesses.has("count")) flag = false;
    else if (guesses.size === 1 && guesses.has("gram_ml")) baseUom = "g";
    materialPlans.push({
      code: m.code,
      name: m.name,
      spuId: spuOfCode.get(parentWithSpu)!,
      spec: m.spec || null,
      skuType,
      lossCategory: skuType === "raw" ? "raw" : "packaging",
      baseUom,
      lifecycle: "on_sale",
      attrs: { needsReview: flag ? ["baseUom"] : [], source: "bom_import" },
    });
  }

  // RT4-F5：同码既是成品又是物料（半成品作下级料的真实形态）——两侧都撤出计划、
  // 转行级阻塞，否则一并 INSERT 撞 skus.code UNIQUE 令整批回滚且 dry-run 与真放行背离。
  {
    const finishedCodes = new Set(finishedPlans.map((p) => p.code));
    const dual = materialPlans.filter((m) => finishedCodes.has(m.code)).map((m) => m.code);
    if (dual.length > 0) {
      const dualSet = new Set(dual);
      for (let i = finishedPlans.length - 1; i >= 0; i--) {
        if (dualSet.has(finishedPlans[i].code)) finishedPlans.splice(i, 1);
      }
      for (let i = materialPlans.length - 1; i >= 0; i--) {
        if (dualSet.has(materialPlans[i].code)) materialPlans.splice(i, 1);
      }
      for (const code of dualSet) {
        blocked.push({ code, kind: "material", reason: "同码同时为成品与物料（半成品形态）——待人工定型后单独建档" });
      }
    }
  }

  const uncoded = [...uncodedCount.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, occurrences]) => ({ name, occurrences }));

  // 名称交叉核对：总库存明细候选行（任何状态——仅信息比对，无写入）
  const nameCrossCheck: ReleaseSkusResult["nameCrossCheck"] = [];
  {
    const openRows: { payload: unknown }[] = await db
      .select({ payload: schema.stagingRows.payload })
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.targetTable, "stock_opening_candidate"));
    const openingName = new Map<string, string>();
    for (const r of openRows) {
      const p = r.payload as { skuCode?: unknown; skuName?: unknown };
      if (typeof p.skuCode === "string" && typeof p.skuName === "string" && !openingName.has(p.skuCode)) {
        openingName.set(p.skuCode, p.skuName);
      }
    }
    for (const p of products.values()) {
      const on = openingName.get(p.code);
      if (on && on !== p.name && nameCrossCheck.length < 100) {
        nameCrossCheck.push({ code: p.code, bomName: p.name, openingName: on });
      }
    }
  }

  const base = {
    createdFinished: finishedPlans.length,
    createdMaterials: materialPlans.length,
    createdCodes: [...finishedPlans, ...materialPlans].map((p) => p.code),
    existing,
    blocked,
    uncoded,
    unresolvedBrands: [...unresolvedBrands].sort(),
    nameCrossCheck,
  };
  if (args.dryRun) return { dryRun: true, ...base };

  // 阻塞原因写回贡献行：code → 行集合，行级合并消息（≤3 码 + 「等」）
  const rowBlockParts = new Map<number, string[]>();
  {
    const blockedByCode = new Map<string, string>();
    for (const b of blocked) if (!blockedByCode.has(b.code)) blockedByCode.set(b.code, b.reason);
    for (const [code, reason] of blockedByCode) {
      for (const rowId of codeRows.get(code) ?? []) {
        const parts = rowBlockParts.get(rowId) ?? [];
        parts.push(`${code}（${reason}）`);
        rowBlockParts.set(rowId, parts);
      }
    }
  }

  await db.transaction(async (tx: AnyDb) => {
    const all = [...finishedPlans, ...materialPlans];
    const CHUNK = 200;
    for (let i = 0; i < all.length; i += CHUNK) {
      await tx.insert(schema.skus).values(all.slice(i, i + CHUNK));
    }
    // 仅覆写本轮入选（pending/validated）行的 errorMsg——committed 行不在 rows 集合内，绝不触碰
    for (const [rowId, parts] of rowBlockParts) {
      const msg = `SKU 放行受阻：${parts.slice(0, 3).join("、")}${parts.length > 3 ? "等" : ""}`;
      await markBlocked(tx, rowId, msg);
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_sku",
      action: "release",
      after: {
        jobIds: args.jobIds ?? null,
        createdFinished: finishedPlans.length,
        createdMaterials: materialPlans.length,
        existing,
        blocked: blocked.length,
        uncoded: uncoded.length,
      },
    });
  });
  return { dryRun: false, ...base };
}

/* ══ 3) releaseBoms（§4.3 块人工闸）+ 批量生效审批 ═══════ */

