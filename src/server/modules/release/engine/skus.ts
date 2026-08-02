/** release 流水线：skus（自 engine.ts 拆出，行为未变） */
import { and, eq, inArray } from "drizzle-orm";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import {
  assertLegacyLocalIdentityMigrationAllowed,
  registerBomJobIdentityMapping,
  requireSkuImportIdentityMode,
  type SkuImportIdentityMode,
} from "@/server/import/sku-identity-mode";
import { resolveKnownReference } from "@/server/modules/dimension/resolver";
import { ApiError } from "@/server/modules/master/common";
import { allocateGovernedSkuCode } from "@/server/modules/master/sku-code-allocation";
import { checkCode } from "@/server/rules/code-rule";
import { isGovernedSkuCode, normalizeSkuOrigin } from "@/server/rules/sku-code";
import { isValidGtin } from "@/server/rules/sku-identifier";

import type { BomLine } from "@/server/import/adapters/bom";

import {
  assertRowsReleaseable,
  isBomBlockPayload,
  loadInternalSkuIdentityResolution,
  loadReleasedSpuIndex,
  loadSkuIdByCode,
  loadStagedRows,
  markBlocked,
  resolveDb,
  type AnyDb,
  type ReleaseUser,
} from "./common";
import { assertImportPreflight, type PreflightOverrides } from "./preflight";

/* ══ 2) releaseSkus（BOM 块 → 成品/物料建档） ═══════════ */

type BlockedSku = { code: string; kind: "finished" | "material"; reason: string };
type PlannedKind = BlockedSku["kind"];

export interface SkuIdentityMapping {
  sourceCode: string;
  /** null in new_master dry-runs: previews never consume or invent a permanent S1 identity. */
  skuCode: string | null;
  skuId: number | null;
  kind: PlannedKind;
}

export interface ReleaseSkusResult {
  dryRun: boolean;
  identityMode: SkuImportIdentityMode;
  createdFinished: number;
  createdMaterials: number;
  createdCodes: string[];
  plannedSourceCodes: string[];
  identityMappings: SkuIdentityMapping[];
  existing: number;
  blocked: BlockedSku[];
  /** 无编码物料——不放行，人工建档队列（§4.5 精神：不混入去重） */
  uncoded: { name: string; occurrences: number }[];
  /** 历史保留模式中未认领的 brandCode；new_master 会在取号前阻断。 */
  unresolvedBrands: string[];
  /** 与 stock_opening_candidate 的名称交叉核对（仅提示，不阻塞） */
  nameCrossCheck: { code: string; bomName: string; openingName: string }[];
}

function semanticText(value: string | null | undefined): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function materialSkuType(segment: BomLine["segment"]): "raw" | "packaging" | null {
  if (segment === "raw_bulk" || segment === "self_supplied") return "raw";
  if (segment === "primary_pack" || segment === "secondary_pack" || segment === "box") return "packaging";
  return null;
}

/** Source-code guards apply only when a selected production job would create a missing master. */
function invalidNewMasterSourceCode(code: string): string | null {
  if (isGovernedSkuCode(code)) return "源编码占用 S1 系统命名空间；S1 只能由事务取号器生成";
  if (/[/／]/.test(code)) return "斜杠组合码不是单一稳定身份；请拆分或完成人工认领";
  if (/^\d+$/.test(code)) {
    return code.length < 8
      ? "裸短数字不是有效主档编码"
      : "纯数字疑似条码；请按 GTIN/历史标识治理后再建档";
  }
  const verdict = checkCode(code);
  return verdict.ok ? null : verdict.reason ?? "源编码不合规";
}

function existingSemanticConflict(
  existing: { code: string; name: string; spec: string | null; skuType: string },
  expected: { sourceCode: string; name: string; spec: string; skuType: string },
): string | null {
  const reasons: string[] = [];
  if (existing.skuType !== expected.skuType) {
    reasons.push(`类型冲突：现有 ${existing.skuType}，导入 ${expected.skuType}`);
  }
  const currentName = semanticText(existing.name);
  const incomingName = semanticText(expected.name);
  if (currentName && incomingName && currentName !== incomingName) {
    reasons.push(`名称冲突：现有「${existing.name}」，导入「${expected.name}」`);
  }
  const currentSpec = semanticText(existing.spec);
  const incomingSpec = semanticText(expected.spec);
  if (currentSpec && incomingSpec && currentSpec !== incomingSpec) {
    reasons.push(`规格冲突：现有「${existing.spec}」，导入「${expected.spec}」`);
  }
  return reasons.length > 0
    ? `源编码 ${expected.sourceCode} 已指向 SKU ${existing.code}，但${reasons.join("；")}`
    : null;
}

interface ReleaseSkusArgs {
  jobIds?: number[];
  preflightOverrides?: PreflightOverrides;
  dryRun: boolean;
}

async function releaseSkusInternal(
  user: ReleaseUser,
  args: ReleaseSkusArgs,
  dbArg?: AnyDb,
): Promise<ReleaseSkusResult> {
  const db = await resolveDb(dbArg);
  const strictSelectedJobs = args.jobIds !== undefined;
  const identityMode = strictSelectedJobs
    ? await requireSkuImportIdentityMode(db, args.jobIds!)
    : "historical_preserve";
  await assertImportPreflight(db, user, args);
  const rows = await loadStagedRows(db, "bom_block", args.jobIds);
  const spuOfCode = await loadReleasedSpuIndex(db);

  // 编码 → 贡献 staging 行（阻塞原因写回行级——一个 bom_block 行贡献产品码与每个物料码）
  const codeRows = new Map<string, number[]>();
  const codeJobIds = new Map<string, Set<number>>();
  const addCodeRow = (code: string, rowId: number, jobId: number): void => {
    const arr = codeRows.get(code);
    if (!arr) codeRows.set(code, [rowId]);
    else if (!arr.includes(rowId)) arr.push(rowId);
    const jobs = codeJobIds.get(code) ?? new Set<number>();
    jobs.add(jobId);
    codeJobIds.set(code, jobs);
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
  const semanticConflicts = new Map<string, Set<string>>();
  const addSemanticConflict = (code: string, reason: string): void => {
    const reasons = semanticConflicts.get(code) ?? new Set<string>();
    reasons.add(reason);
    semanticConflicts.set(code, reasons);
  };

  for (const r of rows) {
    const b = r.payload;
    if (!isBomBlockPayload(b)) continue;
    if (b.productCode) {
      addCodeRow(b.productCode, r.id, r.importJobId);
      const prior = products.get(b.productCode);
      if (!prior) {
        products.set(b.productCode, {
          code: b.productCode,
          name: b.productName,
          spec: b.productSpec,
          barcode: b.barcode,
          brandCode: b.brandCode,
        });
      } else if (strictSelectedJobs) {
        if (semanticText(prior.name) && semanticText(b.productName) && semanticText(prior.name) !== semanticText(b.productName)) {
          addSemanticConflict(b.productCode, `同一源编码出现不同名称：「${prior.name}」/「${b.productName}」`);
        }
        if (semanticText(prior.spec) && semanticText(b.productSpec) && semanticText(prior.spec) !== semanticText(b.productSpec)) {
          addSemanticConflict(b.productCode, `同一源编码出现不同规格：「${prior.spec}」/「${b.productSpec}」`);
        }
        if (prior.barcode && b.barcode && prior.barcode !== b.barcode) {
          addSemanticConflict(b.productCode, `同一源编码出现不同 GTIN：${prior.barcode}/${b.barcode}`);
        } else if (!prior.barcode && b.barcode) {
          prior.barcode = b.barcode;
        }
        if (prior.brandCode && b.brandCode && prior.brandCode !== b.brandCode) {
          addSemanticConflict(b.productCode, `同一源编码出现不同品牌：${prior.brandCode}/${b.brandCode}`);
        } else if (!prior.brandCode && b.brandCode) {
          prior.brandCode = b.brandCode;
        }
      }
    }
    for (const l of b.lines) {
      if (l.materialCode == null) {
        const nm = l.materialName || "(无名物料)";
        uncodedCount.set(nm, (uncodedCount.get(nm) ?? 0) + 1);
        continue;
      }
      addCodeRow(l.materialCode, r.id, r.importJobId);
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
      } else if (strictSelectedJobs) {
        if (semanticText(m.name) && semanticText(l.materialName) && semanticText(m.name) !== semanticText(l.materialName)) {
          addSemanticConflict(l.materialCode, `同一源编码出现不同名称：「${m.name}」/「${l.materialName}」`);
        }
        if (semanticText(m.spec) && semanticText(l.materialSpec) && semanticText(m.spec) !== semanticText(l.materialSpec)) {
          addSemanticConflict(l.materialCode, `同一源编码出现不同规格：「${m.spec}」/「${l.materialSpec}」`);
        }
        const firstType = materialSkuType(m.segment);
        const nextType = materialSkuType(l.segment);
        if (firstType !== nextType) {
          addSemanticConflict(
            l.materialCode,
            `同一源编码出现不同类型：${firstType ?? "unknown"}/${nextType ?? "unknown"}`,
          );
        }
      }
      m.guesses.add(l.uomGuess);
      if (b.productCode && !m.parents.includes(b.productCode)) m.parents.push(b.productCode);
    }
  }

  if (strictSelectedJobs) {
    for (const code of products.keys()) {
      if (materials.has(code)) addSemanticConflict(code, "同一源编码同时声明为成品与物料");
    }
  }

  const allCodes = [...products.keys(), ...materials.keys()];
  const strictResolution = strictSelectedJobs
    ? await loadInternalSkuIdentityResolution(db, allCodes)
    : null;
  const skuByCode = strictResolution?.resolved ?? await loadSkuIdByCode(db, allCodes);
  const existingById = new Map<number, {
    id: number;
    code: string;
    name: string;
    spec: string | null;
    skuType: string;
    barcode: string | null;
  }>();
  const existingIds = [...new Set(skuByCode.values())];
  for (let i = 0; i < existingIds.length; i += 500) {
    const existingRows = await db
      .select({
        id: schema.skus.id,
        code: schema.skus.code,
        name: schema.skus.name,
        spec: schema.skus.spec,
        skuType: schema.skus.skuType,
        barcode: schema.skus.barcode,
      })
      .from(schema.skus)
      .where(inArray(schema.skus.id, existingIds.slice(i, i + 500)));
    for (const row of existingRows) existingById.set(row.id, row);
  }

  interface CanonicalBrandIdentity { id: number; code: string }
  const canonicalBrandCache = new Map<string, CanonicalBrandIdentity | null>();
  const resolveCanonicalBrand = async (raw: string): Promise<CanonicalBrandIdentity | null> => {
    if (canonicalBrandCache.has(raw)) return canonicalBrandCache.get(raw)!;
    const targetId = await resolveKnownReference(db, "brand", raw);
    if (targetId == null) {
      canonicalBrandCache.set(raw, null);
      return null;
    }
    const [brand]: CanonicalBrandIdentity[] = await db
      .select({ id: schema.brands.id, code: schema.brands.code })
      .from(schema.brands)
      .where(and(eq(schema.brands.id, targetId), eq(schema.brands.active, true)));
    const canonical = brand ?? null;
    canonicalBrandCache.set(raw, canonical);
    return canonical;
  };

  type GtinDecision = { value: string; action: "register" | "noop" };
  const gtinDecisionBySourceCode = new Map<string, GtinDecision>();
  const gtinBlockReasonByCode = new Map<string, string>();
  if (strictSelectedJobs) {
    const sourcesByGtin = new Map<string, string[]>();
    for (const product of products.values()) {
      const gtin = product.barcode?.trim() ?? "";
      if (!gtin) continue;
      if (!isValidGtin(gtin)) {
        gtinBlockReasonByCode.set(product.code, `GTIN ${gtin} 校验位无效；仅接受有效 GTIN-8/12/13/14`);
        continue;
      }
      const sources = sourcesByGtin.get(gtin) ?? [];
      sources.push(product.code);
      sourcesByGtin.set(gtin, sources);
    }
    for (const [gtin, sources] of sourcesByGtin) {
      const targets = sources.map((source) => skuByCode.get(source) ?? null);
      const oneSharedExistingTarget = targets[0] != null && targets.every((target) => target === targets[0]);
      if (sources.length > 1 && !oneSharedExistingTarget) {
        for (const source of sources) {
          gtinBlockReasonByCode.set(source, `GTIN ${gtin} 在本批被多个来源编码共用：${sources.join("/")}`);
        }
      }
    }

    const gtins = [...sourcesByGtin.keys()];
    interface IdentifierOwner {
      skuId: number;
      kind: string;
      scope: string;
      packagingLevel: string | null;
      isPrimary: boolean;
      active: boolean;
    }
    const identifiersByGtin = new Map<string, IdentifierOwner[]>();
    const legacyBarcodeOwnersByGtin = new Map<string, Set<number>>();
    for (let index = 0; index < gtins.length; index += 500) {
      const chunk = gtins.slice(index, index + 500);
      const identifiers: Array<IdentifierOwner & { value: string }> = await db
        .select({
          value: schema.skuIdentifiers.value,
          skuId: schema.skuIdentifiers.skuId,
          kind: schema.skuIdentifiers.kind,
          scope: schema.skuIdentifiers.scope,
          packagingLevel: schema.skuIdentifiers.packagingLevel,
          isPrimary: schema.skuIdentifiers.isPrimary,
          active: schema.skuIdentifiers.active,
        })
        .from(schema.skuIdentifiers)
        .where(and(
          inArray(schema.skuIdentifiers.kind, ["gtin", "legacy"]),
          inArray(schema.skuIdentifiers.value, chunk),
        ));
      for (const row of identifiers) {
        const owners = identifiersByGtin.get(row.value) ?? [];
        owners.push(row);
        identifiersByGtin.set(row.value, owners);
      }
      const legacyBarcodes: { id: number; barcode: string | null }[] = await db
        .select({ id: schema.skus.id, barcode: schema.skus.barcode })
        .from(schema.skus)
        .where(inArray(schema.skus.barcode, chunk));
      for (const row of legacyBarcodes) {
        if (!row.barcode) continue;
        const owners = legacyBarcodeOwnersByGtin.get(row.barcode) ?? new Set<number>();
        owners.add(row.id);
        legacyBarcodeOwnersByGtin.set(row.barcode, owners);
      }
    }

    const primaryEachGtinBySku = new Map<number, string>();
    const productTargetIds = [...new Set([...products.keys()]
      .map((source) => skuByCode.get(source))
      .filter((id): id is number => id != null))];
    for (let index = 0; index < productTargetIds.length; index += 500) {
      const existingPrimary: { skuId: number; value: string }[] = await db
        .select({ skuId: schema.skuIdentifiers.skuId, value: schema.skuIdentifiers.value })
        .from(schema.skuIdentifiers)
        .where(and(
          inArray(schema.skuIdentifiers.skuId, productTargetIds.slice(index, index + 500)),
          eq(schema.skuIdentifiers.kind, "gtin"),
          eq(schema.skuIdentifiers.scope, "GS1"),
          eq(schema.skuIdentifiers.packagingLevel, "each"),
          eq(schema.skuIdentifiers.active, true),
          eq(schema.skuIdentifiers.isPrimary, true),
        ));
      for (const row of existingPrimary) primaryEachGtinBySku.set(row.skuId, row.value);
    }

    for (const [gtin, sources] of sourcesByGtin) {
      for (const source of sources) {
        if (gtinBlockReasonByCode.has(source)) continue;
        const targetId = skuByCode.get(source) ?? null;
        const identifiers = identifiersByGtin.get(gtin) ?? [];
        const inactive = identifiers.filter((identifier) => !identifier.active);
        if (inactive.length > 0) {
          const owners = [...new Set(inactive.map((identifier) => identifier.skuId))].sort((a, b) => a - b);
          gtinBlockReasonByCode.set(
            source,
            `GTIN ${gtin} 已停用但仍保留于 SKU #${owners.join("/#")}；须先人工裁决，禁止静默重用`,
          );
          continue;
        }
        const otherIdentifierOwners = identifiers
          .filter((identifier) => targetId == null || identifier.skuId !== targetId)
          .map((identifier) => identifier.skuId);
        const otherBarcodeOwners = [...(legacyBarcodeOwnersByGtin.get(gtin) ?? new Set<number>())]
          .filter((owner) => targetId == null || owner !== targetId);
        const otherOwners = [...new Set([...otherIdentifierOwners, ...otherBarcodeOwners])].sort((a, b) => a - b);
        if (otherOwners.length > 0) {
          gtinBlockReasonByCode.set(source, `GTIN ${gtin} 已归属 SKU #${otherOwners.join("/#")}，禁止重复建档`);
          continue;
        }
        if (targetId != null) {
          const existingSku = existingById.get(targetId);
          if (existingSku?.barcode && existingSku.barcode !== gtin) {
            gtinBlockReasonByCode.set(
              source,
              `SKU ${existingSku.code} 已登记条码 ${existingSku.barcode}，与本次 GTIN ${gtin} 冲突`,
            );
            continue;
          }
          const primaryEach = primaryEachGtinBySku.get(targetId);
          if (primaryEach && primaryEach !== gtin) {
            gtinBlockReasonByCode.set(
              source,
              `SKU #${targetId} 已有主单品 GTIN ${primaryEach}，不能静默改为 ${gtin}`,
            );
            continue;
          }
        }
        const exactActiveGtin = identifiers.find((identifier) => (
          identifier.kind === "gtin"
          && identifier.active
          && targetId != null
          && identifier.skuId === targetId
        ));
        if (exactActiveGtin) {
          if (exactActiveGtin.scope !== "GS1" || exactActiveGtin.packagingLevel !== "each") {
            gtinBlockReasonByCode.set(
              source,
              `GTIN ${gtin} 已登记于 SKU #${targetId} 的非单品包装层级；须人工裁决`,
            );
            continue;
          }
          gtinDecisionBySourceCode.set(source, { value: gtin, action: "noop" });
          continue;
        }
        gtinDecisionBySourceCode.set(source, { value: gtin, action: "register" });
      }
    }
  }

  const blocked: BlockedSku[] = [];
  const unresolvedBrands = new Set<string>();
  let existing = 0;

  type SkuInsert = typeof schema.skus.$inferInsert;
  const finishedPlans: SkuInsert[] = [];
  const materialPlans: SkuInsert[] = [];
  const originBySourceCode = new Map<string, string | null>();
  const resolvedTargetBySource = new Map<string, number>();

  for (const p of [...products.values()].sort((a, b) => (a.code < b.code ? -1 : 1))) {
    const inputConflict = semanticConflicts.get(p.code);
    if (inputConflict?.size) {
      blocked.push({ code: p.code, kind: "finished", reason: [...inputConflict].join("；") });
      continue;
    }
    if (strictSelectedJobs && identityMode === "new_master") {
      const invalid = invalidNewMasterSourceCode(p.code);
      if (invalid) {
        blocked.push({ code: p.code, kind: "finished", reason: invalid });
        continue;
      }
    }
    const reservedTargets = strictResolution?.reserved.get(p.code);
    if (reservedTargets) {
      blocked.push({
        code: p.code,
        kind: "finished",
        reason: `INTERNAL 历史标识已停用但仍保留于 SKU #${reservedTargets.join("/#")}；须先人工裁决后再放行`,
      });
      continue;
    }
    const ambiguousTargets = strictResolution?.ambiguous.get(p.code);
    if (ambiguousTargets) {
      blocked.push({
        code: p.code,
        kind: "finished",
        reason: `INTERNAL 身份歧义：同时指向 SKU #${ambiguousTargets.join("/#")}；请先建立 GLOBAL 裁决`,
      });
      continue;
    }
    const gtinReason = gtinBlockReasonByCode.get(p.code);
    if (gtinReason) {
      blocked.push({ code: p.code, kind: "finished", reason: gtinReason });
      continue;
    }
    const existingId = skuByCode.get(p.code);
    if (existingId != null) {
      const existingSku = existingById.get(existingId);
      if (strictSelectedJobs && !existingSku) {
        blocked.push({
          code: p.code,
          kind: "finished",
          reason: `源编码解析到不存在的 SKU #${existingId}；请先修复别名归属`,
        });
        continue;
      }
      const conflict = strictSelectedJobs && existingSku
        ? existingSemanticConflict(existingSku, {
          sourceCode: p.code,
          name: p.name,
          spec: p.spec,
          skuType: "finished",
        })
        : null;
      if (conflict) {
        blocked.push({ code: p.code, kind: "finished", reason: conflict });
        continue;
      }
      resolvedTargetBySource.set(p.code, existingId);
      existing++;
      continue;
    }
    if (strictSelectedJobs && identityMode === "historical_preserve") {
      const invalid = invalidNewMasterSourceCode(p.code);
      if (invalid) {
        blocked.push({ code: p.code, kind: "finished", reason: invalid });
        continue;
      }
    }
    const spuId = spuOfCode.get(p.code);
    if (spuId == null) {
      blocked.push({ code: p.code, kind: "finished", reason: "SPU 未放行" });
      continue;
    }
    const canonicalBrand = p.brandCode ? await resolveCanonicalBrand(p.brandCode) : null;
    if (strictSelectedJobs && identityMode === "new_master" && !canonicalBrand) {
      blocked.push({
        code: p.code,
        kind: "finished",
        reason: `品牌来源「${p.brandCode || "(空)"}」未能唯一解析到有效品牌主档；新主档取号已阻断`,
      });
      continue;
    }
    let canonicalOrigin: string | null = null;
    if (canonicalBrand) {
      try {
        canonicalOrigin = normalizeSkuOrigin(canonicalBrand.code);
      } catch (error) {
        blocked.push({ code: p.code, kind: "finished", reason: (error as Error).message });
        continue;
      }
    }
    const brandId = canonicalBrand?.id ?? null;
    const needs = ["baseUom"]; // BOM 文件无基础单位——「件」为待复核占位，非猜测定案
    if (p.brandCode && brandId == null) {
      needs.push("brandId");
      unresolvedBrands.add(p.brandCode);
    }
    const gtinDecision = gtinDecisionBySourceCode.get(p.code);
    finishedPlans.push({
      code: p.code,
      name: p.name,
      spuId,
      spec: p.spec || null,
      skuType: "finished",
      baseUom: "件",
      barcode: gtinDecision?.value ?? p.barcode,
      barcodeStatus: strictSelectedJobs && gtinDecision ? "valid" : null,
      brandId,
      lifecycle: "on_sale",
      attrs: { needsReview: needs, source: "bom_import" },
    });
    originBySourceCode.set(p.code, canonicalOrigin);
  }

  for (const m of [...materials.values()].sort((a, b) => (a.code < b.code ? -1 : 1))) {
    const inputConflict = semanticConflicts.get(m.code);
    if (inputConflict?.size) {
      blocked.push({ code: m.code, kind: "material", reason: [...inputConflict].join("；") });
      continue;
    }
    const expectedType = materialSkuType(m.segment);
    if (strictSelectedJobs && identityMode === "new_master") {
      const invalid = invalidNewMasterSourceCode(m.code);
      if (invalid) {
        blocked.push({ code: m.code, kind: "material", reason: invalid });
        continue;
      }
    }
    const reservedTargets = strictResolution?.reserved.get(m.code);
    if (reservedTargets) {
      blocked.push({
        code: m.code,
        kind: "material",
        reason: `INTERNAL 历史标识已停用但仍保留于 SKU #${reservedTargets.join("/#")}；须先人工裁决后再放行`,
      });
      continue;
    }
    const ambiguousTargets = strictResolution?.ambiguous.get(m.code);
    if (ambiguousTargets) {
      blocked.push({
        code: m.code,
        kind: "material",
        reason: `INTERNAL 身份歧义：同时指向 SKU #${ambiguousTargets.join("/#")}；请先建立 GLOBAL 裁决`,
      });
      continue;
    }
    const existingId = skuByCode.get(m.code);
    if (existingId != null) {
      const existingSku = existingById.get(existingId);
      if (strictSelectedJobs && !existingSku) {
        blocked.push({
          code: m.code,
          kind: "material",
          reason: `源编码解析到不存在的 SKU #${existingId}；请先修复别名归属`,
        });
        continue;
      }
      const conflict = strictSelectedJobs && existingSku && expectedType
        ? existingSemanticConflict(existingSku, {
          sourceCode: m.code,
          name: m.name,
          spec: m.spec,
          skuType: expectedType,
        })
        : null;
      if (conflict) {
        blocked.push({ code: m.code, kind: "material", reason: conflict });
        continue;
      }
      resolvedTargetBySource.set(m.code, existingId);
      existing++;
      continue;
    }
    if (strictSelectedJobs && identityMode === "historical_preserve") {
      const invalid = invalidNewMasterSourceCode(m.code);
      if (invalid) {
        blocked.push({ code: m.code, kind: "material", reason: invalid });
        continue;
      }
    }
    let skuType: "raw" | "packaging";
    if (expectedType) skuType = expectedType;
    else {
      blocked.push({ code: m.code, kind: "material", reason: "物料段位无法判定（segment=unknown）" });
      continue;
    }
    // v1 关系仍挂首个已放行父 SPU；S1 来源则按全部父产品一致性计算，避免首行品牌污染共享料。
    const parentWithSpu = m.parents.find((pc) => spuOfCode.has(pc));
    if (parentWithSpu == null) {
      blocked.push({ code: m.code, kind: "material", reason: "SPU 未放行（所有父产品均无已放行 SPU）" });
      continue;
    }
    let sourceOrigin: string | null = null;
    if (strictSelectedJobs && identityMode === "new_master") {
      try {
        const parentOrigins = new Set<string>();
        for (const parentCode of m.parents) {
          const rawBrand = products.get(parentCode)?.brandCode ?? "";
          const canonicalBrand = rawBrand ? await resolveCanonicalBrand(rawBrand) : null;
          if (!canonicalBrand) {
            throw new Error(
              `父成品 ${parentCode} 的品牌来源「${rawBrand || "(空)"}」未能唯一解析到有效品牌主档`,
            );
          }
          parentOrigins.add(normalizeSkuOrigin(canonicalBrand.code));
        }
        sourceOrigin = parentOrigins.size === 1 ? [...parentOrigins][0] : null;
      } catch (error) {
        blocked.push({ code: m.code, kind: "material", reason: (error as Error).message });
        continue;
      }
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
    originBySourceCode.set(m.code, sourceOrigin);
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

  const allPlans = [...finishedPlans, ...materialPlans];
  const plannedSourceCodes = allPlans.map((plan) => String(plan.code));
  const base = {
    identityMode,
    createdFinished: finishedPlans.length,
    createdMaterials: materialPlans.length,
    plannedSourceCodes,
    existing,
    blocked,
    uncoded,
    unresolvedBrands: [...unresolvedBrands].sort(),
    nameCrossCheck,
  };
  if (args.dryRun) {
    return {
      dryRun: true,
      ...base,
      createdCodes: identityMode === "historical_preserve" ? plannedSourceCodes : [],
      identityMappings: identityMode === "new_master"
        ? allPlans.map((plan, index) => ({
          sourceCode: String(plan.code),
          skuCode: null,
          skuId: null,
          kind: index < finishedPlans.length ? "finished" : "material",
        }))
        : [],
    };
  }

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

  const identityMappings: SkuIdentityMapping[] = [];
  await db.transaction(async (tx: AnyDb) => {
    await assertRowsReleaseable(tx, rows.map((row) => row.id));
    const registeredGtins = new Set<string>();
    const registerGtin = async (sourceCode: string, skuId: number): Promise<void> => {
      const decision = gtinDecisionBySourceCode.get(sourceCode);
      if (!decision || decision.action === "noop") return;
      const gtin = decision.value;
      const registrationKey = `${skuId}\0${gtin}`;
      if (registeredGtins.has(registrationKey)) return;
      await tx.insert(schema.skuIdentifiers).values({
        skuId,
        kind: "gtin",
        value: gtin,
        scope: "GS1",
        uom: null,
        packagingLevel: "each",
        isPrimary: true,
        active: true,
        note: `BOM 成品单品 GTIN${args.jobIds ? `; jobs ${args.jobIds.join(",")}` : ""}`,
        createdBy: user.id,
      });
      await tx
        .update(schema.skus)
        .set({ barcode: gtin, barcodeStatus: "valid", updatedAt: new Date() })
        .where(eq(schema.skus.id, skuId));
      registeredGtins.add(registrationKey);
    };
    if (identityMode === "historical_preserve") {
      const CHUNK = 200;
      for (let i = 0; i < allPlans.length; i += CHUNK) {
        const created: { id: number; code: string }[] = await tx
          .insert(schema.skus)
          .values(allPlans.slice(i, i + CHUNK))
          .returning({ id: schema.skus.id, code: schema.skus.code });
        for (const row of created) {
          resolvedTargetBySource.set(row.code, row.id);
        }
      }
    } else {
      for (let index = 0; index < allPlans.length; index++) {
        const plan = allPlans[index];
        const sourceCode = String(plan.code);
        const skuCode = await allocateGovernedSkuCode(
          tx,
          originBySourceCode.get(sourceCode) ?? null,
          plan.skuType,
        );
        const [created] = await tx
          .insert(schema.skus)
          .values({ ...plan, code: skuCode })
          .returning({ id: schema.skus.id, code: schema.skus.code });
        await tx.insert(schema.skuIdentifiers).values({
          skuId: created.id,
          kind: "legacy",
          value: sourceCode,
          scope: "INTERNAL",
          uom: null,
          packagingLevel: null,
          isPrimary: true,
          active: true,
          note: `BOM new_master source identity${args.jobIds ? `; jobs ${args.jobIds.join(",")}` : ""}`,
          createdBy: user.id,
        });
        resolvedTargetBySource.set(sourceCode, created.id);
        identityMappings.push({
          sourceCode,
          skuCode: created.code,
          skuId: created.id,
          kind: index < finishedPlans.length ? "finished" : "material",
        });
      }
    }
    for (const [sourceCode, targetId] of resolvedTargetBySource) {
      await registerGtin(sourceCode, targetId);
    }
    if (strictSelectedJobs) {
      for (const [sourceCode, targetId] of resolvedTargetBySource) {
        for (const jobId of codeJobIds.get(sourceCode) ?? []) {
          await registerBomJobIdentityMapping(tx, {
            jobId,
            sourceCode,
            targetId,
            userId: user.id,
          });
        }
      }
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
        identityMode,
        identityMappings,
        createdFinished: finishedPlans.length,
        createdMaterials: materialPlans.length,
        existing,
        blocked: blocked.length,
        uncoded: uncoded.length,
      },
    });
  });
  return {
    dryRun: false,
    ...base,
    createdCodes: identityMode === "new_master"
      ? identityMappings.map((mapping) => mapping.skuCode!).filter(Boolean)
      : plannedSourceCodes,
    identityMappings,
  };
}

/** Production release contract: every call is explicitly scoped to completed BOM jobs. */
export async function releaseSkus(
  user: ReleaseUser,
  args: {
    jobIds: number[];
    preflightOverrides?: PreflightOverrides;
    dryRun: boolean;
  },
  dbArg?: AnyDb,
): Promise<ReleaseSkusResult> {
  if (!Array.isArray(args.jobIds)) {
    throw new ApiError(400, "SKU 放行必须显式绑定导入任务");
  }
  return releaseSkusInternal(user, args, dbArg);
}

/**
 * One-shot compatibility entrypoint for local PGlite migrations only.
 * Its unmistakable name and runtime guard keep HTTP/API callers on the job-scoped contract.
 */
export async function releaseSkusForLegacyLocalMigration(
  user: ReleaseUser,
  args: { preflightOverrides?: PreflightOverrides; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseSkusResult> {
  assertLegacyLocalIdentityMigrationAllowed();
  return releaseSkusInternal(user, args, dbArg);
}

/* ══ 3) releaseBoms（§4.3 块人工闸）+ 批量生效审批 ═══════ */
