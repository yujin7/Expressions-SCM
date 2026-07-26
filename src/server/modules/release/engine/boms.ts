/** release 流水线：boms（自 engine.ts 拆出，行为未变） */
import { inArray } from "drizzle-orm";

import * as schema from "@/db/schema";

import type {  BomLine } from "@/server/import/adapters/bom";

import { type AnyDb, type ReleaseUser, resolveDb, loadStagedRows, commitRows, markBlocked, aliasCache, loadSkuIdByCode, isBomBlockPayload } from "./common";

export type BomResolution = { decision: "active" | "retired" | "skip" };

export interface ReleaseBomsResult {
  dryRun: boolean;
  created: number;
  /** 候选生效（draft，待 activateReleasedBoms 批审）；retired 版本已直接落库 */
  candidates: { bomId: number | null; stagingRowId: number; productCode: string; versionNo: string }[];
  retired: number;
  skipped: number;
  blocked: { stagingRowId: number; productCode: string | null; reason: string }[];
  lineSkips: { stagingRowId: number; productCode: string; materialName: string; reason: string }[];
  unresolvedSuppliers: string[];
  /** 人工定 active 但因同产品更晚块存在而被降级的裁决冲突（RT4-P3：不再静默） */
  demotedActive: { stagingRowId: number; productCode: string }[];
  releaseRunId: number | null;
}

const UOM_LABEL: Record<BomLine["uomGuess"], string | null> = {
  count: "计数",
  gram_ml: "克/毫升",
  percent: "%",
  unknown: null,
};

export async function releaseBoms(
  user: ReleaseUser,
  args: { jobIds?: number[]; resolutions?: Record<string, BomResolution>; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseBomsResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, "bom_block", args.jobIds);
  const resolve = aliasCache(db);
  const resolutions = args.resolutions ?? {};

  // 预载所有编码 → skuId
  const codes: string[] = [];
  for (const r of rows) {
    const b = r.payload;
    if (!isBomBlockPayload(b)) continue;
    if (b.productCode) codes.push(b.productCode);
    for (const l of b.lines) if (l.materialCode) codes.push(l.materialCode);
  }
  const skuByCode = await loadSkuIdByCode(db, codes);

  interface PlannedLine {
    materialSkuId: number;
    qtyPer: string;
    uom: string | null;
    remark: string | null;
    preferredSupplierId: number | null;
  }
  interface Plan {
    rowId: number;
    productCode: string;
    productSkuId: number;
    decision: "active" | "retired";
    lines: PlannedLine[];
  }

  const plans: Plan[] = [];
  const blocked: ReleaseBomsResult["blocked"] = [];
  const lineSkips: ReleaseBomsResult["lineSkips"] = [];
  const unresolvedSuppliers = new Set<string>();
  let skipped = 0;

  for (const r of rows) {
    const b = r.payload;
    if (!isBomBlockPayload(b)) {
      blocked.push({ stagingRowId: r.id, productCode: null, reason: "载荷非 BOM 块" });
      continue;
    }
    if (!b.productCode) {
      blocked.push({ stagingRowId: r.id, productCode: null, reason: "无产品编码（解析期脏值，见拒收道）" });
      continue;
    }
    const resolution = resolutions[String(r.id)];
    // §4.3 强制人工闸：歧义块必须携带人工裁决，禁止启发式定 active
    if (b.ambiguous && !resolution) {
      blocked.push({ stagingRowId: r.id, productCode: b.productCode, reason: "歧义块需人工裁决（§4.3：规格变体 vs 旧版本）" });
      continue;
    }
    if (resolution?.decision === "skip") {
      skipped++;
      continue;
    }
    const productSkuId = skuByCode.get(b.productCode);
    if (productSkuId == null) {
      blocked.push({ stagingRowId: r.id, productCode: b.productCode, reason: "SKU 未放行" });
      continue;
    }

    const planned: PlannedLine[] = [];
    const missing: string[] = [];
    for (const l of b.lines) {
      if (l.materialCode == null) {
        lineSkips.push({ stagingRowId: r.id, productCode: b.productCode, materialName: l.materialName, reason: "无编码物料" });
        continue;
      }
      if (l.qtyPer == null || typeof l.qtyPer !== "number" || !Number.isFinite(l.qtyPer)) {
        lineSkips.push({
          stagingRowId: r.id,
          productCode: b.productCode,
          materialName: l.materialName,
          reason: `用量无法解析（原文「${l.qtyPerRaw}」）`,
        });
        continue;
      }
      const matId = skuByCode.get(l.materialCode);
      if (matId == null) {
        missing.push(l.materialCode);
        continue;
      }
      let supplierId: number | null = null;
      const supRaw = (l.supplierRaw ?? "").trim();
      if (supRaw && supRaw !== "/") {
        supplierId = await resolve("supplier_oem", supRaw);
        if (supplierId == null) unresolvedSuppliers.add(supRaw);
      }
      const remarkParts: string[] = [];
      if (l.texture) remarkParts.push(l.texture);
      if (l.uomGuess !== "count" && l.qtyPerRaw && l.qtyPerRaw !== String(l.qtyPer)) {
        remarkParts.push(`用量原文:${l.qtyPerRaw}`);
      }
      planned.push({
        materialSkuId: matId,
        qtyPer: String(l.qtyPer),
        uom: UOM_LABEL[l.uomGuess],
        remark: remarkParts.length ? remarkParts.join(" | ") : null,
        preferredSupplierId: supplierId,
      });
    }
    if (missing.length > 0) {
      blocked.push({ stagingRowId: r.id, productCode: b.productCode, reason: `SKU 未放行：${missing.join("/")}` });
      continue;
    }
    if (planned.length === 0) {
      blocked.push({ stagingRowId: r.id, productCode: b.productCode, reason: "无有效物料行" });
      continue;
    }
    plans.push({
      rowId: r.id,
      productCode: b.productCode,
      productSkuId,
      decision: resolution?.decision ?? (b.versionMarker === "retired" ? "retired" : "active"),
      lines: planned,
    });
  }

  // 同产品多候选生效：按 staging 顺序保留最后一个为候选，其余降级 retired（部分唯一索引永不受威胁）
  const byProduct = new Map<number, Plan[]>();
  for (const p of plans) {
    const arr = byProduct.get(p.productSkuId);
    if (arr) arr.push(p);
    else byProduct.set(p.productSkuId, [p]);
  }
  // RT4-P3：多 active 降级不再静默——人工把同产品两块都定 active 属裁决冲突，逐块留痕报告
  const demotedActive: { stagingRowId: number; productCode: string }[] = [];
  for (const group of byProduct.values()) {
    const actives = group.filter((p) => p.decision === "active");
    for (let i = 0; i < actives.length - 1; i++) {
      actives[i].decision = "retired";
      if (resolutions[String(actives[i].rowId)]?.decision === "active") {
        demotedActive.push({ stagingRowId: actives[i].rowId, productCode: actives[i].productCode });
      }
    }
  }

  // 版本号：接续既有版本数（V{n} 冲突则顺延），组内按 staging 顺序
  const productIds = [...byProduct.keys()];
  const existingVersions = new Map<number, Set<string>>();
  if (productIds.length > 0) {
    const vRows: { productSkuId: number; versionNo: string }[] = await db
      .select({ productSkuId: schema.boms.productSkuId, versionNo: schema.boms.versionNo })
      .from(schema.boms)
      .where(inArray(schema.boms.productSkuId, productIds));
    for (const v of vRows) {
      const set = existingVersions.get(v.productSkuId) ?? new Set<string>();
      set.add(v.versionNo);
      existingVersions.set(v.productSkuId, set);
    }
  }
  const versionOf = new Map<number, string>(); // rowId → versionNo
  for (const [pid, group] of byProduct) {
    const used = existingVersions.get(pid) ?? new Set<string>();
    let n = used.size;
    for (const p of group) {
      do n++; while (used.has(`V${n}`));
      const v = `V${n}`;
      used.add(v);
      versionOf.set(p.rowId, v);
    }
  }

  const candidatePlans = plans.filter((p) => p.decision === "active");
  const retiredPlans = plans.filter((p) => p.decision === "retired");

  if (args.dryRun) {
    return {
      dryRun: true,
      created: plans.length,
      candidates: candidatePlans.map((p) => ({
        bomId: null,
        stagingRowId: p.rowId,
        productCode: p.productCode,
        versionNo: versionOf.get(p.rowId)!,
      })),
      retired: retiredPlans.length,
      skipped,
      blocked,
      lineSkips,
      unresolvedSuppliers: [...unresolvedSuppliers].sort(),
      demotedActive,
      releaseRunId: null,
    };
  }

  const candidates: ReleaseBomsResult["candidates"] = [];
  let releaseRunId: number | null = null;
  await db.transaction(async (tx: AnyDb) => {
    const candidateBomIds: number[] = [];
    for (const p of plans) {
      const [bom] = await tx
        .insert(schema.boms)
        .values({
          productSkuId: p.productSkuId,
          versionNo: versionOf.get(p.rowId)!,
          // 候选一律 draft 落库，生效走批量审批（activateReleasedBoms）——绝不直接置 active
          status: p.decision === "retired" ? "retired" : "draft",
          createdBy: user.id,
        })
        .returning({ id: schema.boms.id });
      await tx.insert(schema.bomLines).values(
        p.lines.map((l) => ({
          bomId: bom.id,
          materialSkuId: l.materialSkuId,
          qtyPer: l.qtyPer,
          lossRatePct: "0",
          uom: l.uom,
          remark: l.remark,
          preferredSupplierId: l.preferredSupplierId,
        })),
      );
      await commitRows(tx, [p.rowId], bom.id);
      if (p.decision === "active") {
        candidateBomIds.push(bom.id);
        candidates.push({
          bomId: bom.id,
          stagingRowId: p.rowId,
          productCode: p.productCode,
          versionNo: versionOf.get(p.rowId)!,
        });
      }
    }
    for (const bl of blocked) await markBlocked(tx, bl.stagingRowId, bl.reason);
    // 审计行需要 id 作为 releaseRunId（activate 按 run 找候选）——同表同形，直插取 returning
    const [audit] = await tx
      .insert(schema.auditLogs)
      .values({
        userId: user.id,
        entity: "release_bom",
        action: "release",
        after: {
          jobIds: args.jobIds ?? null,
          created: plans.length,
          candidateBomIds,
          retired: retiredPlans.length,
          skipped,
          blocked: blocked.length,
          lineSkips: lineSkips.length,
        },
      })
      .returning({ id: schema.auditLogs.id });
    releaseRunId = audit.id;
  });

  return {
    dryRun: false,
    created: plans.length,
    candidates,
    retired: retiredPlans.length,
    skipped,
    blocked,
    lineSkips,
    unresolvedSuppliers: [...unresolvedSuppliers].sort(),
    demotedActive,
    releaseRunId,
  };
}

