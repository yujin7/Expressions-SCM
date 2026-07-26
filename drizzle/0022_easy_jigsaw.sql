ALTER TABLE "transit_refs" ADD COLUMN "material_sku_id" integer;--> statement-breakpoint
UPDATE "transit_refs" AS t
SET "material_sku_id" = s."id"
FROM "skus" AS s
WHERE t."material_code" IS NOT NULL
  AND s."code" = t."material_code";--> statement-breakpoint
UPDATE "transit_refs" AS t
SET "material_sku_id" = s."id"
FROM "skus" AS s
WHERE t."material_code" IS NOT NULL
  AND t."material_sku_id" IS NULL
  AND s."code" = translate(t."material_code", '（）', '()');--> statement-breakpoint
UPDATE "transit_refs" AS t
SET "material_sku_id" = a."target_id"
FROM "aliases" AS a
WHERE t."material_code" IS NOT NULL
  AND a."alias_type" = 'sku_code'
  AND a."raw_value" = t."material_code"
  AND a."target_id" IS NOT NULL;--> statement-breakpoint
UPDATE "transit_refs" AS t
SET "material_sku_id" = a."target_id"
FROM "aliases" AS a
WHERE t."material_code" IS NOT NULL
  AND a."alias_type" = 'sku_code'
  AND a."raw_value" = translate(t."material_code", '（）', '()')
  AND a."target_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "transit_refs" ADD CONSTRAINT "transit_refs_material_sku_id_skus_id_fk" FOREIGN KEY ("material_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_transit_material_sku" ON "transit_refs" USING btree ("material_sku_id");
