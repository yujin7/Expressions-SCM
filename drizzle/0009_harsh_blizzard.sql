ALTER TYPE "public"."sku_type" ADD VALUE 'semi' BEFORE 'raw';--> statement-breakpoint
ALTER TYPE "public"."sku_type" ADD VALUE 'service';--> statement-breakpoint
ALTER TYPE "public"."supplier_status" ADD VALUE 'paused' BEFORE 'blacklisted';--> statement-breakpoint
ALTER TABLE "price_lists" DROP CONSTRAINT "uq_price_sku_sup_date";--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "channel_id" integer;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "barcode_status" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bank_account" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_term" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD COLUMN "incoming_loss_pct" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD COLUMN "production_loss_pct" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "boms" ADD COLUMN "bom_code" text;--> statement-breakpoint
ALTER TABLE "boms" ADD COLUMN "expiry_date" date;--> statement-breakpoint
ALTER TABLE "boms" ADD COLUMN "approved_by" integer;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "pkg_required_date" date;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "pkg_supplier_reply_date" date;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "pkg_ready_date" date;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "pkg_ref_nos" jsonb;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "urgent_flag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "is_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jg_docs" ADD COLUMN "revised_dates" jsonb;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD COLUMN "pkg_required_date" date;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD COLUMN "pkg_supplier_reply_date" date;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD COLUMN "pkg_ready_date" date;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD COLUMN "pkg_ref_nos" jsonb;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD COLUMN "urgent_flag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD COLUMN "is_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wo_docs" ADD COLUMN "revised_dates" jsonb;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "uq_price_sku_sup_chan_date" UNIQUE NULLS NOT DISTINCT("sku_id","supplier_id","channel_id","effective_date");