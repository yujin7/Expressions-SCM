CREATE TABLE "sku_identifiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"scope" text DEFAULT 'INTERNAL' NOT NULL,
	"uom" text,
	"packaging_level" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_sku_identifier_scope_value" UNIQUE("kind","scope","value"),
	CONSTRAINT "ck_sku_identifier_kind" CHECK ("sku_identifiers"."kind" IN ('gtin', 'external', 'vendor', 'customer', 'legacy')),
	CONSTRAINT "ck_sku_identifier_packaging_level" CHECK ("sku_identifiers"."packaging_level" IS NULL OR "sku_identifiers"."packaging_level" IN ('each', 'inner', 'case', 'pallet', 'other')),
	CONSTRAINT "ck_sku_identifier_scope" CHECK (length(trim("sku_identifiers"."scope")) > 0 AND ("sku_identifiers"."kind" <> 'gtin' OR "sku_identifiers"."scope" = 'GS1')),
	CONSTRAINT "ck_sku_identifier_gtin_level" CHECK ("sku_identifiers"."kind" <> 'gtin' OR "sku_identifiers"."packaging_level" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "sku_identifiers" ADD CONSTRAINT "sku_identifiers_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_identifiers" ADD CONSTRAINT "sku_identifiers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sku_identifier_primary_slot" ON "sku_identifiers" USING btree ("sku_id","kind","scope",coalesce("packaging_level", '')) WHERE "sku_identifiers"."active" = true AND "sku_identifiers"."is_primary" = true;--> statement-breakpoint
CREATE INDEX "ix_sku_identifier_sku_active" ON "sku_identifiers" USING btree ("sku_id","active");--> statement-breakpoint
-- 历史 barcode 数据含畸形与重复，不能冒充 GS1 GTIN。仅把归属唯一的非空值登记为
-- legacy 标识；重复值继续留在条码归属裁决队列，不由迁移猜测归属。
INSERT INTO "sku_identifiers" (
  "sku_id", "kind", "value", "scope", "uom", "packaging_level",
  "is_primary", "active", "note"
)
SELECT
  min("id"), 'legacy', trim("barcode"), 'LEGACY_BARCODE', min("base_uom"), 'each',
  false, true, '由 0038 迁移从旧 barcode 字段回填；待人工验证后可登记为 GTIN'
FROM "skus"
WHERE "barcode" IS NOT NULL AND trim("barcode") <> ''
GROUP BY trim("barcode")
HAVING count(*) = 1;
