import { sql, type SQL } from "drizzle-orm";

/** Shared conservative horizon gate for channel and SKU views.
 * Within a saved snapshot, row_no resolves repeated business keys deterministically.
 * Deletions participate in that election before exclusion, so old rows cannot prove coverage.
 * This checks the observed cutoff, not complete daily/shop coverage or current freshness.
 */
export async function tmallStreamsCoverSameHorizon(
  db: { execute(query: SQL): Promise<unknown> },
  salesImportJobId: number,
  refundImportJobId: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    WITH versions AS (
      SELECT DISTINCT ON (import_job_id, payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10))
        import_job_id, target_table, payload
      FROM staging_rows
      WHERE status IN ('pending', 'validated', 'committed')
        AND import_job_id IN (${salesImportJobId}, ${refundImportJobId})
        AND left(payload->'data'->>'statisticalDate', 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ORDER BY import_job_id, payload->'data'->>'shopName', payload->'data'->>'skuId', left(payload->'data'->>'statisticalDate', 10), row_no DESC
    )
    SELECT
      max(left(payload->'data'->>'statisticalDate', 10)) FILTER (
        WHERE import_job_id = ${salesImportJobId} AND target_table = 'jdy_tmall_sku_sales_observation'
      ) AS sales_through,
      max(left(payload->'data'->>'statisticalDate', 10)) FILTER (
        WHERE import_job_id = ${refundImportJobId} AND target_table = 'jdy_tmall_sku_refund_observation'
      ) AS refunds_through
    FROM versions WHERE nullif(trim(payload->>'sourceDeletedAt'), '') IS NULL
  `);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] } | null)?.rows;
  const row = rows?.[0] as { sales_through?: string | null; refunds_through?: string | null } | undefined;
  return Boolean(row?.sales_through && row.refunds_through && row.refunds_through >= row.sales_through);
}
