/**
 * 全域数据血缘只读巡检。
 *
 * 运行前必须停掉占用同一 PGlite 目录的 dev server：
 *   npm run data:audit -- --source-root /Users/yj/Desktop/SCM
 *
 * 输出 JSON，供人工审计/CI 留证；不改源文件、不写业务表、不自动合并疑似重复 SKU。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import { getDataHealth, getDuplicateCandidates } from "../src/server/modules/report/data-health";
import { isGovernedSkuCode, parseGovernedSkuCode } from "../src/server/rules/sku-code";
import {
  isValidGtin,
  normalizeSkuIdentifierScope,
} from "../src/server/rules/sku-identifier";

type SourceRole = "fact" | "configuration" | "requirements";

interface SourceSpec {
  filename: string;
  role: SourceRole;
  purpose: string;
  expectedTemplates?: string[];
  /** 一个逻辑导入由多份文件组成；hash 应出现在 import_jobs.scope.sources。 */
  compositeTemplate?: string;
}

const SOURCES: SourceSpec[] = [
  { filename: "【DEVIANCE】产品bom表.xlsx", role: "fact", purpose: "DEVIANCE BOM/物料/加工费", expectedTemplates: ["bom"] },
  { filename: "【EXPRESSIONS】产品bom表.xlsx", role: "fact", purpose: "EXPRESSIONS BOM/物料/加工费", expectedTemplates: ["bom"] },
  { filename: "【NING】产品bom表.xlsx", role: "fact", purpose: "NING BOM/物料/加工费", expectedTemplates: ["bom"] },
  { filename: "电商部库存明细26-7-21.xlsx", role: "fact", purpose: "库存期初/快照权威长表", expectedTemplates: ["inventory_long_721"] },
  { filename: "7月电商组效期占比情况-仅数量.xlsx", role: "fact", purpose: "批次效期参考层", expectedTemplates: ["expiry_batch_202607"] },
  { filename: "26年产品销量汇总（6月）.xlsx", role: "fact", purpose: "月销量 + SKU 生产周期", expectedTemplates: ["sales_monthly_summary", "sku_leadtime"] },
  { filename: "2026年成品在途订单实时进度表---新版.xlsx", role: "fact", purpose: "成品/包材在途 + OEM 映射 + MOQ/周期", expectedTemplates: ["transit", "sku_leadtime"] },
  { filename: "6月份业务部需求&计划&达成统计表.xlsx", role: "fact", purpose: "渠道需求/达成/借调", expectedTemplates: ["demand"] },
  { filename: "6月份总货盘情况表-PMC.xlsx", role: "fact", purpose: "货盘/滞销/人工处置注记", expectedTemplates: ["pallet"] },
  { filename: "总库存明细2026-7-21.xlsx", role: "fact", purpose: "全公司库存覆盖核对", expectedTemplates: ["stock_summary"] },
  { filename: "各节点核心说明.xlsx", role: "configuration", purpose: "NPD 节点 + 角色", compositeTemplate: "npd" },
  { filename: "各节点核心说明_数据表.xlsx", role: "configuration", purpose: "NPD 节点基表", compositeTemplate: "npd" },
  { filename: "各节点核心说明_数据表_常规新品开发时间节点模拟.xlsx", role: "configuration", purpose: "NPD 时间模拟", compositeTemplate: "npd" },
  { filename: "供应链系统字段枚举.xlsx", role: "configuration", purpose: "业务枚举原始基线" },
  { filename: "供应链系统 PRD.pdf", role: "requirements", purpose: "产品需求" },
  { filename: "供应链系统功能清单（子文档）.pdf", role: "requirements", purpose: "功能范围" },
  { filename: "供应链系统数据字典.pdf", role: "requirements", purpose: "字段/实体原始定义" },
  { filename: "产品开发流程图.pdf", role: "requirements", purpose: "NPD 流程输入" },
  { filename: "AI view_ 【供应链系统推进计划讨论会】 on Jul 23, 2026.pdf", role: "requirements", purpose: "7/23 会议输入" },
  { filename: "智能纪要：【供应链系统讨论会议】 2026年7月24日.pdf", role: "requirements", purpose: "7/24 会议输入" },
];

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function md5(file: string): string {
  return createHash("md5").update(readFileSync(file)).digest("hex");
}

function scopeSourceHashes(scope: unknown): Set<string> {
  if (!scope || typeof scope !== "object") return new Set();
  const sources = (scope as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return new Set();
  return new Set(
    sources
      .map((item) => (item && typeof item === "object" ? (item as { md5?: unknown }).md5 : null))
      .filter((value): value is string => typeof value === "string"),
  );
}

async function rawRows(query: string): Promise<Record<string, unknown>[]> {
  const db = await getDbAsync();
  const result = await db.execute(sql.raw(query));
  return (result as unknown as { rows: Record<string, unknown>[] }).rows;
}

/** Aggregate identity controls only. Raw SKU codes and identifier values never enter the report. */
async function auditSkuIdentity(): Promise<Record<string, unknown>> {
  const skuRows = await rawRows(`
    select id, code, sku_type, barcode, barcode_status
      from skus
     order by id
  `);
  const identifierRows = await rawRows(`
    select id, sku_id, kind, value, scope, packaging_level, is_primary, active
      from sku_identifiers
     order by id
  `);

  let governed = 0;
  let invalidGoverned = 0;
  let governedTypeMismatch = 0;
  const governedSequences = new Map<number, number>();
  for (const row of skuRows) {
    const code = String(row.code ?? "");
    if (!isGovernedSkuCode(code)) continue;
    governed++;
    const parsed = parseGovernedSkuCode(code);
    if (!parsed) {
      invalidGoverned++;
      continue;
    }
    if (parsed.skuType !== row.sku_type) governedTypeMismatch++;
    governedSequences.set(parsed.sequence, (governedSequences.get(parsed.sequence) ?? 0) + 1);
  }

  const byKindAndState = new Map<string, number>();
  const exactKeys = new Map<string, number>();
  const canonicalExternalOwners = new Map<string, Set<number>>();
  const barcodeOwners = new Map<string, Set<number>>();
  const primaryEachGtinBySku = new Map<number, string>();
  let invalidGtins = 0;
  let badGtinScope = 0;
  let gtinMissingPackagingLevel = 0;
  for (const row of identifierRows) {
    const kind = String(row.kind ?? "");
    const value = String(row.value ?? "");
    const scope = String(row.scope ?? "");
    const skuId = Number(row.sku_id);
    const stateKey = `${kind}:${row.active === true ? "active" : "inactive"}`;
    byKindAndState.set(stateKey, (byKindAndState.get(stateKey) ?? 0) + 1);
    const exactKey = `${kind}\0${scope}\0${value}`;
    exactKeys.set(exactKey, (exactKeys.get(exactKey) ?? 0) + 1);
    if (kind === "external") {
      const canonicalKey = `${normalizeSkuIdentifierScope("external", scope)}\0${value}`;
      const owners = canonicalExternalOwners.get(canonicalKey) ?? new Set<number>();
      owners.add(skuId);
      canonicalExternalOwners.set(canonicalKey, owners);
    }
    if (kind === "gtin") {
      if (!isValidGtin(value)) invalidGtins++;
      if (scope !== "GS1") badGtinScope++;
      if (!row.packaging_level) gtinMissingPackagingLevel++;
      if (
        row.active === true
        && row.is_primary === true
        && row.packaging_level === "each"
      ) {
        primaryEachGtinBySku.set(skuId, value);
      }
    }
    if (kind === "gtin" || kind === "legacy") {
      const owners = barcodeOwners.get(value) ?? new Set<number>();
      owners.add(skuId);
      barcodeOwners.set(value, owners);
    }
  }

  let nonEmptyLegacyBarcodes = 0;
  let validLegacyGtinCandidates = 0;
  let primaryEachGtinMismatch = 0;
  let barcodeWithoutPrimaryEachGtin = 0;
  const barcodeStatus = new Map<string, number>();
  for (const row of skuRows) {
    const skuId = Number(row.id);
    const barcode = row.barcode == null ? null : String(row.barcode).trim();
    const primaryEach = primaryEachGtinBySku.get(skuId) ?? null;
    if (primaryEach != null && primaryEach !== barcode) primaryEachGtinMismatch++;
    if (!barcode) continue;
    nonEmptyLegacyBarcodes++;
    if (primaryEach == null) barcodeWithoutPrimaryEachGtin++;
    if (isValidGtin(barcode)) validLegacyGtinCandidates++;
    const status = String(row.barcode_status ?? "null");
    barcodeStatus.set(status, (barcodeStatus.get(status) ?? 0) + 1);
    const owners = barcodeOwners.get(barcode) ?? new Set<number>();
    owners.add(skuId);
    barcodeOwners.set(barcode, owners);
  }

  return {
    privacy: "aggregate-controls-no-raw-identifiers",
    skus: skuRows.length,
    governedS1: {
      rows: governed,
      invalidFormatOrChecksum: invalidGoverned,
      typeMismatch: governedTypeMismatch,
      duplicateGlobalSequences: [...governedSequences.values()].filter((count) => count > 1).length,
    },
    identifiers: {
      rows: identifierRows.length,
      byKindAndState: Object.fromEntries([...byKindAndState].sort()),
      exactDuplicateKeys: [...exactKeys.values()].filter((count) => count > 1).length,
      canonicalExternalCrossSkuConflicts: [...canonicalExternalOwners.values()]
        .filter((owners) => owners.size > 1).length,
      crossGtinLegacyOrBarcodeOwnershipConflicts: [...barcodeOwners.values()]
        .filter((owners) => owners.size > 1).length,
      invalidGtins,
      badGtinScope,
      gtinMissingPackagingLevel,
      primaryEachGtins: primaryEachGtinBySku.size,
      primaryEachGtinMismatch,
    },
    legacyBarcodeReview: {
      nonEmpty: nonEmptyLegacyBarcodes,
      validGtinCandidates: validLegacyGtinCandidates,
      malformedOrNonGtin: nonEmptyLegacyBarcodes - validLegacyGtinCandidates,
      withoutPrimaryEachGtin: barcodeWithoutPrimaryEachGtin,
      status: Object.fromEntries([...barcodeStatus].sort()),
    },
  };
}

async function main() {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const sourceRoot = path.resolve(arg("--source-root") ?? "/Users/yj/Desktop/SCM");
  const db = await getDbAsync();
  const jobs = await db
    .select({
      id: schema.importJobs.id,
      template: schema.importJobs.template,
      filename: schema.importJobs.filename,
      fileHash: schema.importJobs.fileHash,
      status: schema.importJobs.status,
      okRows: schema.importJobs.okRows,
      failRows: schema.importJobs.failRows,
      sourceAsOf: schema.importJobs.sourceAsOf,
      schemaVersion: schema.importJobs.schemaVersion,
      scope: schema.importJobs.scope,
      controlRows: schema.importJobs.controlRows,
      controlQty: schema.importJobs.controlQty,
      releaseManifest: schema.importJobs.releaseManifest,
      releasedAt: schema.importJobs.releasedAt,
      createdAt: schema.importJobs.createdAt,
    })
    .from(schema.importJobs)
    .orderBy(schema.importJobs.id);

  const sources = SOURCES.map((spec) => {
    const file = path.join(sourceRoot, spec.filename);
    if (!existsSync(file)) return { ...spec, exists: false, bytes: null, md5: null, links: [], covered: false };
    const hash = md5(file);
    const direct = jobs.filter(
      (job) => job.fileHash === hash && spec.expectedTemplates?.includes(job.template),
    );
    const composite = spec.compositeTemplate
      ? jobs.filter(
          (job) => job.template === spec.compositeTemplate && scopeSourceHashes(job.scope).has(hash),
        )
      : [];
    const links = [...direct, ...composite].map((job) => ({
      jobId: job.id,
      template: job.template,
      status: job.status,
      okRows: job.okRows,
    }));
    const expectedCount = spec.expectedTemplates?.length ?? (spec.compositeTemplate ? 1 : 0);
    const covered = expectedCount === 0
      ? true
      : spec.expectedTemplates
        ? spec.expectedTemplates.every((template) =>
            direct.some((job) => job.template === template && job.status === "done" && job.okRows > 0),
          )
        : composite.some((job) => job.status === "done" && job.okRows > 0);
    return { ...spec, exists: true, bytes: statSync(file).size, md5: hash, links, covered };
  });

  const statusCounts = Object.fromEntries(
    (await db
      .select({ status: schema.importJobs.status, count: sql<number>`count(*)::int` })
      .from(schema.importJobs)
      .groupBy(schema.importJobs.status))
      .map((row) => [row.status, row.count]),
  );
  const activeGroups = new Map<string, typeof jobs>();
  for (const job of jobs) {
    if (!job.fileHash || job.status === "superseded") continue;
    const key = `${job.template}\0${job.fileHash}`;
    const list = activeGroups.get(key) ?? [];
    list.push(job);
    activeGroups.set(key, list);
  }
  const duplicateActive = [...activeGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.map((job) => ({ id: job.id, template: job.template, status: job.status })));

  const staging = await db
    .select({
      targetTable: schema.stagingRows.targetTable,
      status: schema.stagingRows.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.stagingRows)
    .groupBy(schema.stagingRows.targetTable, schema.stagingRows.status)
    .orderBy(schema.stagingRows.targetTable, schema.stagingRows.status);
  const aliases = await db
    .select({
      aliasType: schema.aliasExceptions.aliasType,
      rawValue: schema.aliasExceptions.rawValue,
      status: schema.aliasExceptions.status,
    })
    .from(schema.aliasExceptions);

  const health = await getDataHealth({ page: 1, pageSize: 1 }, db);
  const duplicateCandidates = await getDuplicateCandidates({ page: 1, pageSize: 1 }, db);

  const report = {
    generatedAt: new Date().toISOString(),
    revisionScope: "current working tree + local PGlite .data/dev",
    sourceRoot,
    sourceSummary: {
      total: sources.length,
      existing: sources.filter((source) => source.exists).length,
      factOrConfigExpected: sources.filter(
        (source) => source.expectedTemplates || source.compositeTemplate,
      ).length,
      covered: sources.filter(
        (source) => (source.expectedTemplates || source.compositeTemplate) && source.covered,
      ).length,
    },
    sources,
    importJobs: {
      total: jobs.length,
      byStatus: statusCounts,
      doneWithZeroRows: jobs
        .filter((job) => job.status === "done" && job.okRows === 0)
        .map((job) => ({ id: job.id, template: job.template, filename: job.filename })),
      stuckValidating: jobs
        .filter((job) => job.status === "validating")
        .map((job) => ({ id: job.id, template: job.template, filename: job.filename })),
      duplicateActiveTemplateHash: duplicateActive,
      metadataCoverage: {
        eligibleDoneJobs: jobs.filter((job) => job.status === "done" && job.okRows > 0).length,
        sourceAsOf: jobs.filter((job) => job.status === "done" && job.okRows > 0 && job.sourceAsOf).length,
        nonDefaultSchemaVersion: jobs.filter(
          (job) => job.status === "done" && job.okRows > 0 && job.schemaVersion !== "staging-v1",
        ).length,
        scope: jobs.filter((job) => job.status === "done" && job.okRows > 0 && job.scope).length,
        controlRows: jobs.filter((job) => job.status === "done" && job.okRows > 0 && job.controlRows != null).length,
        controlQty: jobs.filter((job) => job.status === "done" && job.okRows > 0 && job.controlQty != null).length,
        releaseManifest: jobs.filter(
          (job) => job.status === "done" && job.okRows > 0 && job.releaseManifest,
        ).length,
        releasedAt: jobs.filter((job) => job.status === "done" && job.okRows > 0 && job.releasedAt).length,
      },
    },
    staging,
    aliasExceptions: {
      open: aliases.filter((row) => row.status === "open"),
      counts: Object.fromEntries(
        [...new Set(aliases.map((row) => `${row.aliasType}:${row.status}`))].map((key) => [
          key,
          aliases.filter((row) => `${row.aliasType}:${row.status}` === key).length,
        ]),
      ),
    },
    canonical: {
      skuIdentity: await auditSkuIdentity(),
      skuCompleteness: await rawRows(`
        select sku_type,
               count(*)::int as rows,
               count(brand_id)::int as with_brand,
               count(barcode)::int as with_barcode,
               count(shelf_life_days)::int as with_shelf_life
          from skus
         group by sku_type
         order by sku_type
      `),
      transitCoverage: await rawRows(`
        select kind,
               count(*)::int as rows,
               count(sku_id)::int as resolved_sku,
               count(*) filter (where material_code is not null)::int as material_rows,
               count(material_sku_id)::int as resolved_material,
               count(*) filter (where oem_raw is not null and oem_raw <> '/')::int as needs_supplier,
               count(supplier_id)::int as resolved_supplier,
               count(distinct source_job_id)::int as source_jobs
          from transit_refs
         group by kind
         order by kind
      `),
      inventoryProvenance: await rawRows(`
        select count(*)::int as snapshot_rows,
               count(import_job_id)::int as with_import_job,
               count(distinct biz_date)::int as biz_dates,
               min(biz_date) as first_date,
               max(biz_date) as last_date
          from stock_snapshots
      `),
      batchCoverage: await rawRows(`
        select count(*)::int as rows,
               count(distinct sku_id)::int as skus,
               count(distinct warehouse_id)::int as warehouses,
               count(batch_no)::int as with_batch_no,
               count(prod_date)::int as with_prod_date,
               count(expiry_date)::int as with_expiry_date,
               coalesce(sum(qty), 0) as qty
          from batch_stocks
      `),
      releaseTargets: await rawRows(`
        select
          (select count(*)::int from sales_monthly) as sales_monthly,
          (select count(*)::int from sku_params) as sku_params,
          (select count(*)::int from uom_convs where moq is not null and moq > 0) as sku_moq,
          (select count(*)::int from processing_fee_refs) as processing_fee_refs,
          (select count(*)::int from boms where status = 'active') as active_boms,
          (select count(*)::int from transit_refs) as transit_refs
      `),
      orphanAliases: await rawRows(`
        select alias_type, count(*)::int as rows
          from aliases a
         where (alias_type = 'sku_code' and not exists (select 1 from skus s where s.id = a.target_id))
            or (alias_type = 'sku_barcode' and not exists (select 1 from skus s where s.id = a.target_id))
            or (alias_type = 'warehouse' and not exists (select 1 from warehouses w where w.id = a.target_id))
            or (alias_type = 'supplier_oem' and not exists (select 1 from suppliers s where s.id = a.target_id))
            or (alias_type = 'brand' and not exists (select 1 from brands b where b.id = a.target_id))
            or (alias_type = 'channel' and not exists (select 1 from channels c where c.id = a.target_id))
         group by alias_type
         order by alias_type
      `),
    },
    masterDataHealth: {
      summary: health.summary,
      issueRows: health.total,
      structural: health.structural,
      duplicateCandidateClusters: duplicateCandidates.total,
      note: "疑似重复只进入人工裁决；版本/规格/渠道变体不得自动合并。",
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

void main();
