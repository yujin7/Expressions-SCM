-- 已有外部标识可能在 0039 前使用 JUSHUITAN/JDY/YONSUITE 等同义 scope。
-- 先把跨 SKU 的同值冲突送入人工裁决队列；绝不由迁移猜测归属或自动合并主档。
WITH mapped AS (
  SELECT
    "sku_id",
    "value",
    CASE upper(trim("scope"))
      WHEN 'JST' THEN 'JST'
      WHEN 'JUSHUITAN' THEN 'JST'
      WHEN '聚水潭' THEN 'JST'
      WHEN 'JDY' THEN 'JIANDAOYUN'
      WHEN 'JIANDAOYUN' THEN 'JIANDAOYUN'
      WHEN '简道云' THEN 'JIANDAOYUN'
      WHEN 'YY' THEN 'YONYOU'
      WHEN 'YONYOU' THEN 'YONYOU'
      WHEN 'YONSUITE' THEN 'YONYOU'
      WHEN 'YONBIP' THEN 'YONYOU'
      WHEN '用友' THEN 'YONYOU'
    END AS "canonical_scope"
  FROM "sku_identifiers"
  WHERE "kind" = 'external'
)
INSERT INTO "alias_exceptions" ("alias_type", "raw_value", "context", "status")
SELECT
  'sku_code',
  "value",
  jsonb_build_object(
    'reason', 'sku_external_scope_conflict',
    'canonicalScope', "canonical_scope",
    'skuCount', count(DISTINCT "sku_id"),
    'migration', '0039'
  ),
  'open'
FROM mapped
WHERE "canonical_scope" IS NOT NULL
GROUP BY "value", "canonical_scope"
HAVING count(DISTINCT "sku_id") > 1
ON CONFLICT ("alias_type", "raw_value") DO NOTHING;
--> statement-breakpoint
-- 无归属冲突的同义 scope 组必须至少有一条 canonical 记录。若同一 SKU 已有多个同义行，
-- 只提升一条作为 canonical survivor，其他历史行保留，避免删除审计证据。
WITH mapped AS (
  SELECT
    "id",
    "sku_id",
    "value",
    "scope",
    CASE upper(trim("scope"))
      WHEN 'JST' THEN 'JST'
      WHEN 'JUSHUITAN' THEN 'JST'
      WHEN '聚水潭' THEN 'JST'
      WHEN 'JDY' THEN 'JIANDAOYUN'
      WHEN 'JIANDAOYUN' THEN 'JIANDAOYUN'
      WHEN '简道云' THEN 'JIANDAOYUN'
      WHEN 'YY' THEN 'YONYOU'
      WHEN 'YONYOU' THEN 'YONYOU'
      WHEN 'YONSUITE' THEN 'YONYOU'
      WHEN 'YONBIP' THEN 'YONYOU'
      WHEN '用友' THEN 'YONYOU'
    END AS "canonical_scope"
  FROM "sku_identifiers"
  WHERE "kind" = 'external'
),
safe_groups AS (
  SELECT "value", "canonical_scope"
  FROM mapped
  WHERE "canonical_scope" IS NOT NULL
  GROUP BY "value", "canonical_scope"
  HAVING count(DISTINCT "sku_id") = 1
),
survivors AS (
  SELECT
    coalesce(
      min(mapped."id") FILTER (WHERE upper(trim(mapped."scope")) = mapped."canonical_scope"),
      min(mapped."id")
    ) AS "id",
    mapped."canonical_scope"
  FROM mapped
  INNER JOIN safe_groups
    ON safe_groups."value" = mapped."value"
   AND safe_groups."canonical_scope" = mapped."canonical_scope"
  GROUP BY mapped."value", mapped."canonical_scope"
)
UPDATE "sku_identifiers"
SET
  "scope" = survivors."canonical_scope",
  "updated_at" = now()
FROM survivors
WHERE "sku_identifiers"."id" = survivors."id"
  AND "sku_identifiers"."scope" <> survivors."canonical_scope";
