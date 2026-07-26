CREATE TYPE "public"."sku_lifecycle" AS ENUM('on_sale', 'trial', 'halted', 'retired');--> statement-breakpoint
CREATE TABLE "batch_stocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"batch_no" text,
	"prod_date" date,
	"expiry_date" date,
	"qty" numeric(14, 4) NOT NULL,
	"stocktake_date" date NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_doc_refs" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" integer,
	"system" text NOT NULL,
	"ref_no" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ext_system_ref" UNIQUE("system","ref_no")
);
--> statement-breakpoint
CREATE TABLE "processing_fee_refs" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"fee_rate" numeric(14, 2),
	"effective_date" date NOT NULL,
	"source" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_fee_sku_sup_date" UNIQUE("sku_id","supplier_id","effective_date")
);
--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "lifecycle" "sku_lifecycle" DEFAULT 'on_sale' NOT NULL;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "order_type" text;--> statement-breakpoint
ALTER TABLE "stock_docs" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD COLUMN "order_type" text;--> statement-breakpoint
ALTER TABLE "batch_stocks" ADD CONSTRAINT "batch_stocks_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_stocks" ADD CONSTRAINT "batch_stocks_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_fee_refs" ADD CONSTRAINT "processing_fee_refs_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_fee_refs" ADD CONSTRAINT "processing_fee_refs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_batch_stocks_sku_wh" ON "batch_stocks" USING btree ("sku_id","warehouse_id");