/**
 * 现有参考层别名缺口的可恢复回填：
 * - 默认 dry-run：只列出真正未命中的 distinct 原值；
 * - --apply：只向 alias_exceptions 加入 open 复核项，不改主档、不写 aliases、不改正式事实行。
 *
 * 运行前停掉指向同一 PGlite 目录的 dev server，避免并发写目录。
 */
import { eq, sql } from "drizzle-orm";
import { getDbAsync } from "../src/db";
import * as schema from "../src/db/schema";
import {
  normalizeAliasText,
  queueException,
  resolveKnownReference,
  type DimDb,
} from "../src/server/modules/dimension/resolver";

type AliasType = schema.AliasType;

interface Evidence {
  aliasType: AliasType;
  rawValue: string;
  fields: Set<string>;
  kinds: Set<string>;
  rowIds: number[];
  occurrences: number;
}

interface RefRow {
  id: number;
  kind: string;
  skuCode: string | null;
  skuId: number | null;
  materialCode: string | null;
  materialSkuId: number | null;
  oemRaw: string | null;
  supplierId: number | null;
  brandRaw: string | null;
  follower: string | null;
  externalNo: string | null;
}

const PLACEHOLDERS = new Set(["", "/", "-", "—"]);

function add(
  map: Map<string, Evidence>,
  row: RefRow,
  aliasType: AliasType,
  field: string,
  raw: string | null,
): void {
  const value = normalizeAliasText(raw ?? "");
  if (PLACEHOLDERS.has(value)) return;
  const key = `${aliasType}\0${value}`;
  const evidence = map.get(key) ?? {
    aliasType,
    rawValue: value,
    fields: new Set<string>(),
    kinds: new Set<string>(),
    rowIds: [],
    occurrences: 0,
  };
  evidence.fields.add(field);
  evidence.kinds.add(row.kind);
  if (evidence.rowIds.length < 5) evidence.rowIds.push(row.id);
  evidence.occurrences++;
  map.set(key, evidence);
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= "pglite:.data/dev";
  const apply = process.argv.includes("--apply");
  const db = await getDbAsync();
  const refs: RefRow[] = await db
    .select({
      id: schema.transitRefs.id,
      kind: schema.transitRefs.kind,
      skuCode: schema.transitRefs.skuCode,
      skuId: schema.transitRefs.skuId,
      materialCode: schema.transitRefs.materialCode,
      materialSkuId: schema.transitRefs.materialSkuId,
      oemRaw: schema.transitRefs.oemRaw,
      supplierId: schema.transitRefs.supplierId,
      brandRaw: schema.transitRefs.brandRaw,
      follower: schema.transitRefs.follower,
      externalNo: schema.transitRefs.externalNo,
    })
    .from(schema.transitRefs);

  const evidence = new Map<string, Evidence>();
  const enrichmentEvidence = new Map<string, Evidence>();
  for (const row of refs) {
    if (row.skuCode) add(evidence, row, "sku_code", "sku", row.skuCode);
    if (row.materialCode && row.materialSkuId == null) {
      add(evidence, row, "sku_code", "materialSku", row.materialCode);
    }
    if (row.oemRaw) add(evidence, row, "supplier_oem", "supplier", row.oemRaw);
    if (row.brandRaw) add(evidence, row, "brand", "brand", row.brandRaw);
    if (row.kind === "demand" && row.follower) add(evidence, row, "channel", "channel", row.follower);
    if (row.kind === "stock_summary" && row.externalNo) {
      add(enrichmentEvidence, row, "sku_barcode", "barcode", row.externalNo);
    }
  }

  const unresolved: Evidence[] = [];
  const barcodeConflicts: Array<{
    barcode: string;
    sourceSkuId: number;
    masterSkuId: number;
    rowId: number;
  }> = [];
  const inspect = async (item: Evidence, queueCandidate: boolean) => {
    const targetId = await resolveKnownReference(
      db as unknown as DimDb,
      item.aliasType,
      item.rawValue,
    );
    if (targetId === null) {
      if (queueCandidate) unresolved.push(item);
      return { unresolved: true, targetId: null };
    }
    if (item.aliasType === "sku_barcode") {
      for (const rowId of item.rowIds) {
        const source = refs.find((row) => row.id === rowId);
        if (source?.skuId != null && source.skuId !== targetId) {
          barcodeConflicts.push({
            barcode: item.rawValue,
            sourceSkuId: source.skuId,
            masterSkuId: targetId,
            rowId,
          });
        }
      }
    }
    return { unresolved: false, targetId };
  };
  for (const item of evidence.values()) {
    await inspect(item, true);
  }
  const enrichmentUnresolved: Evidence[] = [];
  for (const item of enrichmentEvidence.values()) {
    const result = await inspect(item, false);
    if (result.unresolved) enrichmentUnresolved.push(item);
  }

  unresolved.sort((a, b) =>
    a.aliasType.localeCompare(b.aliasType) || b.occurrences - a.occurrences || a.rawValue.localeCompare(b.rawValue),
  );
  const byType = Object.fromEntries(
    [...new Set(unresolved.map((row) => row.aliasType))].map((type) => [
      type,
      {
        distinct: unresolved.filter((row) => row.aliasType === type).length,
        occurrences: unresolved
          .filter((row) => row.aliasType === type)
          .reduce((sum, row) => sum + row.occurrences, 0),
      },
    ]),
  );

  const [{ before }] = await db
    .select({ before: sql<number>`count(*)::int` })
    .from(schema.aliasExceptions)
    .where(eq(schema.aliasExceptions.status, "open"));

  if (apply) {
    for (const item of unresolved) {
      await queueException(db as unknown as DimDb, item.aliasType, item.rawValue, {
        source: "transit_refs_backfill",
        fields: [...item.fields],
        kinds: [...item.kinds],
        sampleRowIds: item.rowIds,
        occurrences: item.occurrences,
      });
    }
  }

  const [{ after }] = await db
    .select({ after: sql<number>`count(*)::int` })
    .from(schema.aliasExceptions)
    .where(eq(schema.aliasExceptions.status, "open"));

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    target: "transit_refs unresolved reference evidence -> alias_exceptions(open)",
    scannedRows: refs.length,
    distinctEvidence: evidence.size,
    unresolvedDistinct: unresolved.length,
    unresolvedByType: byType,
    enrichmentGapsNotQueued: {
      rationale:
        "source barcode is measured separately until a dedicated barcode-ownership workflow is available",
      byType: Object.fromEntries(
        [...new Set(enrichmentUnresolved.map((row) => row.aliasType))].map((type) => [
          type,
          {
            distinct: enrichmentUnresolved.filter((row) => row.aliasType === type).length,
            occurrences: enrichmentUnresolved
              .filter((row) => row.aliasType === type)
              .reduce((sum, row) => sum + row.occurrences, 0),
          },
        ]),
      ),
    },
    openExceptionsBefore: before,
    openExceptionsAfter: after,
    inserted: after - before,
    barcodeConflicts,
    candidates: unresolved.map((row) => ({
      aliasType: row.aliasType,
      rawValue: row.rawValue,
      fields: [...row.fields],
      kinds: [...row.kinds],
      sampleRowIds: row.rowIds,
      occurrences: row.occurrences,
    })),
    recovery:
      "No canonical or reference rows were changed. Newly queued items can be resolved or marked ignored in the alias review workbench.",
  }, null, 2));
}

void main();
